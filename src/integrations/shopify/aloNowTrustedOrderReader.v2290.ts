// V2290: Trusted server-side Shopify read. NO fulfillment writes.
// The live transport is NOT invoked unless a server-side caller invokes this function.
import axios from 'axios';
// Import credentials only when the real server transport is called.
// Tests of the injected transport must not require production environment variables.

export type TrustedOrderV2290 = {
  id: string;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalOutstandingSet: { shopMoney: { amount: string; currencyCode: string } };
};

type TransportV2290 = (query: string, variables: { id: string }) => Promise<unknown>;
const SHOPIFY_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const GRAPHQL_ORDER_QUERY_V2290 = `
query AloNowTrustedOrderV2290($id: ID!) {
  order(id: $id) {
    id
    cancelledAt
    displayFinancialStatus
    totalPriceSet { shopMoney { amount currencyCode } }
    totalOutstandingSet { shopMoney { amount currencyCode } }
  }
}`;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function money(value: unknown): { shopMoney: { amount: string; currencyCode: string } } | null {
  const parent = record(value);
  const shopMoney = record(parent?.shopMoney);
  if (!shopMoney || typeof shopMoney.amount !== 'string' ||
      typeof shopMoney.currencyCode !== 'string' ||
      !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(shopMoney.amount) ||
      !/^[A-Z]{3}$/.test(shopMoney.currencyCode)) return null;
  return { shopMoney: { amount: shopMoney.amount, currencyCode: shopMoney.currencyCode } };
}

export function makeTrustedOrderReaderV2290(transport: TransportV2290) {
  return async (shopifyOrderId: string): Promise<TrustedOrderV2290 | null> => {
    if (!SHOPIFY_GID.test(shopifyOrderId)) throw new Error('INVALID_SHOPIFY_ORDER_ID');
    const envelope = record(await transport(GRAPHQL_ORDER_QUERY_V2290, { id: shopifyOrderId }));
    if (!envelope || (Array.isArray(envelope.errors) && envelope.errors.length > 0))
      throw new Error('SHOPIFY_ORDER_GRAPHQL_FAILURE');
    const data = record(envelope.data);
    if (!data) throw new Error('SHOPIFY_ORDER_RESPONSE_INVALID');
    if (data.order === null) return null;
    const order = record(data.order);
    const totalPriceSet = money(order?.totalPriceSet);
    const totalOutstandingSet = money(order?.totalOutstandingSet);
    if (!order || order.id !== shopifyOrderId ||
      typeof order.displayFinancialStatus !== 'string' ||
      !(typeof order.cancelledAt === 'string' || order.cancelledAt === null) ||
      !totalPriceSet || !totalOutstandingSet ||
      totalPriceSet.shopMoney.currencyCode !== totalOutstandingSet.shopMoney.currencyCode)
      throw new Error('SHOPIFY_ORDER_EVIDENCE_INVALID');
    return {
      id: shopifyOrderId,
      cancelledAt: order.cancelledAt,
      displayFinancialStatus: order.displayFinancialStatus,
      totalPriceSet,
      totalOutstandingSet,
    };
  };
}

// Production transport: uses existing shop credentials; does NOT create fulfillments.
// It is intentionally not mounted to an API route in V2290.
export const shopifyOrderReadTransportV2290: TransportV2290 = async (query, variables) => {
  const { env } = await import('../../config/env.js');
  const { getShopifyAccessToken } = await import('./auth.js');
  const rawShop = String(env.shopify.shop ?? '').trim();
  const shopName = rawShop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com\/?$/, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(shopName)) throw new Error('INVALID_SHOPIFY_SHOP_DOMAIN');
  const token = await getShopifyAccessToken();
  if (!token) throw new Error('SHOPIFY_ACCESS_TOKEN_MISSING');
  const response = await axios.post(
    `https://${shopName}.myshopify.com/admin/api/${env.shopify.apiVersion}/graphql.json`,
    { query, variables },
    {
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      timeout: 15000,
      validateStatus: () => true,
    },
  );
  if (response.status !== 200) throw new Error('SHOPIFY_ORDER_HTTP_FAILURE');
  return response.data as unknown;
};
export const readTrustedShopifyOrderV2290 = makeTrustedOrderReaderV2290(shopifyOrderReadTransportV2290);


// V2452: Read an existing Shopify DraftOrder.
// Never creates or modifies a DraftOrder.
const DRAFT_GID_V2452 =
  /^gid:\/\/shopify\/DraftOrder\/[1-9][0-9]*$/;

const DRAFT_QUERY_V2452 = `
query AloNowExistingDraftInvoiceV2452($id: ID!) {
  draftOrder(id: $id) {
    id
    invoiceUrl
    totalPriceSet {
      shopMoney { amount currencyCode }
    }
  }
}`;

export function makeTrustedDraftInvoiceReaderV2452(
  transport: (query: string, variables: {id: string}) => Promise<unknown>
) {
  return async (draftId: string, expectedCHF: string) => {
    if (!DRAFT_GID_V2452.test(draftId))
      throw new Error("INVALID_DRAFT_ID");

    if (!/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(expectedCHF))
      throw new Error("INVALID_EXPECTED_TOTAL");

    const envelope = record(
      await transport(DRAFT_QUERY_V2452, {id: draftId})
    );

    if (!envelope ||
        (Array.isArray(envelope.errors) && envelope.errors.length > 0))
      throw new Error("DRAFT_READ_FAILED");

    const data = record(envelope.data);
    const draft = record(data?.draftOrder);

    if (!draft || draft.id !== draftId)
      throw new Error("DRAFT_ID_MISMATCH");

    const total = money(draft.totalPriceSet)?.shopMoney;
    if (!total || total.currencyCode !== "CHF" ||
        !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(total.amount) ||
        Math.round(Number(total.amount)*100) !==
        Math.round(Number(expectedCHF)*100))
      throw new Error("DRAFT_TOTAL_MISMATCH");

    if (typeof draft.invoiceUrl !== "string" ||
        draft.invoiceUrl.length > 2048)
      throw new Error("DRAFT_INVOICE_UNAVAILABLE");

    let url: URL;
    try {
      url = new URL(draft.invoiceUrl);
    } catch {
      throw new Error("DRAFT_INVOICE_INVALID");
    }

    if (url.protocol !== "https:" ||
        !url.hostname ||
        url.username || url.password)
      throw new Error("DRAFT_INVOICE_INVALID");

    return {
      draftOrderId: draftId,
      invoiceUrl: url.href,
      totalCHF: expectedCHF
    };
  };
}

export const readLiveDraftInvoiceV2452 =
  makeTrustedDraftInvoiceReaderV2452(
    shopifyOrderReadTransportV2290
  );
