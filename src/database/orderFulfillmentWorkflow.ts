import { db } from "./db.js";

export type OrderPackStatus =
  | "NEW"
  | "PACKING"
  | "PACKED"
  | "READY_TO_SHIP"
  | "COMPLETED";

export type OrderFulfillmentWorkflow = {
  shopify_order_id: string;
  pack_status: OrderPackStatus;

  claimed_by_staff_user_id: string | null;
  claimed_at: Date | null;

  packing_started_at: Date | null;
  packed_at: Date | null;
  ready_to_ship_at: Date | null;
  completed_at: Date | null;

  version: number;
  created_at: Date;
  updated_at: Date;
};

export async function getOrderFulfillmentWorkflow(
  shopifyOrderId: string
): Promise<OrderFulfillmentWorkflow | null> {
  const result =
    await db.query<OrderFulfillmentWorkflow>(
      `
        SELECT
          shopify_order_id,
          pack_status,
          claimed_by_staff_user_id,
          claimed_at,
          packing_started_at,
          packed_at,
          ready_to_ship_at,
          completed_at,
          version,
          created_at,
          updated_at
        FROM order_fulfillment_workflow
        WHERE shopify_order_id = $1
        LIMIT 1
      `,
      [shopifyOrderId]
    );

  return result.rows[0] ?? null;
}

export async function ensureOrderFulfillmentWorkflow(
  shopifyOrderId: string
): Promise<OrderFulfillmentWorkflow> {
  const result =
    await db.query<OrderFulfillmentWorkflow>(
      `
        INSERT INTO order_fulfillment_workflow (
          shopify_order_id
        )
        VALUES ($1)
        ON CONFLICT (shopify_order_id)
        DO UPDATE SET
          shopify_order_id =
            EXCLUDED.shopify_order_id
        RETURNING
          shopify_order_id,
          pack_status,
          claimed_by_staff_user_id,
          claimed_at,
          packing_started_at,
          packed_at,
          ready_to_ship_at,
          completed_at,
          version,
          created_at,
          updated_at
      `,
      [shopifyOrderId]
    );

  return result.rows[0];
}

export type ClaimOrderResult =
  | {
      ok: true;
      workflow: OrderFulfillmentWorkflow;
      alreadyClaimedByMe: boolean;
    }
  | {
      ok: false;
      reason: "CLAIMED_BY_OTHER";
      workflow: OrderFulfillmentWorkflow;
    };

export async function claimOrderForPacking(
  shopifyOrderId: string,
  staffUserId: string
): Promise<ClaimOrderResult> {
  const existing =
    await ensureOrderFulfillmentWorkflow(
      shopifyOrderId
    );

  const alreadyClaimedByMe =
    existing.claimed_by_staff_user_id ===
    staffUserId;

  const result =
    await db.query<OrderFulfillmentWorkflow>(
      `
        UPDATE order_fulfillment_workflow
        SET
          claimed_by_staff_user_id = $2,
          claimed_at =
            CASE
              WHEN claimed_by_staff_user_id = $2
                THEN claimed_at
              ELSE NOW()
            END,
          pack_status =
            CASE
              WHEN pack_status = 'NEW'
                THEN 'PACKING'
              ELSE pack_status
            END,
          packing_started_at =
            CASE
              WHEN packing_started_at IS NULL
                THEN NOW()
              ELSE packing_started_at
            END,
          version = version + 1,
          updated_at = NOW()
        WHERE
          shopify_order_id = $1
          AND (
            claimed_by_staff_user_id IS NULL
            OR claimed_by_staff_user_id = $2
          )
        RETURNING
          shopify_order_id,
          pack_status,
          claimed_by_staff_user_id,
          claimed_at,
          packing_started_at,
          packed_at,
          ready_to_ship_at,
          completed_at,
          version,
          created_at,
          updated_at
      `,
      [
        shopifyOrderId,
        staffUserId,
      ]
    );

  if (result.rows[0]) {
    const workflow = result.rows[0];

    return {
      ok: true,
      workflow,
      alreadyClaimedByMe,
    };
  }

  const workflow =
    await getOrderFulfillmentWorkflow(
      shopifyOrderId
    );

  if (!workflow) {
    throw new Error(
      "ORDER_WORKFLOW_NOT_FOUND_AFTER_CLAIM"
    );
  }

  return {
    ok: false,
    reason: "CLAIMED_BY_OTHER",
    workflow,
  };
}

export async function releaseOrderClaim(
  shopifyOrderId: string,
  staffUserId: string
): Promise<OrderFulfillmentWorkflow | null> {
  const result =
    await db.query<OrderFulfillmentWorkflow>(
      `
        UPDATE order_fulfillment_workflow
        SET
          claimed_by_staff_user_id = NULL,
          claimed_at = NULL,
          pack_status =
            CASE
              WHEN pack_status = 'PACKING'
                THEN 'NEW'
              ELSE pack_status
            END,
          version = version + 1,
          updated_at = NOW()
        WHERE
          shopify_order_id = $1
          AND claimed_by_staff_user_id = $2
          AND pack_status IN (
            'NEW',
            'PACKING',
            'PACKED'
          )
        RETURNING
          shopify_order_id,
          pack_status,
          claimed_by_staff_user_id,
          claimed_at,
          packing_started_at,
          packed_at,
          ready_to_ship_at,
          completed_at,
          version,
          created_at,
          updated_at
      `,
      [
        shopifyOrderId,
        staffUserId,
      ]
    );

  return result.rows[0] ?? null;
}

export async function setOrderPackStatus(
  shopifyOrderId: string,
  staffUserId: string,
  status: OrderPackStatus
): Promise<OrderFulfillmentWorkflow | null> {
  const result =
    await db.query<OrderFulfillmentWorkflow>(
      `
        UPDATE order_fulfillment_workflow
        SET
          pack_status = $3,

          packing_started_at =
            CASE
              WHEN $3 = 'PACKING'
                AND packing_started_at IS NULL
                THEN NOW()
              ELSE packing_started_at
            END,

          packed_at =
            CASE
              WHEN $3 = 'PACKED'
                AND packed_at IS NULL
                THEN NOW()
              ELSE packed_at
            END,

          ready_to_ship_at =
            CASE
              WHEN $3 = 'READY_TO_SHIP'
                AND ready_to_ship_at IS NULL
                THEN NOW()
              ELSE ready_to_ship_at
            END,

          completed_at =
            CASE
              WHEN $3 = 'COMPLETED'
                AND completed_at IS NULL
                THEN NOW()
              ELSE completed_at
            END,

          version = version + 1,
          updated_at = NOW()

        WHERE
          shopify_order_id = $1
          AND claimed_by_staff_user_id = $2
          AND (
            (
              pack_status = 'PACKING'
              AND $3 = 'PACKED'
            )
            OR
            (
              pack_status = 'PACKED'
              AND $3 = 'READY_TO_SHIP'
            )
            OR
            (
              pack_status = 'READY_TO_SHIP'
              AND $3 = 'COMPLETED'
            )
          )

        RETURNING
          shopify_order_id,
          pack_status,
          claimed_by_staff_user_id,
          claimed_at,
          packing_started_at,
          packed_at,
          ready_to_ship_at,
          completed_at,
          version,
          created_at,
          updated_at
      `,
      [
        shopifyOrderId,
        staffUserId,
        status,
      ]
    );

  return result.rows[0] ?? null;
}


/*
 * Lädt die operativen Pack-Workflows für mehrere Bestellungen
 * in einem Query.
 *
 * Bewusst kein Query pro Bestellung, damit der Bestellmanager
 * auch bei vielen Orders schnell bleibt.
 */
export async function getOrderFulfillmentWorkflows(
  shopifyOrderIds: string[]
): Promise<OrderFulfillmentWorkflow[]> {
  const uniqueIds = [
    ...new Set(
      shopifyOrderIds
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    ),
  ];

  if (uniqueIds.length === 0) {
    return [];
  }

  const result =
    await db.query<OrderFulfillmentWorkflow>(
      `
        SELECT
          shopify_order_id,
          pack_status,
          claimed_by_staff_user_id,
          claimed_at,
          packing_started_at,
          packed_at,
          ready_to_ship_at,
          completed_at,
          version,
          created_at,
          updated_at
        FROM order_fulfillment_workflow
        WHERE shopify_order_id = ANY($1::text[])
      `,
      [uniqueIds]
    );

  return result.rows;
}
