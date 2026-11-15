import type { ShopifyAdminGraphql } from "./aloNowShopifyAdminPaymentReader.js";
import type { AloNowOrderProvenance } from "./aloNowOrderProvenance.js";

const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALO_NOW_PROVENANCE_QUERY = `
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

function object(value: unknown): Record<string, unknown> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
}

/**
 * The injected GraphQL transport MUST be authenticated server-side.
 * Never inject browser-provided JSON or an unrestricted public transport.
 * Fail closed for incomplete, duplicate or malformed attributes.
 */
export function createAloNowShopifyProvenanceReader(
  graphql: ShopifyAdminGraphql
): (orderId: string) => Promise<AloNowOrderProvenance | null> {
  return async orderId => {
    if (!ORDER.test(orderId))
      throw new Error("INVALID_SHOPIFY_ORDER_ID");

    const raw = object(await graphql(
      ALO_NOW_PROVENANCE_QUERY, { id: orderId }
    ));

    if (!raw)
      throw new Error("INVALID_SHOPIFY_RESPONSE");

    if (Array.isArray(raw.errors) && raw.errors.length)
      throw new Error("SHOPIFY_GRAPHQL_ERROR");

    const envelope = object(raw.data) ?? raw;
    const node = object(envelope.node);

    if (!node) return null;

    if (node.id !== orderId || !Array.isArray(node.customAttributes))
      throw new Error("INVALID_PROVENANCE_PAYLOAD");

    const attributes = new Map<string, string>();
    const wanted = new Set([
      "alo_now_request_id",
      "alo_now_checkout_reference"
    ]);

    for (const entry of node.customAttributes) {
      const item = object(entry);
      if (!item || typeof item.key !== "string")
        throw new Error("INVALID_PROVENANCE_ATTRIBUTE");

      if (!wanted.has(item.key)) continue;

      if (attributes.has(item.key))
        throw new Error("DUPLICATE_PROVENANCE_ATTRIBUTE");

      if (typeof item.value !== "string")
        throw new Error("INVALID_PROVENANCE_ATTRIBUTE");

      attributes.set(item.key, item.value);
    }

    const requestId = attributes.get("alo_now_request_id");
    const reference = attributes.get("alo_now_checkout_reference");

    if (!requestId || !reference ||
        !UUID.test(requestId) || !UUID.test(reference))
      throw new Error("PROVENANCE_MISSING_OR_INVALID");

    return {
      id: orderId,
      aloNowRequestId: requestId,
      aloNowCheckoutReference: reference
    };
  };
}
