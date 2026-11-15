// ALO_NOW_V1597_READ_ONLY_SHOPIFY_READER
// GraphQL QUERY only. No mutations or database operations.
// Not exposed through an API route.

export const ALO_NOW_SHOPIFY_EVIDENCE_QUERY_V1597 = `
  query AloNowFulfillmentEvidenceV1597($orderId: ID!) {
    order(id: $orderId) {
      id
      fulfillmentsCount {
        count
      }
      fulfillments(first: 250) {
        id
        status
        fulfillmentLineItems(first: 250) {
          pageInfo {
            hasNextPage
          }
          nodes {
            quantity
            lineItem {
              id
            }
          }
        }
      }
    }
  }
`;

type GraphQLReaderV1597 = (
  query: string,
  variables: Record<string, unknown>
) => Promise<any>;

export function normalizeShopifyEvidenceV1597(
  result: any,
  requestedOrderId: string
) {
  const order = result?.order;

  if (
    !order ||
    order.id !== requestedOrderId ||
    !Array.isArray(order.fulfillments)
  ) {
    throw new Error("SHOPIFY_EVIDENCE_ORDER_MISMATCH");
  }

  const total = order.fulfillmentsCount?.count;

  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total !== order.fulfillments.length
  ) {
    throw new Error(
      "SHOPIFY_EVIDENCE_FULFILLMENT_LIST_INCOMPLETE"
    );
  }

  const seen = new Set<string>();

  const fulfillments = order.fulfillments.map(
    (fulfillment: any) => {
      const id = fulfillment?.id;

      if (
        typeof id !== "string" ||
        !id.startsWith("gid://shopify/Fulfillment/") ||
        seen.has(id)
      ) {
        throw new Error(
          "SHOPIFY_EVIDENCE_INVALID_FULFILLMENT_ID"
        );
      }

      seen.add(id);

      const connection =
        fulfillment.fulfillmentLineItems;

      if (
        connection?.pageInfo?.hasNextPage !== false ||
        !Array.isArray(connection?.nodes)
      ) {
        throw new Error(
          "SHOPIFY_EVIDENCE_LINE_ITEMS_INCOMPLETE"
        );
      }

      const lines = connection.nodes.map(
        (line: any) => {
          if (
            typeof line?.lineItem?.id !== "string" ||
            !line.lineItem.id.startsWith(
              "gid://shopify/LineItem/"
            ) ||
            !Number.isSafeInteger(line.quantity) ||
            line.quantity < 1
          ) {
            throw new Error(
              "SHOPIFY_EVIDENCE_INVALID_LINE"
            );
          }

          return {
            shopifyLineItemId: line.lineItem.id,
            quantity: line.quantity,
          };
        }
      );

      if (!lines.length) {
        throw new Error(
          "SHOPIFY_EVIDENCE_EMPTY_FULFILLMENT"
        );
      }

      return {
        id,
        status: String(fulfillment.status ?? ""),
        hasNextPage: false as const,
        lines,
      };
    }
  );

  return {
    shopifyOrderId: requestedOrderId,
    fulfillmentsHasNextPage: false as const,
    fulfillments,
    fulfillmentCount: total,
    source: "SHOPIFY_ADMIN_GRAPHQL" as const,
  };
}

export async function readShopifyEvidenceV1597(
  orderId: string,
  execute: GraphQLReaderV1597
) {
  if (
    typeof orderId !== "string" ||
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderId) ||
    typeof execute !== "function"
  ) {
    throw new Error("INVALID_SHOPIFY_EVIDENCE_REQUEST");
  }

  const data = await execute(
    ALO_NOW_SHOPIFY_EVIDENCE_QUERY_V1597,
    {orderId}
  );

  return normalizeShopifyEvidenceV1597(
    data,
    orderId
  );
}
