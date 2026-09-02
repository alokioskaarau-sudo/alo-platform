import axios from "axios";
import { env } from "../../config/env.js";
import { getShopifyAccessToken } from "./auth.js";

/* =========================================================
   TYPES
========================================================= */

export type ShopifyDiscountCodeResult = {
  id: string;
  code: string;
  title: string;
  status: string | null;
};

type ShopifyGraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message?: string;
    path?: Array<string | number>;
    extensions?: unknown;
  }>;
};

/* =========================================================
   SHOP DOMAIN
========================================================= */

function getShopDomain(): string {
  const shop = env.shopify.shop
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");

  return `${shop}.myshopify.com`;
}

/* =========================================================
   GRAPHQL
========================================================= */

async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const token =
    await getShopifyAccessToken();

  const response =
    await axios.post<ShopifyGraphQLResponse<T>>(
      `https://${getShopDomain()}/admin/api/${env.shopify.apiVersion}/graphql.json`,
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

        validateStatus: () => true,
      }
    );

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    throw new Error(
      `Shopify Discount API HTTP ${response.status}: ` +
        JSON.stringify(
          response.data
        )
    );
  }

  if (
    response.data.errors &&
    response.data.errors.length > 0
  ) {
    throw new Error(
      "Shopify Discount GraphQL Fehler: " +
        JSON.stringify(
          response.data.errors
        )
    );
  }

  if (!response.data.data) {
    throw new Error(
      "Shopify Discount API lieferte keine Daten."
    );
  }

  return response.data.data;
}

/* =========================================================
   FIND DISCOUNT BY CODE

   Wird auch zur Recovery verwendet:
   Falls Shopify einen Code bereits erstellt hat, aber
   unsere DB den Erfolg noch nicht speichern konnte,
   finden wir denselben Shopify-Rabatt wieder.
========================================================= */

export async function findShopifyDiscountByCode(
  code: string
): Promise<ShopifyDiscountCodeResult | null> {
  const query = `
    query FindAloDiscountByCode($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id

        codeDiscount {
          __typename

          ... on DiscountCodeBasic {
            title
            status

            codes(first: 1) {
              nodes {
                code
              }
            }
          }
        }
      }
    }
  `;

  type Result = {
    codeDiscountNodeByCode:
      | {
          id: string;

          codeDiscount:
            | {
                __typename: string;
                title?: string;
                status?: string;

                codes?: {
                  nodes?: Array<{
                    code?: string;
                  }>;
                };
              }
            | null;
        }
      | null;
  };

  const data =
    await shopifyGraphQL<Result>(
      query,
      {
        code,
      }
    );

  const node =
    data.codeDiscountNodeByCode;

  if (!node) {
    return null;
  }

  if (
    node.codeDiscount?.__typename !==
    "DiscountCodeBasic"
  ) {
    throw new Error(
      `Shopify-Code ${code} existiert, ist aber kein DiscountCodeBasic.`
    );
  }

  const actualCode =
    node.codeDiscount.codes
      ?.nodes?.[0]?.code ??
    code;

  return {
    id: node.id,

    code:
      actualCode,

    title:
      node.codeDiscount.title ??
      "",

    status:
      node.codeDiscount.status ??
      null,
  };
}

/* =========================================================
   CREATE 15% PACKING-SLIP DISCOUNT

   Eigenschaften:
   - 15 %
   - alle Produkte
   - maximal 1 Benutzung insgesamt
   - maximal 1 Benutzung pro Kunde
   - nicht kombinierbar
   - sofort aktiv
========================================================= */

export async function createShopifyPackingSlipDiscount(
  input: {
    code: string;
    orderName: string;
    percentage?: number;
  }
): Promise<ShopifyDiscountCodeResult> {
  const percentage =
    input.percentage ?? 0.15;

  if (
    percentage <= 0 ||
    percentage >= 1
  ) {
    throw new Error(
      "Rabatt-Prozentsatz muss zwischen 0 und 1 liegen."
    );
  }

  /*
   * Recovery / Idempotenz:
   *
   * Existiert der reservierte Code bereits in Shopify,
   * erzeugen wir KEINEN zweiten Rabatt.
   */
  const existing =
    await findShopifyDiscountByCode(
      input.code
    );

  if (existing) {
    return existing;
  }

  const mutation = `
    mutation CreateAloPackingSlipDiscount(
      $basicCodeDiscount: DiscountCodeBasicInput!
    ) {
      discountCodeBasicCreate(
        basicCodeDiscount: $basicCodeDiscount
      ) {
        codeDiscountNode {
          id

          codeDiscount {
            ... on DiscountCodeBasic {
              title
              status

              codes(first: 1) {
                nodes {
                  code
                }
              }
            }
          }
        }

        userErrors {
          field
          code
          message
        }
      }
    }
  `;

  const title =
    `ALO Lieferschein 15% - ${input.orderName} - ${input.code}`;

  const variables = {
    basicCodeDiscount: {
      title,

      code:
        input.code,

      startsAt:
        new Date().toISOString(),

      context: {
        all: "ALL",
      },

      customerGets: {
        value: {
          percentage,
        },

        items: {
          all: true,
        },
      },

      usageLimit: 1,

      appliesOncePerCustomer:
        true,

      combinesWith: {
        orderDiscounts:
          false,

        productDiscounts:
          false,

        shippingDiscounts:
          false,
      },
    },
  };

  type Result = {
    discountCodeBasicCreate: {
      codeDiscountNode:
        | {
            id: string;

            codeDiscount:
              | {
                  title?: string;
                  status?: string;

                  codes?: {
                    nodes?: Array<{
                      code?: string;
                    }>;
                  };
                }
              | null;
          }
        | null;

      userErrors: Array<{
        field?: string[];
        code?: string;
        message: string;
      }>;
    };
  };

  const data =
    await shopifyGraphQL<Result>(
      mutation,
      variables
    );

  const result =
    data.discountCodeBasicCreate;

  if (
    result.userErrors &&
    result.userErrors.length > 0
  ) {
    /*
     * Auch hier noch einmal Recovery.
     *
     * Denkbares Szenario:
     * Zwischen unserem FIND und CREATE wurde derselbe
     * Code bereits von einem parallelen Prozess angelegt.
     */
    const recovered =
      await findShopifyDiscountByCode(
        input.code
      );

    if (recovered) {
      return recovered;
    }

    throw new Error(
      "Shopify Rabatt konnte nicht erstellt werden: " +
        result.userErrors
          .map(
            (error) =>
              error.message
          )
          .join(" | ")
    );
  }

  const node =
    result.codeDiscountNode;

  if (
    !node ||
    !node.codeDiscount
  ) {
    throw new Error(
      "Shopify hat keinen DiscountCodeNode zurückgegeben."
    );
  }

  const createdCode =
    node.codeDiscount.codes
      ?.nodes?.[0]?.code;

  if (!createdCode) {
    throw new Error(
      "Shopify Rabatt enthält keinen Code."
    );
  }

  return {
    id:
      node.id,

    code:
      createdCode,

    title:
      node.codeDiscount.title ??
      title,

    status:
      node.codeDiscount.status ??
      null,
  };
}
