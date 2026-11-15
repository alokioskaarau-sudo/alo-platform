// ALO_NOW_V1645_RESERVED_SNAPSHOT
// Isolated, dependency-injected PostgreSQL reader.
// Caller must hold the shared order advisory lock.
// NO payment authorization, Shopify mutation or HTTP route.

import {
  buildPartialDispatchPlanV1641,
} from "./aloNowPartialDispatchPlan.v1641.js";

type SnapshotV1645 = Parameters<
  typeof buildPartialDispatchPlanV1641
>[0];

export type SnapshotDbV1645 = {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{
    rows: any[];
    rowCount: number | null;
  }>;
};

export async function readReservedSnapshotV1645(
  db: SnapshotDbV1645,
  shopifyOrderId: string,
  staffUserId: string
): Promise<SnapshotV1645> {
  if (
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(
      shopifyOrderId ?? ""
    ) ||
    !/^[1-9]\d*$/.test(staffUserId ?? "") ||
    !db ||
    typeof db.query !== "function"
  ) {
    throw new Error("INVALID_SNAPSHOT_REQUEST");
  }

  let transactionStarted = false;

  try {
    await db.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    transactionStarted = true;

    const schema = await db.query(`
      SELECT
        to_regclass('alo_now_handoff_ledger')::text
          AS handoff,
        to_regclass('alo_now_partial_selections_v1586')::text
          AS selections,
        to_regclass('alo_now_fulfillment_journal_v1586')::text
          AS journal
    `);

    if (
      !schema.rows[0]?.handoff ||
      !schema.rows[0]?.selections ||
      !schema.rows[0]?.journal
    ) {
      throw new Error("PARTIAL_SCHEMA_MISSING");
    }

    const deliveryResult = await db.query(`
      SELECT
        assigned_driver_user_id,
        delivery_status,
        age_verification_status
      FROM alo_now_deliveries
      WHERE shopify_order_id = $1
    `, [shopifyOrderId]);

    if (deliveryResult.rows.length !== 1) {
      throw new Error("DELIVERY_NOT_FOUND_OR_AMBIGUOUS");
    }

    const delivery = deliveryResult.rows[0];

    if (
      String(delivery.assigned_driver_user_id) !==
      staffUserId
    ) {
      throw new Error("NOT_ASSIGNED_TO_DRIVER");
    }

    if (delivery.delivery_status !== "ON_THE_WAY") {
      throw new Error("DELIVERY_NOT_ON_THE_WAY");
    }

    if (
      delivery.age_verification_status ===
      "VERIFIED_AT_HANDOFF"
    ) {
      throw new Error("PARTIAL_AGE_CONTEXT_CHANGED");
    }

    const ledgerResult = await db.query(`
      SELECT
        assigned_driver_user_id,
        handoff_state,
        delivered_lines,
        withheld_lines
      FROM alo_now_handoff_ledger
      WHERE shopify_order_id = $1
    `, [shopifyOrderId]);

    if (ledgerResult.rows.length !== 1) {
      throw new Error("HANDOFF_LEDGER_MISSING");
    }

    const ledger = ledgerResult.rows[0];

    if (
      String(ledger.assigned_driver_user_id) !==
      staffUserId ||
      ledger.handoff_state !== "PREPARED" ||
      !Array.isArray(ledger.delivered_lines) ||
      !Array.isArray(ledger.withheld_lines) ||
      ledger.delivered_lines.length === 0 ||
      ledger.withheld_lines.length === 0
    ) {
      throw new Error("INVALID_HANDOFF_LEDGER");
    }

    const selectionResult = await db.query(`
      SELECT
        driver_user_id,
        selection_hash,
        state,
        expected_fulfillments,
        selected_lines,
        withheld_lines
      FROM alo_now_partial_selections_v1586
      WHERE shopify_order_id = $1
    `, [shopifyOrderId]);

    if (selectionResult.rows.length !== 1) {
      throw new Error("SELECTION_NOT_FOUND");
    }

    const selection = selectionResult.rows[0];

    if (
      String(selection.driver_user_id) !== staffUserId ||
      !["PREPARED", "IN_PROGRESS"].includes(
        selection.state
      ) ||
      !Array.isArray(selection.expected_fulfillments) ||
      !Array.isArray(selection.selected_lines) ||
      !Array.isArray(selection.withheld_lines)
    ) {
      throw new Error("INVALID_RESERVED_SELECTION");
    }

    const canonicalLines = (value: unknown) => {
      if (!Array.isArray(value)) {
        throw new Error("INVALID_STORED_LINES");
      }

      return JSON.stringify(
        value.map((item: any) => ({
          lineItemId: item?.lineItemId,
          quantity: item?.quantity,
        })).sort((a: any, b: any) =>
          String(a.lineItemId).localeCompare(
            String(b.lineItemId)
          )
        )
      );
    };

    if (
      canonicalLines(selection.selected_lines) !==
        canonicalLines(ledger.delivered_lines) ||
      canonicalLines(selection.withheld_lines) !==
        canonicalLines(ledger.withheld_lines)
    ) {
      throw new Error("LEDGER_SELECTION_MISMATCH");
    }

    const journalResult = await db.query(`
      SELECT
        fulfillment_order_id,
        selection_hash,
        payload_hash,
        fulfillment_lines,
        state,
        shopify_fulfillment_id
      FROM alo_now_fulfillment_journal_v1586
      WHERE shopify_order_id = $1
      ORDER BY fulfillment_order_id
    `, [shopifyOrderId]);

    const snapshot: SnapshotV1645 = {
      shopifyOrderId,
      selectionHash: selection.selection_hash,
      selectionState: selection.state,
      manifest: selection.expected_fulfillments,
      journal: journalResult.rows.map((row: any) => ({
        fulfillmentOrderId: row.fulfillment_order_id,
        selectionHash: row.selection_hash,
        payloadHash: row.payload_hash,
        fulfillmentLines: row.fulfillment_lines,
        state: row.state,
        shopifyFulfillmentId:
          row.shopify_fulfillment_id,
      })),
    };

    // Validate the whole manifest while the snapshot is
    // consistent. This is NOT permission to dispatch.
    buildPartialDispatchPlanV1641(snapshot);

    await db.query("COMMIT");
    transactionStarted = false;

    return snapshot;
  } catch (error) {
    if (transactionStarted) {
      try {
        await db.query("ROLLBACK");
      } catch {
        throw new Error(
          "SNAPSHOT_ROLLBACK_UNCERTAIN_DESTROY_CLIENT"
        );
      }
    }

    throw error;
  }
}
