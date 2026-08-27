import axios from "axios";

import { env } from "../../config/env.js";
import { getShopifyAccessToken } from "./auth.js";


// ============================================================
// SHOP DOMAIN
// ============================================================

function getShopDomain(): string {
  const shop = env.shopify.shop
    .replace(/^https?:\/\//, "")
    .replace(/\.myshopify\.com$/, "")
    .replace(/\/$/, "");

  return `${shop}.myshopify.com`;
}


// ============================================================
// SHOPIFY GRAPHQL HELPER
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
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },

        timeout: 15000,

        validateStatus: () => true,
      }
    );


  if (response.status >= 400) {
    console.error(
      "Shopify Fulfillment HTTP Error:",
      response.status,
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

    throw new Error(
      `Shopify fulfillment request failed (${response.status})`
    );
  }


  if (response.data?.errors) {
    console.error(
      "Shopify Fulfillment GraphQL Errors:",
      JSON.stringify(
        response.data.errors,
        null,
        2
      )
    );

    throw new Error(
      "Shopify fulfillment GraphQL request failed"
    );
  }


  return response.data?.data;
}


// ============================================================
// FULFILLMENT ORDERS EINER SHOPIFY ORDER LADEN
// ============================================================

export async function getFulfillmentOrdersForOrder(
  orderId: string
) {
  const query = `
    query GetFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        id
        name

        fulfillmentOrders(first: 50) {
          nodes {
            id
            status
            requestStatus

            assignedLocation {
              name
            }

            lineItems(first: 100) {
              nodes {
                id
                totalQuantity
                remainingQuantity

                lineItem {
                  id
                  name
                  quantity
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
        orderId,
      }
    );


  if (!data?.order) {
    throw new Error(
      "Shopify Order wurde nicht gefunden."
    );
  }


  return data.order;
}


// ============================================================
// SHOPIFY FULFILLMENT ERSTELLEN
// ============================================================

export async function createShopifyFulfillment(
  input: {
    fulfillmentOrderId: string;
    trackingNumber: string;
    notifyCustomer?: boolean;
  }
) {
  const mutation = `
    mutation CreateFulfillment(
      $fulfillment: FulfillmentInput!
    ) {
      fulfillmentCreate(
        fulfillment: $fulfillment
      ) {
        fulfillment {
          id
          status

          trackingInfo {
            company
            number
            url
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;


  const variables = {
    fulfillment: {
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId:
            input.fulfillmentOrderId,
        },
      ],

      notifyCustomer:
        input.notifyCustomer ?? false,

      trackingInfo: {
        company: "Swiss Post",
        number: input.trackingNumber,
      },
    },
  };


  const data =
    await shopifyGraphQL(
      mutation,
      variables
    );


  const result =
    data?.fulfillmentCreate;


  if (!result) {
    throw new Error(
      "Shopify hat keine Fulfillment-Antwort geliefert."
    );
  }


  if (
    Array.isArray(result.userErrors) &&
    result.userErrors.length > 0
  ) {
    console.error(
      "Shopify fulfillmentCreate userErrors:",
      JSON.stringify(
        result.userErrors,
        null,
        2
      )
    );

    throw new Error(
      result.userErrors
        .map(
          (error: any) =>
            error.message
        )
        .join("; ")
    );
  }


  if (!result.fulfillment) {
    throw new Error(
      "Shopify Fulfillment wurde nicht erstellt."
    );
  }


  return result.fulfillment;
}
