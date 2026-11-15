// ALO_NOW_V1589_SELECTION_RESERVATION
// Additive transaction service. Not connected to HTTP routes.
// The shared per-order advisory lock MUST be held by the caller.
// No Shopify, refund, cash or delivery-completion actions.

import {createHash} from "node:crypto";
import type {HandoffPlan} from "./aloNowPartialHandoff.v1560.js";
import type {
  SplitFulfillmentEntryV1585,
} from "./aloNowSplitFulfillment.v1585.js";
import {
  fingerprintJournalPayloadV1586,
} from "./aloNowFulfillmentJournal.v1586.js";

type QueryResult = {
  rows: any[];
  rowCount: number | null;
};

export type ReservationClientV1589 = {
  query(
    sql: string,
    values?: unknown[]
  ): Promise<QueryResult>;
};

export type ReservationInputV1589 = {
  shopifyOrderId: string;
  staffUserId: string;
  reason:
    | "NO_ID"
    | "UNDERAGE"
    | "IDENTITY_UNCLEAR"
    | "DOCUMENT_INVALID"
    | "TECHNICAL_FAILURE";
  baseline: HandoffPlan;
  selected: HandoffPlan;
  fulfillmentPlan: SplitFulfillmentEntryV1585[];
  // ALO_NOW_V1601_PERSISTED_LINE_IDENTITIES
  // Obtained from fresh Shopify data by the locked caller.
  lineIdentities: Array<{
    fulfillmentOrderId: string;
    fulfillmentOrderLineItemId: string;
    shopifyLineItemId: string;
  }>;
};

function identity(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim()
  ) {
    throw new Error("INVALID_RESERVATION_IDENTITY");
  }
  return value;
}

function validateLines(
  lines: HandoffPlan["delivered"]
): Array<{lineItemId: string; quantity: number}> {
  if (!Array.isArray(lines)) {
    throw new Error("INVALID_RESERVATION_LINES");
  }

  const seen = new Set<string>();

  return lines.map(line => {
    const lineItemId = identity(line?.lineItemId);
    const quantity = line?.quantity;

    if (
      seen.has(lineItemId) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1
    ) {
      throw new Error("INVALID_RESERVATION_LINE");
    }

    seen.add(lineItemId);
    return {lineItemId, quantity};
  }).sort((a, b) =>
    a.lineItemId.localeCompare(b.lineItemId)
  );
}

export function fingerprintSelectionV1589(
  input: ReservationInputV1589
): string {
  const shopifyOrderId = identity(input.shopifyOrderId);
  identity(input.staffUserId);

  if (
    !/^[1-9]\d*$/.test(input.staffUserId) ||
    !["NO_ID", "UNDERAGE", "IDENTITY_UNCLEAR",
      "DOCUMENT_INVALID", "TECHNICAL_FAILURE"]
      .includes(input.reason) ||
    input.baseline?.verifiedAgeLevel !== 0 ||
    input.selected?.verifiedAgeLevel !== 0
  ) {
    throw new Error("INVALID_RESERVATION_CONTEXT");
  }

  const delivered = validateLines(input.selected.delivered);
  const withheld = validateLines(input.selected.withheld);
  const baselineDelivered = validateLines(input.baseline.delivered);
  const baselineWithheld = validateLines(input.baseline.withheld);

  if (!delivered.length || !withheld.length) {
    throw new Error("PARTIAL_HANDOFF_REQUIRED");
  }

  if (
    input.selected.partial !== true ||
    input.selected.blocked !== false ||
    !Array.isArray(input.fulfillmentPlan) ||
    input.fulfillmentPlan.length === 0
  ) {
    throw new Error("INVALID_PARTIAL_HANDOFF_PLAN");
  }

  const totals = (a: typeof delivered, b: typeof withheld) => {
    const map = new Map<string, number>();
    for (const item of [...a, ...b]) {
      const total = (map.get(item.lineItemId) ?? 0) + item.quantity;
      if (!Number.isSafeInteger(total)) {
        throw new Error("RESERVATION_QUANTITY_OVERFLOW");
      }
      map.set(item.lineItemId, total);
    }
    return map;
  };

  const baselineTotal = totals(baselineDelivered, baselineWithheld);
  const selectedTotal = totals(delivered, withheld);

  if (baselineTotal.size !== selectedTotal.size) {
    throw new Error("RESERVATION_TOTAL_MISMATCH");
  }

  for (const [id, quantity] of baselineTotal) {
    if (selectedTotal.get(id) !== quantity) {
      throw new Error("RESERVATION_QUANTITY_MISMATCH");
    }
  }

  const selectedDelivered = new Map(
    delivered.map(line => [line.lineItemId, line.quantity])
  );

  for (const line of baselineWithheld) {
    if (selectedDelivered.has(line.lineItemId)) {
      throw new Error("AGE_RESTRICTION_BYPASS");
    }
  }

  const canonical = JSON.stringify({
    shopifyOrderId,
    staffUserId: input.staffUserId,
    reason: input.reason,
    delivered,
    withheld,
  });

  return createHash("sha256")
    .update(canonical)
    .digest("hex");
}

// Must only be called INSIDE the same shared order lock
// used by the existing normal-delivery completion service.
// Caller must refresh Shopify, verify driver authorization,
// validate payment/workflow and run V1584+V1585 before calling.
// This function never obtains a lock on its own.
export async function persistSelectionUnderLockV1589(
  db: ReservationClientV1589,
  input: ReservationInputV1589
): Promise<{
  ok: true;
  selectionHash: string;
  mode: "RESERVED_NOT_DELIVERED";
}> {
  const selectionHash = fingerprintSelectionV1589(input);

  let started = false;

  try {
    await db.query("BEGIN");
    started = true;

    const availability = await db.query(`
      SELECT
        to_regclass('alo_now_handoff_ledger')::text AS handoff,
        to_regclass('alo_now_partial_selections_v1586')::text
          AS selections,
        to_regclass('alo_now_fulfillment_journal_v1586')::text
          AS journal
    `);

    const tables = availability.rows[0];

    if (
      !tables?.handoff ||
      !tables?.selections ||
      !tables?.journal
    ) {
      throw new Error("PARTIAL_HANDOFF_SCHEMA_NOT_INSTALLED");
    }

    const row = await db.query(`
      SELECT assigned_driver_user_id,
             delivery_status,
             age_verification_status
      FROM alo_now_deliveries
      WHERE shopify_order_id = $1
      FOR UPDATE
    `, [input.shopifyOrderId]);

    const delivery = row.rows[0];

    if (!delivery) {
      throw new Error("DELIVERY_NOT_FOUND");
    }

    if (
      String(delivery.assigned_driver_user_id) !==
      input.staffUserId
    ) {
      throw new Error("NOT_ASSIGNED_TO_DRIVER");
    }

    if (delivery.delivery_status !== "ON_THE_WAY") {
      throw new Error("DELIVERY_NOT_ON_THE_WAY");
    }

    if (
      delivery.age_verification_status === "VERIFIED_AT_HANDOFF"
    ) {
      throw new Error("AGE_VERIFICATION_ALREADY_COMPLETED");
    }

    const old = await db.query(`
      INSERT INTO alo_now_handoff_ledger (
        shopify_order_id,
        assigned_driver_user_id,
        verified_age_level,
        handoff_state,
        delivered_lines,
        withheld_lines,
        refusal_reason,
        settlement_state
      )
      VALUES (
        $1, $2::bigint, NULL, 'PREPARED',
        $3::jsonb, $4::jsonb, $5, 'NOT_STARTED'
      )
      ON CONFLICT (shopify_order_id) DO NOTHING
      RETURNING shopify_order_id
    `, [
      input.shopifyOrderId,
      input.staffUserId,
      JSON.stringify(input.selected.delivered),
      JSON.stringify(input.selected.withheld),
      input.reason,
    ]);

    if (old.rowCount !== 1) {
      throw new Error("PARTIAL_HANDOFF_ALREADY_EXISTS");
    }

    // ALO_NOW_V1595_IMMUTABLE_EXPECTED_FULFILLMENTS
    // Persist the complete, independently expected Shopify plan
    // in the same transaction as the individual journal rows.
    // ALO_NOW_V1601_PERSISTED_LINE_IDENTITIES
    // Every planned FO line must have exactly one original
    // Shopify LineItem identity. No guessed or client IDs.
    if (!Array.isArray(input.lineIdentities)) {
      throw new Error("MISSING_LINE_IDENTITY_SNAPSHOT");
    }

    const identityMap = new Map<string, string>();

    for (const item of input.lineIdentities) {
      const fo = identity(item.fulfillmentOrderId);
      const fol = identity(item.fulfillmentOrderLineItemId);
      const shopifyLine = identity(item.shopifyLineItemId);

      if (
        !/^gid:\/\/shopify\/FulfillmentOrder\/[1-9]\d*$/.test(fo) ||
        !/^gid:\/\/shopify\/FulfillmentOrderLineItem\/[1-9]\d*$/.test(fol) ||
        !/^gid:\/\/shopify\/LineItem\/[1-9]\d*$/.test(shopifyLine)
      ) {
        throw new Error("INVALID_SHOPIFY_LINE_IDENTITY");
      }

      const key = JSON.stringify([fo, fol]);

      if (identityMap.has(key)) {
        throw new Error("DUPLICATE_SHOPIFY_LINE_IDENTITY");
      }

      identityMap.set(key, shopifyLine);
    }

    let consumedIdentities = 0;
    const expectedFulfillments = input.fulfillmentPlan.map(
      entry => ({
        fulfillmentOrderId: entry.fulfillmentOrderId,
        fulfillmentOrderLineItems:
          entry.fulfillmentOrderLineItems.map(line => ({
            id: line.id,
            quantity: line.quantity,
            shopifyLineItemId: (() => {
              const key = JSON.stringify([
                entry.fulfillmentOrderId,
                line.id,
              ]);
              const mapped = identityMap.get(key);

              if (!mapped) {
                throw new Error("MISSING_ORIGINAL_LINE_MAPPING");
              }

              consumedIdentities++;
              return mapped;
            })(),
          })),
      })
    );

    if (consumedIdentities !== identityMap.size) {
      throw new Error("EXTRA_OR_UNUSED_LINE_IDENTITIES");
    }

    const selection = await db.query(`
      INSERT INTO alo_now_partial_selections_v1586 (
        shopify_order_id,
        driver_user_id,
        selection_hash,
        expected_fulfillments,
        selected_lines,
        withheld_lines,
        state
      )
      VALUES (
        $1, $2::bigint, $3,
        $4::jsonb, $5::jsonb, $6::jsonb, 'PREPARED'
      )
      ON CONFLICT (shopify_order_id) DO NOTHING
      RETURNING shopify_order_id
    `, [
      input.shopifyOrderId,
      input.staffUserId,
      selectionHash,
      JSON.stringify(expectedFulfillments),
      JSON.stringify(input.selected.delivered),
      JSON.stringify(input.selected.withheld),
    ]);

    if (selection.rowCount !== 1) {
      throw new Error("SELECTION_ALREADY_EXISTS");
    }

    const seenOrders = new Set<string>();

    for (const entry of input.fulfillmentPlan) {
      const fulfillmentOrderId =
        identity(entry.fulfillmentOrderId);

      if (
        seenOrders.has(fulfillmentOrderId) ||
        !Array.isArray(entry.fulfillmentOrderLineItems) ||
        !entry.fulfillmentOrderLineItems.length
      ) {
        throw new Error("INVALID_JOURNAL_ALLOCATION");
      }

      seenOrders.add(fulfillmentOrderId);

      const payload = {
        shopifyOrderId: input.shopifyOrderId,
        fulfillmentOrderId,
        selectionHash,
        lines: entry.fulfillmentOrderLineItems,
      };

      const payloadHash =
        fingerprintJournalPayloadV1586(payload);

      const journal = await db.query(`
        INSERT INTO alo_now_fulfillment_journal_v1586 (
          shopify_order_id,
          fulfillment_order_id,
          selection_hash,
          payload_hash,
          fulfillment_lines,
          state
        )
        VALUES (
          $1, $2, $3, $4, $5::jsonb, 'PREPARED'
        )
        ON CONFLICT (
          shopify_order_id, fulfillment_order_id
        ) DO NOTHING
        RETURNING shopify_order_id
      `, [
        input.shopifyOrderId,
        fulfillmentOrderId,
        selectionHash,
        payloadHash,
        JSON.stringify(entry.fulfillmentOrderLineItems),
      ]);

      if (journal.rowCount !== 1) {
        throw new Error("JOURNAL_ALREADY_EXISTS");
      }
    }

    await db.query("COMMIT");
    started = false;

    return {
      ok: true,
      selectionHash,
      mode: "RESERVED_NOT_DELIVERED",
    };
  } catch (error) {
    if (started) {
      try {
        await db.query("ROLLBACK");
      } catch {
        throw new Error(
          "RESERVATION_ROLLBACK_UNCERTAIN_RECONCILE_REQUIRED"
        );
      }
    }
    throw error;
  }
}
