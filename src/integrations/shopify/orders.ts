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
  email

  totalPriceSet {
    shopMoney {
      amount
      currencyCode
    }
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

        weight {
          value
          unit
        }

        variant {
          id
          title
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
