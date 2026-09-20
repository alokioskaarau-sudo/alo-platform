import { db } from "./db.js";

export type OrderPackItem = {
  shopify_order_id: string;
  shopify_line_item_id: string;

  title: string;
  variant_title: string | null;
  sku: string | null;

  expected_quantity: number;
  packed_quantity: number;

  unavailable_quantity: number;

  unavailable_reason: string | null;

  unavailable_by_staff_user_id:
    | string
    | null;

  unavailable_at: Date | null;

  shopify_inventory_item_id:
    | string
    | null;

  inventory_zero_sync_status:
    | "PENDING"
    | "SYNCED"
    | "FAILED"
    | null;

  inventory_zero_synced_at:
    | Date
    | null;

  inventory_zero_error:
    | string
    | null;

  last_packed_by_staff_user_id:
    | string
    | null;

  last_packed_at: Date | null;

  created_at: Date;
  updated_at: Date;
};

export type ShopifyPackLineItem = {
  id: string;
  name: string;
  quantity: number;
  sku?: string | null;

  variant?: {
    title?: string | null;
    inventoryItem?: {
      id?: string | null;
    } | null;
  } | null;
};


/*
 * Shopify-Positionen idempotent in den lokalen
 * Packzustand synchronisieren.
 *
 * WICHTIG:
 * packed_quantity wird bei einem Konflikt NICHT
 * zurückgesetzt.
 */
export async function syncOrderPackItems(
  shopifyOrderId: string,
  lineItems: ShopifyPackLineItem[]
): Promise<OrderPackItem[]> {
  const orderId =
    String(shopifyOrderId || "").trim();

  if (!orderId) {
    throw new Error(
      "SHOPIFY_ORDER_ID_REQUIRED"
    );
  }

  for (const item of lineItems) {
    const lineItemId =
      String(item.id || "").trim();

    if (!lineItemId) {
      continue;
    }

    const title =
      String(item.name || "").trim() ||
      "Unbekannter Artikel";

    const expectedQuantity =
      Math.max(
        0,
        Math.trunc(
          Number(item.quantity) || 0
        )
      );

    const variantTitle =
      item.variant?.title
        ? String(item.variant.title)
        : null;

    const sku =
      item.sku
        ? String(item.sku)
        : null;

    const shopifyInventoryItemId =
      item.variant?.inventoryItem?.id
        ? String(
            item.variant.inventoryItem.id
          ).trim()
        : null;

    await db.query(
      `
        INSERT INTO order_pack_items (
          shopify_order_id,
          shopify_line_item_id,
          title,
          variant_title,
          sku,
          expected_quantity,
          shopify_inventory_item_id
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )

        ON CONFLICT (
          shopify_order_id,
          shopify_line_item_id
        )
        DO UPDATE SET
          title = EXCLUDED.title,
          variant_title =
            EXCLUDED.variant_title,
          sku = EXCLUDED.sku,

          expected_quantity =
            GREATEST(
              EXCLUDED.expected_quantity,
              order_pack_items.packed_quantity +
              order_pack_items.unavailable_quantity
            ),

          shopify_inventory_item_id =
            COALESCE(
              EXCLUDED.shopify_inventory_item_id,
              order_pack_items.shopify_inventory_item_id
            ),

          updated_at = NOW()
      `,
      [
        orderId,
        lineItemId,
        title,
        variantTitle,
        sku,
        expectedQuantity,
        shopifyInventoryItemId,
      ]
    );
  }

  return getOrderPackItems(orderId);
}


export async function getOrderPackItems(
  shopifyOrderId: string
): Promise<OrderPackItem[]> {
  const result =
    await db.query<OrderPackItem>(
      `
        SELECT
          shopify_order_id,
          shopify_line_item_id,
          title,
          variant_title,
          sku,
          expected_quantity,
          packed_quantity,
          unavailable_quantity,
          unavailable_reason,
          unavailable_by_staff_user_id,
          unavailable_at,
          shopify_inventory_item_id,
          inventory_zero_sync_status,
          inventory_zero_synced_at,
          inventory_zero_error,
          last_packed_by_staff_user_id,
          last_packed_at,
          created_at,
          updated_at
        FROM order_pack_items
        WHERE shopify_order_id = $1
        ORDER BY created_at ASC
      `,
      [shopifyOrderId]
    );

  return result.rows;
}


export async function isOrderFullyPacked(
  shopifyOrderId: string
): Promise<boolean> {
  const result =
    await db.query<{
      total_items: string;
      incomplete_items: string;
    }>(
      `
        SELECT
          COUNT(*)::text AS total_items,

          COUNT(*) FILTER (
            WHERE
              packed_quantity +
              unavailable_quantity <
              expected_quantity
          )::text AS incomplete_items

        FROM order_pack_items
        WHERE shopify_order_id = $1
      `,
      [shopifyOrderId]
    );

  const row = result.rows[0];

  const totalItems =
    Number(row?.total_items || 0);

  const incompleteItems =
    Number(row?.incomplete_items || 0);

  return (
    totalItems > 0 &&
    incompleteItems === 0
  );
}


export type AdjustPackItemResult =
  | {
      ok: true;
      item: OrderPackItem;
    }
  | {
      ok: false;
      reason:
        | "NOT_CLAIM_OWNER"
        | "ITEM_NOT_FOUND"
        | "LIMIT_REACHED";
    };


/*
 * Packmenge atomar um +1 oder -1 ändern.
 *
 * Der UPDATE läuft nur, wenn:
 * - die Bestellung diesem Staff gehört
 * - das Line Item existiert
 * - die neue Menge innerhalb 0..Soll liegt
 *
 * Dadurch kann die App keine absoluten,
 * veralteten Mengen überschreiben.
 */
export async function adjustOrderPackItem(
  shopifyOrderId: string,
  shopifyLineItemId: string,
  staffUserId: string,
  delta: 1 | -1
): Promise<AdjustPackItemResult> {
  const orderId =
    String(shopifyOrderId || "").trim();

  const lineItemId =
    String(shopifyLineItemId || "").trim();

  if (!orderId || !lineItemId) {
    return {
      ok: false,
      reason: "ITEM_NOT_FOUND",
    };
  }

  /*
   * Zuerst Besitz prüfen.
   * Der eigentliche Mengen-UPDATE prüft den
   * Besitzer danach NOCHMALS im SQL.
   */
  const ownership =
    await db.query<{
      claimed_by_staff_user_id:
        | string
        | null;
    }>(
      `
        SELECT
          claimed_by_staff_user_id
        FROM order_fulfillment_workflow
        WHERE shopify_order_id = $1
      `,
      [orderId]
    );

  if (
    ownership.rows[0]
      ?.claimed_by_staff_user_id !==
    staffUserId
  ) {
    return {
      ok: false,
      reason: "NOT_CLAIM_OWNER",
    };
  }

  const result =
    await db.query<OrderPackItem>(
      `
        UPDATE order_pack_items AS item
        SET
          packed_quantity =
            item.packed_quantity + $4,

          last_packed_by_staff_user_id =
            $3,

          last_packed_at = NOW(),
          updated_at = NOW()

        WHERE
          item.shopify_order_id = $1

          AND item.shopify_line_item_id =
            $2

          AND EXISTS (
            SELECT 1
            FROM order_fulfillment_workflow
            AS workflow
            WHERE
              workflow.shopify_order_id =
                item.shopify_order_id

              AND
                workflow.claimed_by_staff_user_id =
                $3
          )

          AND
            item.packed_quantity + $4 >= 0

          AND
            item.packed_quantity + $4 +
            item.unavailable_quantity <=
            item.expected_quantity

        RETURNING
          item.shopify_order_id,
          item.shopify_line_item_id,
          item.title,
          item.variant_title,
          item.sku,
          item.expected_quantity,
          item.packed_quantity,
          item.unavailable_quantity,
          item.unavailable_reason,
          item.unavailable_by_staff_user_id,
          item.unavailable_at,
          item.shopify_inventory_item_id,
          item.inventory_zero_sync_status,
          item.inventory_zero_synced_at,
          item.inventory_zero_error,
          item.last_packed_by_staff_user_id,
          item.last_packed_at,
          item.created_at,
          item.updated_at
      `,
      [
        orderId,
        lineItemId,
        staffUserId,
        delta,
      ]
    );

  if (result.rows[0]) {
    return {
      ok: true,
      item: result.rows[0],
    };
  }

  /*
   * Kein UPDATE:
   * unterscheiden zwischen unbekanntem Item
   * und bereits erreichtem Mengenlimit.
   */
  const item =
    await db.query<OrderPackItem>(
      `
        SELECT
          shopify_order_id,
          shopify_line_item_id,
          title,
          variant_title,
          sku,
          expected_quantity,
          packed_quantity,
          unavailable_quantity,
          unavailable_reason,
          unavailable_by_staff_user_id,
          unavailable_at,
          shopify_inventory_item_id,
          inventory_zero_sync_status,
          inventory_zero_synced_at,
          inventory_zero_error,
          last_packed_by_staff_user_id,
          last_packed_at,
          created_at,
          updated_at
        FROM order_pack_items
        WHERE
          shopify_order_id = $1
          AND shopify_line_item_id = $2
      `,
      [
        orderId,
        lineItemId,
      ]
    );

  if (!item.rows[0]) {
    return {
      ok: false,
      reason: "ITEM_NOT_FOUND",
    };
  }

  return {
    ok: false,
    reason: "LIMIT_REACHED",
  };
}


// ============================================================
// FEHLARTIKEL / NICHT VERFÜGBAR
// ============================================================

export type MarkPackItemUnavailableResult =
  | {
      ok: true;
      item: OrderPackItem;
      quantityMarked: number;
    }
  | {
      ok: false;
      reason:
        | "NOT_CLAIM_OWNER"
        | "ITEM_NOT_FOUND"
        | "INVALID_QUANTITY"
        | "LIMIT_REACHED"
        | "INVENTORY_ITEM_MISSING";
    };


/*
 * Markiert eine noch nicht gepackte Menge als
 * physisch nicht verfügbar.
 *
 * WICHTIG:
 * - nur Claim-Besitzer
 * - atomare Mengenprüfung
 * - packed + unavailable darf Soll nie überschreiten
 * - Shopify Inventory Sync wird zunächst PENDING
 * - die eigentliche Shopify-API läuft danach separat
 */
export async function markOrderPackItemUnavailable(
  shopifyOrderId: string,
  shopifyLineItemId: string,
  staffUserId: string,
  quantity: number,
  reason?: string | null
): Promise<MarkPackItemUnavailableResult> {

  const orderId =
    String(shopifyOrderId || "").trim();

  const lineItemId =
    String(shopifyLineItemId || "").trim();

  const staffId =
    String(staffUserId || "").trim();

  const unavailableQuantity =
    Math.trunc(Number(quantity));

  const cleanReason =
    reason
      ? String(reason).trim().slice(0, 500)
      : null;

  if (
    !orderId ||
    !lineItemId
  ) {
    return {
      ok: false,
      reason: "ITEM_NOT_FOUND",
    };
  }

  if (
    !Number.isInteger(unavailableQuantity) ||
    unavailableQuantity <= 0
  ) {
    return {
      ok: false,
      reason: "INVALID_QUANTITY",
    };
  }

  /*
   * Der UPDATE selbst prüft Claim + Mengenlimit.
   * Dadurch ist die Aktion auch bei parallelen
   * Requests atomar.
   */
  const result =
    await db.query<OrderPackItem>(
      `
        UPDATE order_pack_items AS item

        SET
          unavailable_quantity =
            item.unavailable_quantity + $4,

          unavailable_reason =
            COALESCE(
              $5,
              item.unavailable_reason
            ),

          unavailable_by_staff_user_id =
            $3,

          unavailable_at =
            NOW(),

          inventory_zero_sync_status =
            'PENDING',

          inventory_zero_synced_at =
            NULL,

          inventory_zero_error =
            NULL,

          updated_at =
            NOW()

        WHERE
          item.shopify_order_id = $1

          AND
          item.shopify_line_item_id = $2

          AND
          item.shopify_inventory_item_id
            IS NOT NULL

          AND
          EXISTS (
            SELECT 1
            FROM order_fulfillment_workflow
              AS workflow
            WHERE
              workflow.shopify_order_id =
                item.shopify_order_id
              AND
              workflow.claimed_by_staff_user_id =
                $3
          )

          AND
          item.packed_quantity +
          item.unavailable_quantity +
          $4 <=
          item.expected_quantity

        RETURNING
          item.shopify_order_id,
          item.shopify_line_item_id,
          item.title,
          item.variant_title,
          item.sku,
          item.expected_quantity,
          item.packed_quantity,
          item.unavailable_quantity,
          item.unavailable_reason,
          item.unavailable_by_staff_user_id,
          item.unavailable_at,
          item.shopify_inventory_item_id,
          item.inventory_zero_sync_status,
          item.inventory_zero_synced_at,
          item.inventory_zero_error,
          item.last_packed_by_staff_user_id,
          item.last_packed_at,
          item.created_at,
          item.updated_at
      `,
      [
        orderId,
        lineItemId,
        staffId,
        unavailableQuantity,
        cleanReason,
      ]
    );

  if (result.rows[0]) {
    return {
      ok: true,
      item: result.rows[0],
      quantityMarked:
        unavailableQuantity,
    };
  }

  /*
   * Kein UPDATE:
   * Ursache sauber bestimmen.
   */
  const ownership =
    await db.query<{
      claimed_by_staff_user_id:
        | string
        | null;
    }>(
      `
        SELECT
          claimed_by_staff_user_id
        FROM order_fulfillment_workflow
        WHERE shopify_order_id = $1
      `,
      [orderId]
    );

  if (
    ownership.rows[0]
      ?.claimed_by_staff_user_id !==
    staffId
  ) {
    return {
      ok: false,
      reason: "NOT_CLAIM_OWNER",
    };
  }

  const itemResult =
    await db.query<OrderPackItem>(
      `
        SELECT
          shopify_order_id,
          shopify_line_item_id,
          title,
          variant_title,
          sku,
          expected_quantity,
          packed_quantity,
          unavailable_quantity,
          unavailable_reason,
          unavailable_by_staff_user_id,
          unavailable_at,
          shopify_inventory_item_id,
          inventory_zero_sync_status,
          inventory_zero_synced_at,
          inventory_zero_error,
          last_packed_by_staff_user_id,
          last_packed_at,
          created_at,
          updated_at
        FROM order_pack_items
        WHERE
          shopify_order_id = $1
          AND shopify_line_item_id = $2
        LIMIT 1
      `,
      [
        orderId,
        lineItemId,
      ]
    );

  const item =
    itemResult.rows[0];

  if (!item) {
    return {
      ok: false,
      reason: "ITEM_NOT_FOUND",
    };
  }

  if (!item.shopify_inventory_item_id) {
    return {
      ok: false,
      reason: "INVENTORY_ITEM_MISSING",
    };
  }

  return {
    ok: false,
    reason: "LIMIT_REACHED",
  };
}


// ============================================================
// SHOPIFY INVENTORY ZERO SYNC RESULT
// ============================================================

export async function markInventoryZeroSyncSuccess(
  shopifyOrderId: string,
  shopifyLineItemId: string
): Promise<OrderPackItem | null> {

  const result =
    await db.query<OrderPackItem>(
      `
        UPDATE order_pack_items
        SET
          inventory_zero_sync_status =
            'SYNCED',

          inventory_zero_synced_at =
            NOW(),

          inventory_zero_error =
            NULL,

          updated_at =
            NOW()

        WHERE
          shopify_order_id = $1
          AND shopify_line_item_id = $2

        RETURNING *
      `,
      [
        shopifyOrderId,
        shopifyLineItemId,
      ]
    );

  return result.rows[0] ?? null;
}


export async function markInventoryZeroSyncFailed(
  shopifyOrderId: string,
  shopifyLineItemId: string,
  errorMessage: string
): Promise<OrderPackItem | null> {

  const cleanError =
    String(errorMessage || "")
      .trim()
      .slice(0, 2000);

  const result =
    await db.query<OrderPackItem>(
      `
        UPDATE order_pack_items
        SET
          inventory_zero_sync_status =
            'FAILED',

          inventory_zero_synced_at =
            NULL,

          inventory_zero_error =
            $3,

          updated_at =
            NOW()

        WHERE
          shopify_order_id = $1
          AND shopify_line_item_id = $2

        RETURNING *
      `,
      [
        shopifyOrderId,
        shopifyLineItemId,
        cleanError ||
          "Unbekannter Shopify Inventory Fehler",
      ]
    );

  return result.rows[0] ?? null;
}
