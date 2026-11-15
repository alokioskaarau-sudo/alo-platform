/**
 * ALO NOW V170B
 *
 * Pure Shopify Draft Order request builder.
 * No network access, invoice sending, database access,
 * payment capture or wallet credit.
 *
 * Callers must establish delivery authorization,
 * customer identity and tax treatment independently.
 *
 * Metadata is not proof of payment or tip purpose.
 */

export type TipCheckoutInputV170 = {
  requestId: string;
  originalOrderId: string;
  checkoutReference: string;
  amountRappen: number;
  taxable: boolean;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ORDER_PREFIX = "gid://shopify/Order/";

export function isShopifyOrderIdV170(
  value: unknown
): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith(ORDER_PREFIX)
  ) return false;

  const number = value.slice(ORDER_PREFIX.length);

  return /^[1-9][0-9]*$/.test(number);
}

export function buildTipCheckoutV170(
  input: TipCheckoutInputV170
) {
  if (
    !UUID.test(input.requestId) ||
    !UUID.test(input.checkoutReference)
  ) {
    throw new Error("TIP_CHECKOUT_IDENTITY_INVALID");
  }

  if (!isShopifyOrderIdV170(input.originalOrderId)) {
    throw new Error("TIP_ORIGINAL_ORDER_INVALID");
  }

  if (
    !Number.isSafeInteger(input.amountRappen) ||
    input.amountRappen < 100 ||
    input.amountRappen > 50000
  ) {
    throw new Error("TIP_AMOUNT_INVALID");
  }

  if (typeof input.taxable !== "boolean") {
    throw new Error("TIP_TAX_POLICY_REQUIRED");
  }

  const francs = Math.floor(input.amountRappen / 100);
  const cents = String(input.amountRappen % 100)
    .padStart(2, "0");

  const amount = `${francs}.${cents}`;

  const query = `
    mutation AloNowCreateTipDraftV170(
      $input: DraftOrderInput!
    ) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
          customAttributes {
            key
            value
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  return {
    query,
    variables: {
      input: {
        presentmentCurrencyCode: "CHF",
        lineItems: [{
          title: "ALO NOW - Freiwilliges Fahrer-Trinkgeld",
          quantity: 1,
          originalUnitPriceWithCurrency: {
            amount,
            currencyCode: "CHF"
          },
          requiresShipping: false,
          taxable: input.taxable
        }],
        customAttributes: [
          {
            key: "alo_now_tip_purpose",
            value: "POST_DELIVERY_TIP"
          },
          {
            key: "alo_now_request_id",
            value: input.requestId
          },
          {
            key: "alo_now_original_order_id",
            value: input.originalOrderId
          },
          {
            key: "alo_now_tip_checkout_reference",
            value: input.checkoutReference
          }
        ],
        tags: [
          "ALO_NOW_TIP",
          "ALO_POST_DELIVERY"
        ],
        acceptAutomaticDiscounts: false,
        allowDiscountCodesInCheckout: false
      }
    },
    expectedAmountCHF: amount,
    purpose: "POST_DELIVERY_TIP" as const,
    originalOrderId: input.originalOrderId,
    checkoutReference: input.checkoutReference,
    networkExecuted: false as const,
    walletAuthorized: false as const
  };
}
