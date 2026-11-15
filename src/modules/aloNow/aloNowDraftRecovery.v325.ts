// V325B: Read-only, offline-testable Shopify Draft recovery.
// This module never creates, pays for, or modifies Shopify orders.

export const ALO_NOW_DRAFT_RECOVERY_QUERY = `
query AloNowDraftRecovery($after: String) {
  draftOrders(first: 100, after: $after, query: "tag:ALO_NOW") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      customAttributes { key value }
      totalPriceSet {
        shopMoney { amount currencyCode }
        presentmentMoney { amount currencyCode }
      }
    }
  }
}`;

type FetchPage = (after: string | null) => Promise<unknown>;

export type RecoveryResult =
  | { status: "FOUND"; draftOrderId: string }
  | { status: "NOT_FOUND_UNCONFIRMED" }
  | { status: "AMBIGUOUS" }
  | { status: "INCONCLUSIVE"; reason: string };

// Correct UUID: 8-4-4-4-12.
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DRAFT = /^gid:\/\/shopify\/DraftOrder\/[1-9]\d*$/;

export function isAloNowRecoveryUuid(value: unknown): boolean {
  return typeof value === "string" && UUID.test(value);
}

function cents(value: unknown): number | null {
  if (typeof value !== "string" ||
      !/^\d{1,8}\.\d{2}$/.test(value)) {
    return null;
  }
  const [whole, fraction] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(result) ? result : null;
}

export async function locateAloNowDraftV325(
  identity: {
    requestId: string;
    checkoutReference: string;
    expectedTotalCHF: string;
  },
  fetchPage: FetchPage
): Promise<RecoveryResult> {
  if (!isAloNowRecoveryUuid(identity.requestId) ||
      !isAloNowRecoveryUuid(identity.checkoutReference) ||
      cents(identity.expectedTotalCHF) === null) {
    return {status:"INCONCLUSIVE",reason:"INVALID_IDENTITY"};
  }

  const seenCursors = new Set<string>();
  const seenIds = new Set<string>();
  const matches = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < 20; page++) {
    let raw: unknown;

    try {
      raw = await fetchPage(cursor);
    } catch {
      return {status:"INCONCLUSIVE",reason:"READ_FAILED"};
    }

    if (!raw || typeof raw !== "object") {
      return {status:"INCONCLUSIVE",reason:"BAD_RESPONSE"};
    }

    const payload = raw as {
      errors?: unknown;
      data?: {
        draftOrders?: {
          nodes?: unknown;
          pageInfo?: {
            hasNextPage?: unknown;
            endCursor?: unknown;
          };
        };
      };
    };

    const connection = payload.data?.draftOrders;

    if ((Array.isArray(payload.errors) && payload.errors.length > 0) ||
        !connection ||
        !Array.isArray(connection.nodes) ||
        connection.nodes.length > 100 ||
        typeof connection.pageInfo?.hasNextPage !== "boolean") {
      return {status:"INCONCLUSIVE",reason:"BAD_RESPONSE"};
    }

    for (const node of connection.nodes) {
      if (!node || typeof node !== "object") {
        return {status:"INCONCLUSIVE",reason:"BAD_DRAFT"};
      }

      const draft = node as {
        id?: unknown;
        customAttributes?: unknown;
        totalPriceSet?: {
          shopMoney?: {amount?:unknown;currencyCode?:unknown};
          presentmentMoney?: {amount?:unknown;currencyCode?:unknown};
        };
      };

      if (typeof draft.id !== "string" ||
          !DRAFT.test(draft.id)) {
        return {status:"INCONCLUSIVE",reason:"BAD_DRAFT_ID"};
      }

      if (seenIds.has(draft.id)) {
        return {status:"INCONCLUSIVE",reason:"DUPLICATE_PAGE_ENTRY"};
      }
      seenIds.add(draft.id);

      if (!Array.isArray(draft.customAttributes)) {
        return {status:"INCONCLUSIVE",reason:"MISSING_ATTRIBUTES"};
      }

      const keys = new Map<string,string>();
      for (const attr of draft.customAttributes) {
        if (!attr || typeof attr !== "object") {
          return {status:"INCONCLUSIVE",reason:"BAD_ATTRIBUTES"};
        }

        const a = attr as {key?:unknown;value?:unknown};

        if (typeof a.key !== "string" ||
            typeof a.value !== "string" ||
            keys.has(a.key)) {
          return {status:"INCONCLUSIVE",reason:"BAD_ATTRIBUTES"};
        }

        keys.set(a.key,a.value);
      }

      if (keys.get("alo_now_request_id") !== identity.requestId ||
          keys.get("alo_now_checkout_reference") !==
            identity.checkoutReference) {
        continue;
      }

      const shop = draft.totalPriceSet?.shopMoney;
      const presentment = draft.totalPriceSet?.presentmentMoney;
      const expected = cents(identity.expectedTotalCHF);

      if (shop?.currencyCode !== "CHF" ||
          presentment?.currencyCode !== "CHF" ||
          cents(shop.amount) !== expected ||
          cents(presentment.amount) !== expected) {
        return {
          status:"INCONCLUSIVE",
          reason:"MATCHED_TOTAL_MISMATCH"
        };
      }

      matches.add(draft.id);
      if (matches.size > 1) return {status:"AMBIGUOUS"};
    }

    if (!connection.pageInfo.hasNextPage) {
      if (matches.size === 1) {
        return {
          status:"FOUND",
          draftOrderId:[...matches][0]
        };
      }
      return {status:"NOT_FOUND_UNCONFIRMED"};
    }

    const next = connection.pageInfo.endCursor;
    if (typeof next !== "string" ||
        !next || seenCursors.has(next)) {
      return {status:"INCONCLUSIVE",reason:"INVALID_CURSOR"};
    }

    seenCursors.add(next);
    cursor = next;
  }

  return {status:"INCONCLUSIVE",reason:"PAGE_LIMIT"};
}
