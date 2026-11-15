import axios from "axios";
import { env } from "../../config/env.js";
import { getShopifyAccessToken } from "./auth.js";

function getShopDomain(): string {
  const shop = env.shopify.shop
    .replace(/^https?:\/\//, "")
    .replace(/\.myshopify\.com$/, "")
    .replace(/\/$/, "");

  return `${shop}.myshopify.com`;
}


// ============================================================
// SHOPIFY ORDER FIELDS
// ============================================================

const ORDER_FIELDS = `
  id
  name
  createdAt
  displayFinancialStatus
  displayFulfillmentStatus
  cancelledAt
  closedAt
  email

  subtotalPriceSet {
    shopMoney {
      amount
      currencyCode
    }
  }

  totalDiscountsSet {
    shopMoney {
      amount
      currencyCode
    }
  }

  totalShippingPriceSet {
    shopMoney {
      amount
      currencyCode
    }
  }

  totalTaxSet {
    shopMoney {
      amount
      currencyCode
    }
  }

  totalPriceSet {
    shopMoney {
      amount
      currencyCode
    }
  }

  billingAddress {
    firstName
    lastName
    company
    address1
    address2
    zip
    city
    province
    provinceCode
    country
    countryCodeV2
    phone
  }

  shippingAddress {
    firstName
    lastName
    company
    address1
    address2
    zip
    city
    province
    provinceCode
    country
    countryCodeV2
    phone
  }

  fulfillmentOrders(first: 20) {
    edges {
      node {
        id
        status

        lineItems(first: 100) {
          nodes {
            totalQuantity
            remainingQuantity
          }
        }

        deliveryMethod {
          methodType
          presentedName
        }
      }
    }
  }

  lineItems(first: 50) {
    edges {
      node {
        id
        name
        quantity
        sku

        originalUnitPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }

        discountedUnitPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }

        totalDiscountSet {
          shopMoney {
            amount
            currencyCode
          }
        }

        weight {
          value
          unit
        }

        variant {
          id
          title
          image {
            url
            altText
          }
          product {
            id
            title
            ageRequirement: metafield(
              namespace: "alo"
              key: "age_requirement"
            ) {
              value
            }
            featuredImage {
              url
              altText
            }
          }
          inventoryItem {
            id
          }
        }
      }
    }
  }
`;


// ============================================================
// SHOPIFY GRAPHQL
// ============================================================

async function shopifyGraphQL(
  query: string,
  variables: Record<string, unknown>
) {
  const token =
    await getShopifyAccessToken();

  const shopDomain =
    getShopDomain();

  const response =
    await axios.post(
      `https://${shopDomain}/admin/api/${env.shopify.apiVersion}/graphql.json`,
      {
        query,
        variables,
      },
      {
        headers: {
          "Content-Type":
            "application/json",

          "X-Shopify-Access-Token":
            token,
        },

        timeout: 15000,

        validateStatus:
          () => true,
      }
    );

  if (response.status >= 400) {
    console.error(
      "Shopify HTTP Error:",
      response.status
    );

    throw new Error(
      `Shopify request failed (${response.status})`
    );
  }

  if (response.data?.errors) {
    console.error(
      "Shopify GraphQL Errors:",
      JSON.stringify(
        response.data.errors,
        null,
        2
      )
    );

    throw new Error(
      "Shopify GraphQL request failed"
    );
  }

  return response.data?.data;
}


// ============================================================
// LETZTE SHOPIFY BESTELLUNGEN
// ============================================================

export async function getLatestShopifyOrders(
  limit = 5
) {
  const query = `
    query GetLatestOrders(
      $first: Int!
    ) {
      orders(
        first: $first
        reverse: true
        sortKey: CREATED_AT
      ) {
        edges {
          node {
            ${ORDER_FIELDS}
          }
        }
      }
    }
  `;

  const data =
    await shopifyGraphQL(
      query,
      {
        first: limit,
      }
    );

  return (
    data?.orders?.edges ?? []
  ).map(
    (edge: any) =>
      edge.node
  );
}



// ============================================================
// SHOPIFY BESTELLUNGEN NACH IDS
//
// Staff-Bestellmanager:
// Lädt den aktuellen Shopify-Status mehrerer bereits bekannter
// Orders in EINEM GraphQL-Request.
//
// Bewusst schlanke Felder:
// Die Listenansicht braucht keine Adressen, Positionen oder
// Fulfillment-Details. Dadurch bleibt der Sync schnell.
// ============================================================

export type ShopifyOrderStatusSnapshot = {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  cancelledAt: string | null;
  closedAt: string | null;
  fulfillmentOrders: {
    nodes: Array<{
      id: string;
      status: string;
      lineItems: {
        nodes: Array<{
          totalQuantity: number;
          remainingQuantity: number;
        }>;
      };
    }>;
  };
};

export async function getShopifyOrdersByIds(
  orderIds: string[]
): Promise<ShopifyOrderStatusSnapshot[]> {

  const ids = [
    ...new Set(
      orderIds
        .map((id) => String(id || "").trim())
        .filter(Boolean)
        .map((id) =>
          id.startsWith("gid://shopify/Order/")
            ? id
            : `gid://shopify/Order/${id}`
        )
    ),
  ];

  if (ids.length === 0) {
    return [];
  }

  /*
   * Shopify GraphQL unterstützt nodes(ids: ...).
   *
   * Wir teilen bewusst in kleine Batches auf:
   * - robuste Request-Größe
   * - kein N+1 pro Bestellung
   * - Staff-Liste kann trotzdem hunderte Orders enthalten
   */
  const BATCH_SIZE = 50;

  const orders: ShopifyOrderStatusSnapshot[] = [];

  for (
    let offset = 0;
    offset < ids.length;
    offset += BATCH_SIZE
  ) {
    const batch = ids.slice(
      offset,
      offset + BATCH_SIZE
    );

    const query = `
      query GetOrdersByIds(
        $ids: [ID!]!
      ) {
        nodes(ids: $ids) {
          ... on Order {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            cancelledAt
            closedAt
            fulfillmentOrders(first: 50) {
              nodes {
                id
                status
                lineItems(first: 100) {
                  nodes {
                    totalQuantity
                    remainingQuantity
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data =
      await shopifyGraphQL(
        query,
        {
          ids: batch,
        }
      );

    for (const node of data?.nodes ?? []) {
      if (!node?.id) {
        continue;
      }

      orders.push(
        node as ShopifyOrderStatusSnapshot
      );
    }
  }

  return orders;
}


// ============================================================
// SHOPIFY BESTELLUNG NACH ID
// ============================================================

export async function getShopifyOrderById(
  orderId: string
) {
  const normalizedId =
    orderId.startsWith(
      "gid://shopify/Order/"
    )
      ? orderId
      : `gid://shopify/Order/${orderId}`;

  const query = `
    query GetOrder(
      $id: ID!
    ) {
      order(id: $id) {
        ${ORDER_FIELDS}
      }
    }
  `;

  const data =
    await shopifyGraphQL(
      query,
      {
        id: normalizedId,
      }
    );

  return data?.order ?? null;
}


export async function readAloNowShopifyPaymentGraphQL(
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const id = variables?.id;

  if (
    typeof id !== "string" ||
    !/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(id)
  ) {
    throw new Error("ALO_NOW_INVALID_SHOPIFY_ORDER");
  }

  const allowed = /^\s*query\s+AloNowReadPaymentEvidence\(\$id:\s*ID!\)\s*\{\s*node\(id:\s*\$id\)\s*\{\s*\.\.\.\s+on\s+Order\s*\{\s*id\s+displayFinancialStatus\s+cancelledAt\s+totalPriceSet\s*\{\s*shopMoney\s*\{\s*amount\s+currencyCode\s*\}\s*\}\s*totalOutstandingSet\s*\{\s*shopMoney\s*\{\s*amount\s+currencyCode\s*\}\s*\}\s*\}\s*\}\s*\}\s*$/;

  if (!allowed.test(query) ||
      Object.keys(variables).length !== 1) {
    throw new Error("ALO_NOW_PAYMENT_QUERY_NOT_ALLOWED");
  }

  return shopifyGraphQL(query, { id });
}


export async function readAloNowShopifyProvenanceGraphQL(
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const id = variables?.id;

  if (
    typeof id !== "string" ||
    !/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(id)
  ) {
    throw new Error("ALO_NOW_INVALID_SHOPIFY_ORDER");
  }

  if (
    Object.keys(variables).length !== 1 ||
    query.replace(/\s+/g, "") !==
      ALO_NOW_ALLOWED_PROVENANCE_QUERY.replace(/\s+/g, "")
  ) {
    throw new Error("ALO_NOW_PROVENANCE_QUERY_NOT_ALLOWED");
  }

  return shopifyGraphQL(
    ALO_NOW_ALLOWED_PROVENANCE_QUERY,
    { id }
  );
}


const ALO_NOW_ALLOWED_PROVENANCE_QUERY = `
  query AloNowReadOrderProvenance($id: ID!) {
    node(id: $id) {
      ... on Order {
        id
        customAttributes {
          key
          value
        }
      }
    }
  }
`;

// ALO NOW V169 - read-only Shopify tip-order payment evidence.
// Uses the existing authenticated Shopify Admin GraphQL client.
// A paid order alone does NOT authorize a driver-wallet credit.
export async function getAloNowTipOrderTransactionsV169(
  orderId: string
): Promise<unknown> {
  if (!/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(orderId)) {
    throw new Error("INVALID_SHOPIFY_TIP_ORDER_ID");
  }

  const query = `
    query AloNowTipOrderTransactionsV169($id: ID!) {
      order(id: $id) {
        id
        test
        cancelledAt
        displayFinancialStatus
        totalPriceSet {
          shopMoney { amount currencyCode }
        }
        totalReceivedSet {
          shopMoney { amount currencyCode }
        }
        totalRefundedSet {
          shopMoney { amount currencyCode }
        }
        transactions {
          id
          kind
          status
          manualPaymentGateway
          amountSet {
            shopMoney { amount currencyCode }
          }
        }
      }
    }
  `;

  const response = await shopifyGraphQL(query, {
    id: orderId
  });

  return response?.order ?? null;
}

/**
 * ALO NOW V184
 *
 * Read-only Shopify Admin GraphQL capability probe.
 * Reuses existing authenticated Shopify GraphQL client.
 *
 * No mutation, draft creation, invoice sending or
 * payment operation.
 *
 * Returns only field names and permission booleans.
 * Never returns Shopify credentials or customer data.
 */
export async function probeAloNowTipShopifyV184() {
  const query = `
    query AloNowTipCapabilitiesV184 {
      currentAppInstallation {
        accessScopes {
          handle
        }
      }
      draftInput: __type(name: "DraftOrderInput") {
        inputFields { name }
      }
      lineInput: __type(name: "DraftOrderLineItemInput") {
        inputFields { name }
      }
      draftType: __type(name: "DraftOrder") {
        fields { name }
      }
      mutationType: __type(name: "Mutation") {
        fields { name }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {});

  const fieldNames = (
    value: unknown
  ): Set<string> => {
    if (
      value === null ||
      typeof value !== "object"
    ) return new Set();

    const obj = value as Record<string, unknown>;
    const fields = Array.isArray(obj.inputFields)
      ? obj.inputFields
      : Array.isArray(obj.fields)
        ? obj.fields
        : [];

    return new Set(
      fields
        .filter(
          (x): x is Record<string, unknown> =>
            x !== null &&
            typeof x === "object" &&
            !Array.isArray(x)
        )
        .map(x => x.name)
        .filter((x): x is string =>
          typeof x === "string"
        )
    );
  };

  const scopes = new Set<string>(
    (
      data?.currentAppInstallation?.accessScopes ??
      []
    )
      .map((x: { handle?: unknown }) => x.handle)
      .filter(
        (x: unknown): x is string =>
          typeof x === "string"
      )
  );

  const draftInput = fieldNames(data?.draftInput);
  const lineInput = fieldNames(data?.lineInput);
  const draftType = fieldNames(data?.draftType);
  const mutations = fieldNames(data?.mutationType);

  return {
    probe: "ALO_NOW_TIP_V184",
    readOnly: true as const,

    permissions: {
      writeDraftOrders: scopes.has(
        "write_draft_orders"
      ),
      writeQuickSale: scopes.has(
        "write_quick_sale"
      ),
      readDraftOrders: scopes.has(
        "read_draft_orders"
      )
    },

    requiredSchema: {
      draftOrderCreate:
        mutations.has("draftOrderCreate"),

      draftCustomAttributes:
        draftInput.has("customAttributes"),

      draftPresentmentCurrency:
        draftInput.has("presentmentCurrencyCode"),

      draftDiscountProtection:
        draftInput.has(
          "allowDiscountCodesInCheckout"
        ) &&
        draftInput.has(
          "acceptAutomaticDiscounts"
        ),

      customItemPrice:
        lineInput.has(
          "originalUnitPriceWithCurrency"
        ),

      customItemShipping:
        lineInput.has("requiresShipping"),

      customItemTax:
        lineInput.has("taxable"),

      draftResponseAttributes:
        draftType.has("customAttributes"),

      draftInvoiceUrl:
        draftType.has("invoiceUrl"),

      draftTotal:
        draftType.has("totalPriceSet")
    },

    note:
      "Schema and scope checks do not authorize writes."
  };
}

/**
 * ALO NOW V190
 *
 * Read-only Shopify draft discovery.
 *
 * Does not create, modify, complete or send invoices.
 * No customer details returned.
 */
export async function findAloNowTipDraftsV190() {
  const query = `
    query AloNowTipDraftDiscoveryV190 {
      draftOrders(
        first: 10,
        query: "tag:ALO_NOW_TIP"
      ) {
        nodes {
          id
          status
          customAttributes {
            key
            value
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {});

  if (!data?.draftOrders) {
    throw new Error("SHOPIFY_DRAFT_QUERY_INVALID");
  }

  const nodes = data.draftOrders.nodes;

  if (!Array.isArray(nodes)) {
    throw new Error("SHOPIFY_DRAFT_LIST_INVALID");
  }

  return {
    connected: true as const,
    readOnly: true as const,
    retrievedCount: nodes.length,
    hasMore: data.draftOrders.pageInfo?.hasNextPage
      === true,
    tipDrafts: nodes.map((item: {
      id?: unknown;
      status?: unknown;
      customAttributes?: unknown;
    }) => ({
      id: typeof item.id === "string"
        ? item.id
        : null,
      status: typeof item.status === "string"
        ? item.status
        : null,
      attributesPresent:
        Array.isArray(item.customAttributes)
    }))
  };
}

/**
 * ALO NOW V191
 *
 * Read-only reconciliation of Shopify tip draft orders.
 * Never use a missing/incomplete result to authorize
 * an automatic retry of draftOrderCreate.
 */
export async function findAloNowTipDraftByReferenceV191(
  reference: string
): Promise<
  | { status: "FOUND"; draftOrderId: string }
  | { status: "NOT_FOUND" }
  | { status: "AMBIGUOUS" }
  | { status: "INCOMPLETE" }
> {
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!UUID.test(reference)) {
    throw new Error("INVALID_TIP_REFERENCE");
  }

  const query = `
    query AloNowTipReconcileV191($after: String) {
      draftOrders(
        first: 100
        after: $after
        query: "tag:ALO_NOW_TIP"
        sortKey: ID
      ) {
        nodes {
          id
          customAttributes {
            key
            value
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  `;

  let after: string | null = null;
  const seen = new Set<string>();
  const matches = new Set<string>();

  // Bound the read. An incomplete scan is never
  // treated as proof that a draft does not exist.
  for (let page = 0; page < 20; page++) {
    const data = await shopifyGraphQL(query, { after });
    const connection = data?.draftOrders;

    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !connection.pageInfo
    ) {
      return { status: "INCOMPLETE" };
    }

    for (const node of connection.nodes) {
      if (
        typeof node?.id !== "string" ||
        !/^gid:\/\/shopify\/DraftOrder\/[1-9][0-9]*$/.test(
          node.id
        ) ||
        !Array.isArray(node.customAttributes)
      ) {
        return { status: "INCOMPLETE" };
      }

      if (seen.has(node.id)) {
        return { status: "INCOMPLETE" };
      }

      seen.add(node.id);

      const fields = new Map<string, string>();
      for (const item of node.customAttributes) {
        if (
          typeof item?.key !== "string" ||
          typeof item?.value !== "string" ||
          fields.has(item.key)
        ) {
          return { status: "INCOMPLETE" };
        }
        fields.set(item.key, item.value);
      }

      if (
        fields.get("alo_now_tip_checkout_reference") ===
          reference &&
        fields.get("alo_now_tip_purpose") ===
          "POST_DELIVERY_TIP"
      ) {
        matches.add(node.id);
      }
    }

    if (matches.size > 1) {
      return { status: "AMBIGUOUS" };
    }

    if (connection.pageInfo.hasNextPage === false) {
      if (matches.size === 0) {
        return { status: "NOT_FOUND" };
      }

      return {
        status: "FOUND",
        draftOrderId: [...matches][0]
      };
    }

    const next = connection.pageInfo.endCursor;

    if (
      connection.pageInfo.hasNextPage !== true ||
      typeof next !== "string" ||
      next.length === 0 ||
      next === after
    ) {
      return { status: "INCOMPLETE" };
    }

    after = next;
  }

  return { status: "INCOMPLETE" };
}
