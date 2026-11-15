// ALO_NOW_V1592_JOURNAL_DISPATCH
// Isolated execution engine. NOT connected to any API route.
// Caller must hold the existing per-order session advisory lock.
// No automatic retries after DISPATCHING.
// Shopify transport is injected, never called by this module
// unless an authorized future orchestrator explicitly invokes it.

import {
  fingerprintJournalPayloadV1586,
  type JournalPayloadV1586,
} from "./aloNowFulfillmentJournal.v1586.js";

type QueryResultV1592 = {
  rows: any[];
  rowCount: number | null;
};

export type JournalDbV1592 = {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResultV1592>;
};

export type ShopifyFulfillmentV1592 = {
  id: string;
  status: string;
};

export type FulfillmentTransportV1592 = (
  input: {
    fulfillmentOrderId: string;
    fulfillmentOrderLineItems: Array<{
      id: string;
      quantity: number;
    }>;
  }
) => Promise<ShopifyFulfillmentV1592>;

export type DispatchInputV1592 = {
  payload: JournalPayloadV1586;
  db: JournalDbV1592;
  createFulfillment: FulfillmentTransportV1592;
};

function validFulfillment(
  value: ShopifyFulfillmentV1592
): boolean {
  return (
    typeof value?.id === "string" &&
    value.id.startsWith("gid://shopify/Fulfillment/") &&
    typeof value.status === "string" &&
    value.status.length > 0
  );
}

async function markReconcileV1592(
  db: JournalDbV1592,
  payload: JournalPayloadV1586,
  payloadHash: string
): Promise<void> {
  const result = await db.query(
    `UPDATE alo_now_fulfillment_journal_v1586
     SET state = 'RECONCILE_REQUIRED',
         updated_at = NOW()
     WHERE shopify_order_id = $1
       AND fulfillment_order_id = $2
       AND selection_hash = $3
       AND payload_hash = $4
       AND state = 'DISPATCHING'
     RETURNING fulfillment_order_id`,
    [
      payload.shopifyOrderId,
      payload.fulfillmentOrderId,
      payload.selectionHash,
      payloadHash,
    ]
  );

  if (result.rowCount !== 1) {
    throw new Error("RECONCILIATION_STATUS_UNCERTAIN");
  }
}

export async function dispatchJournalEntryV1592(
  input: DispatchInputV1592
): Promise<{
  ok: true;
  mode: "FULFILLMENT_CONFIRMED";
  shopifyFulfillmentId: string;
}> {
  if (
    !input ||
    !input.db ||
    typeof input.db.query !== "function" ||
    typeof input.createFulfillment !== "function"
  ) {
    throw new Error("INVALID_DISPATCH_DEPENDENCIES");
  }

  const payload = input.payload;
  const hash = fingerprintJournalPayloadV1586(payload);
  const db = input.db;

  // One atomic claim. A second invocation cannot claim
  // the same journal entry while or after it is dispatched.
  let begun = false;
  let committed = false;

  try {
    await db.query("BEGIN");
    begun = true;

    const claimed = await db.query(
      `UPDATE alo_now_fulfillment_journal_v1586
       SET state = 'DISPATCHING',
           dispatch_started_at = NOW(),
           updated_at = NOW()
       WHERE shopify_order_id = $1
         AND fulfillment_order_id = $2
         AND selection_hash = $3
         AND payload_hash = $4
         AND state = 'PREPARED'
         AND EXISTS (
           SELECT 1
           FROM alo_now_partial_selections_v1586 s
           WHERE s.shopify_order_id = $1
             AND s.selection_hash = $3
             AND s.state IN ('PREPARED', 'IN_PROGRESS')
         )
       RETURNING fulfillment_order_id`,
      [
        payload.shopifyOrderId,
        payload.fulfillmentOrderId,
        payload.selectionHash,
        hash,
      ]
    );

    if (claimed.rowCount !== 1) {
      throw new Error(
        "JOURNAL_NOT_PREPARED_OR_ALREADY_DISPATCHED"
      );
    }

    // Must be durably committed before any Shopify request.
    await db.query("COMMIT");
    begun = false;
    committed = true;
  } catch (error) {
    if (begun) {
      try {
        await db.query("ROLLBACK");
      } catch {
        throw new Error("JOURNAL_CLAIM_ROLLBACK_UNCERTAIN");
      }
    }
    // If COMMIT was ambiguous, never send Shopify a request.
    throw error;
  }

  if (!committed) {
    throw new Error("JOURNAL_NOT_DURABLY_CLAIMED");
  }

  let fulfillment: ShopifyFulfillmentV1592;

  try {
    fulfillment = await input.createFulfillment({
      fulfillmentOrderId: payload.fulfillmentOrderId,
      fulfillmentOrderLineItems: payload.lines.map(
        line => ({id: line.id, quantity: line.quantity})
      ),
    });

    if (!validFulfillment(fulfillment)) {
      throw new Error("INVALID_SHOPIFY_FULFILLMENT_RESPONSE");
    }
  } catch {
    try {
      await markReconcileV1592(db, payload, hash);
    } catch {
      throw new Error(
        "SHOPIFY_RESULT_UNCERTAIN_AND_JOURNAL_UNCERTAIN"
      );
    }

    throw new Error(
      "SHOPIFY_RESULT_UNCERTAIN_RECONCILIATION_REQUIRED"
    );
  }

  // A Shopify success must be persisted before reporting success
  // to the driver. If persistence fails, no blind retry is allowed.
  try {
    const confirmed = await db.query(
      `UPDATE alo_now_fulfillment_journal_v1586
       SET state = 'CONFIRMED',
           shopify_fulfillment_id = $5,
           confirmed_at = NOW(),
           updated_at = NOW()
       WHERE shopify_order_id = $1
         AND fulfillment_order_id = $2
         AND selection_hash = $3
         AND payload_hash = $4
         AND state = 'DISPATCHING'
       RETURNING fulfillment_order_id`,
      [
        payload.shopifyOrderId,
        payload.fulfillmentOrderId,
        payload.selectionHash,
        hash,
        fulfillment.id,
      ]
    );

    if (confirmed.rowCount !== 1) {
      throw new Error("JOURNAL_CONFIRMATION_CONFLICT");
    }
  } catch {
    // The Shopify fulfillment may already exist.
    // Do not send the mutation again.
    throw new Error(
      "SHOPIFY_SUCCEEDED_JOURNAL_CONFIRMATION_UNCERTAIN"
    );
  }

  return {
    ok: true,
    mode: "FULFILLMENT_CONFIRMED",
    shopifyFulfillmentId: fulfillment.id,
  };
}
