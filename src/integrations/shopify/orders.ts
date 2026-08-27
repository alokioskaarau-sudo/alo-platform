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

export async function getLatestShopifyOrders(limit = 5) {
  const token = await getShopifyAccessToken();
  const shopDomain = getShopDomain();

  const query = `
    query GetLatestOrders($first: Int!) {
      orders(
        first: $first
        reverse: true
        sortKey: CREATED_AT
      ) {
        edges {
          node {
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
          }
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${shopDomain}/admin/api/${env.shopify.apiVersion}/graphql.json`,
    {
      query,
      variables: {
        first: limit,
      },
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
      "Shopify Orders HTTP Error:",
      response.status,
      JSON.stringify(response.data, null, 2)
    );

    throw new Error(
      `Shopify orders request failed (${response.status})`
    );
  }

  if (response.data?.errors) {
    console.error(
      "Shopify GraphQL Errors:",
      JSON.stringify(response.data.errors, null, 2)
    );

    throw new Error(
      "Shopify GraphQL orders query failed"
    );
  }

  return response.data.data.orders.edges.map(
    (edge: any) => edge.node
  );
}
