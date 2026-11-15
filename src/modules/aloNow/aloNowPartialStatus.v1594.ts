// ALO_NOW_V1594_READ_ONLY_STATUS
// Journal-only status. No execution authority.
// No writes to deliveries, Shopify, settlements or journals.

import {db} from "../../database/db.js";
import {getAloNowDelivery} from "../../database/aloNowDeliveries.js";
import {
  inspectPartialCompletionV1593,
} from "./aloNowPartialCompletionGate.v1593.js";

export async function readPartialHandoffStatusV1594(
  shopifyOrderId: string,
  staffUserId: string
) {
  if (
    typeof shopifyOrderId !== "string" ||
    !shopifyOrderId.trim() ||
    typeof staffUserId !== "string" ||
    !/^[1-9]\d*$/.test(staffUserId)
  ) {
    throw new Error("INVALID_STATUS_REQUEST");
  }

  const delivery = await getAloNowDelivery(shopifyOrderId);

  if (!delivery) {
    throw new Error("DELIVERY_NOT_FOUND");
  }

  if (
    String(delivery.assigned_driver_user_id) !==
    staffUserId
  ) {
    throw new Error("NOT_ASSIGNED_TO_DRIVER");
  }

  const client = await db.connect();
  let transaction = false;
  let healthy = true;

  try {
    await client.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    transaction = true;

    const schema = await client.query(`
      SELECT
        to_regclass('alo_now_partial_selections_v1586')::text
          AS selections,
        to_regclass('alo_now_fulfillment_journal_v1586')::text
          AS journal
    `);

    if (
      !schema.rows[0]?.selections ||
      !schema.rows[0]?.journal
    ) {
      await client.query("COMMIT");
      transaction = false;

      return {
        ok: true as const,
        status: "NOT_ENABLED" as const,
        executionEnabled: false as const,
      };
    }

    const selections = await client.query(`
      SELECT selection_hash, state, expected_fulfillments
      FROM alo_now_partial_selections_v1586
      WHERE shopify_order_id = $1
    `, [shopifyOrderId]);

    if (selections.rows.length > 1) {
      throw new Error("DUPLICATE_SELECTION");
    }

    if (!selections.rows.length) {
      await client.query("COMMIT");
      transaction = false;

      return {
        ok: true as const,
        status: "NOT_RESERVED" as const,
        executionEnabled: false as const,
      };
    }

    const selection = selections.rows[0];

    const journals = await client.query(`
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

    // ALO_NOW_V1595_IMMUTABLE_EXPECTED_FULFILLMENTS
    // The independent manifest is the authority.
    // NEVER derive expected rows from existing journal rows.
    const expected = selection.expected_fulfillments;

    if (
      !Array.isArray(expected) ||
      expected.length === 0
    ) {
      throw new Error("MISSING_EXPECTED_FULFILLMENT_MANIFEST");
    }

    const decision = inspectPartialCompletionV1593({
      shopifyOrderId,
      selectionHash: selection.selection_hash,
      expectedFulfillments: expected,
      journal: journals.rows.map((row: any) => ({
        fulfillmentOrderId: row.fulfillment_order_id,
        selectionHash: row.selection_hash,
        payloadHash: row.payload_hash,
        state: row.state,
        shopifyFulfillmentId: row.shopify_fulfillment_id,
      })),
    });

    await client.query("COMMIT");
    transaction = false;

    return {
      ok: true as const,
      status: decision.decision,
      selectionState: String(selection.state),
      confirmedCount: decision.confirmedCount,
      totalCount: decision.totalCount,
      unresolvedCount:
        decision.unresolvedFulfillmentOrderIds.length,
      shopifyReconciled: false as const,
      settlementCompleted: false as const,
      executionEnabled: false as const,
    };
  } catch (error) {
    if (transaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        healthy = false;
      }
    }
    throw error;
  } finally {
    client.release(!healthy);
  }
}
