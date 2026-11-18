
import {
  verifyAloNowCreatedDraftV2463
} from "./aloNowDraftBindingGuard.v2463.js";
import {
  shopifyOrderReadTransportV2290
} from "../../integrations/shopify/aloNowTrustedOrderReader.v2290.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const DRAFT = /^gid:\/\/shopify\/DraftOrder\/[1-9][0-9]*$/;

export const ALO_NOW_DRAFT_ORDER_LINK_QUERY_V2465 = `
query AloNowDraftOrderLinkV2465($id: ID!) {
  draftOrder(id: $id) {
    id
    order { id }
    customAttributes { key value }
    totalPriceSet {
      shopMoney { amount currencyCode }
    }
  }
}`;

type DraftGuard = (
  id: string
) => Promise<
  | {
      ok: true;
      draftOrderId: string;
      checkoutReference: string;
      expectedTotalCHF: string;
    }
  | { ok: false; reason: string }
>;

type Transport = (
  query: string,
  variables: { id: string }
) => Promise<unknown>;

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" &&
    !Array.isArray(v)
      ? v as Record<string, unknown>
      : null;
}

function cents(v: unknown): bigint | null {
  if (
    typeof v !== "string" ||
    !/^(0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(v)
  ) return null;

  const [francs, fraction = ""] = v.split(".");
  return BigInt(francs) * 100n +
    BigInt(fraction.padEnd(2, "0"));
}

/**
 * Read-only, fail-closed Shopify Draft -> Order verification.
 * Never accepts customer-supplied Shopify response objects.
 * Only inject an authenticated server-side Admin API transport.
 */
export function createAloNowDraftOrderLinkV2465(
  guard: DraftGuard,
  transport: Transport
) {
  return async (requestId: string, orderId: string) => {
    if (!UUID.test(requestId) || !ORDER.test(orderId)) {
      return {
        ok: false as const,
        reason: "INVALID_LINK_IDENTITY"
      };
    }

    try {
      const stored = await guard(requestId);
      if (!stored.ok) return stored;

      if (
        !DRAFT.test(stored.draftOrderId) ||
        !UUID.test(stored.checkoutReference) ||
        cents(stored.expectedTotalCHF) === null
      ) {
        return {
          ok: false as const,
          reason: "STORED_DRAFT_INVALID"
        };
      }

      const raw = obj(await transport(
        ALO_NOW_DRAFT_ORDER_LINK_QUERY_V2465,
        { id: stored.draftOrderId }
      ));

      if (!raw ||
          (Array.isArray(raw.errors) && raw.errors.length > 0)) {
        return {
          ok: false as const,
          reason: "SHOPIFY_DRAFT_READ_INVALID"
        };
      }

      const data = obj(raw.data);
      const draft = obj(data?.draftOrder);
      const linkedOrder = obj(draft?.order);
      const money = obj(obj(draft?.totalPriceSet)?.shopMoney);

      if (
        !draft ||
        draft.id !== stored.draftOrderId ||
        !linkedOrder ||
        linkedOrder.id !== orderId
      ) {
        return {
          ok: false as const,
          reason: "DRAFT_ORDER_LINK_MISMATCH"
        };
      }

      if (
        !money ||
        money.currencyCode !== "CHF" ||
        cents(money.amount) === null ||
        cents(money.amount) !== cents(stored.expectedTotalCHF)
      ) {
        return {
          ok: false as const,
          reason: "DRAFT_TOTAL_MISMATCH"
        };
      }

      if (!Array.isArray(draft.customAttributes)) {
        return {
          ok: false as const,
          reason: "DRAFT_ATTRIBUTES_MISSING"
        };
      }

      const attributes = new Map<string, string>();
      const required = new Set([
        "alo_now_request_id",
        "alo_now_checkout_reference"
      ]);

      for (const rawAttribute of draft.customAttributes) {
        const attribute = obj(rawAttribute);

        if (!attribute || typeof attribute.key !== "string") {
          return {
            ok: false as const,
            reason: "DRAFT_ATTRIBUTE_INVALID"
          };
        }

        if (!required.has(attribute.key)) continue;

        if (
          attributes.has(attribute.key) ||
          typeof attribute.value !== "string"
        ) {
          return {
            ok: false as const,
            reason: "DRAFT_ATTRIBUTE_INVALID"
          };
        }

        attributes.set(attribute.key, attribute.value);
      }

      if (
        attributes.get("alo_now_request_id") !== requestId ||
        attributes.get("alo_now_checkout_reference") !==
          stored.checkoutReference
      ) {
        return {
          ok: false as const,
          reason: "DRAFT_PROVENANCE_MISMATCH"
        };
      }

      return {
        ok: true as const,
        requestId,
        shopifyOrderId: orderId,
        draftOrderId: stored.draftOrderId,
        expectedTotalCHF: stored.expectedTotalCHF
      };
    } catch {
      return {
        ok: false as const,
        reason: "DRAFT_ORDER_VERIFICATION_UNAVAILABLE"
      };
    }
  };
}

// Real server-side wiring. No network until explicitly called.
// No mutation and no HTTP route are registered.
export const verifyAloNowDraftOrderLinkV2465 =
  createAloNowDraftOrderLinkV2465(
    verifyAloNowCreatedDraftV2463,
    shopifyOrderReadTransportV2290
  );
