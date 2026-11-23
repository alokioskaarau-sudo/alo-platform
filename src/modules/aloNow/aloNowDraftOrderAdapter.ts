/**
 * ALO NOW – offline-only Shopify Draft Order adapter.
 * Builds a request and parses a response. Never calls Shopify.
 * Do not retry uncertain draftOrderCreate results automatically.
 */
import {
  validateAloNowDeliveryContact
} from "./aloNowDeliveryContact.js";

export const ALO_NOW_DRAFT_CREATE_MUTATION = `
  mutation AloNowCreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
      userErrors { field message }
    }
  }
`;

type DraftInput = {
  presentmentCurrencyCode: "CHF";
  lineItems: Array<{variantId:string;quantity:number}>;
  shippingLine: {
    title:string;
    priceWithCurrency:{amount:string;currencyCode:"CHF"};
  };
  customAttributes:Array<{key:string;value:string}>;
  tags:string[];
  email?: string;
  phone?: string;
  shippingAddress?: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    zip: string;
    city: string;
    countryCode: "CH";
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIANT = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
const DRAFT = /^gid:\/\/shopify\/DraftOrder\/[1-9][0-9]*$/;

function obj(x:unknown):Record<string,unknown>|null {
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? x as Record<string,unknown> : null;
}
function money(x:unknown):bigint|null {
  if(typeof x !== "string" ||
     !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(x))
    return null;
  const [francs,decimal=""] = x.split(".");
  return BigInt(francs)*100n + BigInt(decimal.padEnd(2,"0"));
}

export function buildAloNowDraftGraphqlRequest(input:DraftInput) {
  if(input.presentmentCurrencyCode !== "CHF" ||
     input.shippingLine?.priceWithCurrency?.currencyCode !== "CHF" ||
     money(input.shippingLine.priceWithCurrency.amount) === null)
    throw new Error("INVALID_DRAFT_CURRENCY");

  if(!Array.isArray(input.lineItems) ||
     input.lineItems.length < 1 || input.lineItems.length > 15)
    throw new Error("INVALID_DRAFT_ITEMS");

  const used = new Set<string>();
  for(const line of input.lineItems) {
    if(!VARIANT.test(line.variantId) ||
       !Number.isInteger(line.quantity) ||
       line.quantity < 1 || line.quantity > 30 ||
       used.has(line.variantId))
      throw new Error("INVALID_DRAFT_ITEMS");
    used.add(line.variantId);
  }

  const attributes=input.customAttributes;
  if(!Array.isArray(attributes) || attributes.length !== 2 ||
     attributes.some(a => !a || typeof a.key !== "string" ||
       typeof a.value !== "string"))
    throw new Error("INVALID_DRAFT_IDENTITY");

  const keys=new Map(attributes.map(a=>[a.key,a.value]));
  if(keys.size !== 2 ||
     !UUID.test(keys.get("alo_now_request_id") ?? "") ||
     !UUID.test(keys.get("alo_now_checkout_reference") ?? ""))
    throw new Error("INVALID_DRAFT_IDENTITY");

  // Legacy offline simulations may omit the contact.
  // If ANY shipping contact data exists, require a
  // complete and validated Swiss delivery identity.
  const hasContact =
    input.shippingAddress !== undefined ||
    input.email !== undefined ||
    input.phone !== undefined;

  let preparedInput = input;

  if (hasContact) {
    const address = input.shippingAddress;

    if (!address ||
        typeof input.email !== "string" ||
        typeof input.phone !== "string") {
      throw new Error("INCOMPLETE_DRAFT_CONTACT");
    }

    let contact;
    try {
      contact = validateAloNowDeliveryContact({
        ...address,
        email: input.email,
        phone: input.phone
      });
    } catch {
      throw new Error("INVALID_DRAFT_CONTACT");
    }

    preparedInput = {
      ...input,
      email: contact.email,
      phone: contact.phone,
      shippingAddress: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        address1: contact.address1,
        address2: contact.address2,
        zip: contact.zip,
        city: contact.city,
        countryCode: contact.countryCode
      }
    };
  }

  return {
    query:ALO_NOW_DRAFT_CREATE_MUTATION,
    variables:{
      input:{
        ...preparedInput,
        acceptAutomaticDiscounts:false,
        allowDiscountCodesInCheckout:false
      }
    }
  };
}

export type DraftResponse =
  | {ok:true;draftOrderId:string;invoiceUrl:string|null;totalCHF:string}
  | {ok:false;reason:string};

export function parseAloNowDraftCreateResponse(
  response:unknown,
  expectedTotalCHF:string
):DraftResponse {
  const root=obj(response);
  if(!root)
    return {ok:false,reason:"SHOPIFY_RESPONSE_INVALID"};
  if(Array.isArray(root.errors) && root.errors.length)
    return {ok:false,reason:"SHOPIFY_GRAPHQL_ERRORS"};

  const data=obj(root.data) ?? root;
  const result=obj(data.draftOrderCreate);
  if(!result)
    return {ok:false,reason:"DRAFT_RESULT_MISSING"};
  if(!Array.isArray(result.userErrors))
    return {ok:false,reason:"DRAFT_ERRORS_UNKNOWN"};
  if(result.userErrors.length)
    return {ok:false,reason:"DRAFT_USER_ERRORS"};

  const draft=obj(result.draftOrder);
  if(!draft || typeof draft.id !== "string" || !DRAFT.test(draft.id))
    return {ok:false,reason:"DRAFT_ID_INVALID"};

  const total=obj(obj(draft.totalPriceSet)?.shopMoney);
  if(!total || total.currencyCode !== "CHF")
    return {ok:false,reason:"DRAFT_CURRENCY_MISMATCH"};

  const actual=money(total.amount);
  const expected=money(expectedTotalCHF);
  if(actual === null || expected === null || actual !== expected)
    return {ok:false,reason:"DRAFT_TOTAL_MISMATCH"};

  if(draft.invoiceUrl !== null &&
     typeof draft.invoiceUrl !== "string")
    return {ok:false,reason:"DRAFT_URL_INVALID"};
  if(typeof draft.invoiceUrl === "string" &&
     (!draft.invoiceUrl.startsWith("https://") ||
       draft.invoiceUrl.length > 2048))
    return {ok:false,reason:"DRAFT_URL_INVALID"};

  return {
    ok:true,
    draftOrderId:draft.id,
    invoiceUrl:draft.invoiceUrl,
    totalCHF:expectedTotalCHF
  };
}
