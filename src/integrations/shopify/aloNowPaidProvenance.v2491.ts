import {
  shopifyOrderReadTransportV2290
} from "./aloNowTrustedOrderReader.v2290.js";

/**
 * V2491: Shopify Admin API provenance, read-only.
 * Never trust webhook-provided checkout attributes.
 */
const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Transport = (
  query: string,
  variables: { id: string }
) => Promise<unknown>;

export type PaidProvenanceV2491 = {
  id: string;
  aloNowRequestId: string;
  aloNowCheckoutReference: string;
};

const QUERY = `
query AloNowPaidProvenanceV2491($id: ID!) {
  order(id: $id) {
    id
    displayFinancialStatus
    cancelledAt
    customAttributes {
      key
      value
    }
  }
}
`;

function object(
  value: unknown
): Record<string, unknown> | null {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : null;
}

export function makeAloNowPaidProvenanceReaderV2491(
  transport: Transport
) {
  return async (
    orderId: string
  ): Promise<PaidProvenanceV2491 | null> => {
    if (!ORDER.test(orderId))
      throw new Error("INVALID_ORDER_ID");

    const envelope = object(
      await transport(QUERY, { id: orderId })
    );

    if (!envelope || (
      Array.isArray(envelope.errors) &&
      envelope.errors.length > 0
    )) {
      throw new Error("SHOPIFY_PROVENANCE_GRAPHQL_ERROR");
    }

    const data = object(envelope.data);

    if (!data)
      throw new Error("SHOPIFY_PROVENANCE_INVALID");

    if (data.order === null)
      return null;

    const order = object(data.order);

    if (
      !order ||
      order.id !== orderId ||
      order.displayFinancialStatus !== "PAID" ||
      order.cancelledAt !== null ||
      !Array.isArray(order.customAttributes)
    ) {
      throw new Error("SHOPIFY_PAID_ORDER_INVALID");
    }

    const keys = new Map<string, string>();

    for (const attribute of order.customAttributes) {
      const item = object(attribute);

      if (!item || typeof item.key !== "string")
        throw new Error("SHOPIFY_ATTRIBUTE_INVALID");

      if (
        item.key !== "alo_now_request_id" &&
        item.key !== "alo_now_checkout_reference"
      ) continue;

      if (
        keys.has(item.key) ||
        typeof item.value !== "string" ||
        !UUID.test(item.value)
      ) {
        throw new Error("SHOPIFY_CHECKOUT_ATTRIBUTE_INVALID");
      }

      keys.set(item.key, item.value);
    }

    const requestId = keys.get("alo_now_request_id");
    const reference = keys.get("alo_now_checkout_reference");

    if (!requestId || !reference)
      throw new Error("SHOPIFY_CHECKOUT_ATTRIBUTES_MISSING");

    return {
      id: orderId,
      aloNowRequestId: requestId,
      aloNowCheckoutReference: reference
    };
  };
}

export const readAloNowPaidProvenanceV2491 =
  makeAloNowPaidProvenanceReaderV2491(
    shopifyOrderReadTransportV2290
  );
