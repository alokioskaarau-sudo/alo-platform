import { db } from "./db.js";

export type OrderDiscountCodeStatus =
  | "PENDING"
  | "CREATING"
  | "ACTIVE"
  | "FAILED";

export type OrderDiscountCodeRecord = {
  id: string;

  shopify_order_id: string;
  shopify_order_name: string;

  code: string;
  shopify_discount_id: string | null;

  percentage: string;

  status: OrderDiscountCodeStatus;
  error_message: string | null;

  created_at: Date;
  updated_at: Date;
};

/* =========================================================
   FIND BY SHOPIFY ORDER
========================================================= */

export async function findOrderDiscountCode(
  shopifyOrderId: string
): Promise<OrderDiscountCodeRecord | null> {
  const result =
    await db.query<OrderDiscountCodeRecord>(
      `
        SELECT *
        FROM order_discount_codes
        WHERE shopify_order_id = $1
        LIMIT 1
      `,
      [shopifyOrderId]
    );

  return result.rows[0] ?? null;
}

/* =========================================================
   FIND BY CODE
========================================================= */

export async function findOrderDiscountCodeByCode(
  code: string
): Promise<OrderDiscountCodeRecord | null> {
  const result =
    await db.query<OrderDiscountCodeRecord>(
      `
        SELECT *
        FROM order_discount_codes
        WHERE code = $1
        LIMIT 1
      `,
      [code]
    );

  return result.rows[0] ?? null;
}

/* =========================================================
   RESERVE CODE FOR ORDER

   Wichtig:
   Eine Shopify-Bestellung darf nur EINEN Rabattcode
   erhalten. ON CONFLICT verhindert doppelte Codes bei
   parallelen Webhook-/Pipeline-Aufrufen.
========================================================= */

export async function reserveOrderDiscountCode(
  input: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    code: string;
    percentage?: number;
  }
): Promise<{
  created: boolean;
  record: OrderDiscountCodeRecord;
}> {
  const percentage =
    input.percentage ?? 0.15;

  const insert =
    await db.query<OrderDiscountCodeRecord>(
      `
        INSERT INTO order_discount_codes (
          shopify_order_id,
          shopify_order_name,
          code,
          percentage,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'PENDING'
        )

        ON CONFLICT (
          shopify_order_id
        )
        DO NOTHING

        RETURNING *
      `,
      [
        input.shopifyOrderId,
        input.shopifyOrderName,
        input.code,
        percentage,
      ]
    );

  if (insert.rows[0]) {
    return {
      created: true,
      record: insert.rows[0],
    };
  }

  const existing =
    await findOrderDiscountCode(
      input.shopifyOrderId
    );

  if (!existing) {
    throw new Error(
      "Rabattcode konnte nicht reserviert werden."
    );
  }

  return {
    created: false,
    record: existing,
  };
}

/* =========================================================
   MARK CREATING
========================================================= */

export async function markOrderDiscountCodeCreating(
  id: string
): Promise<OrderDiscountCodeRecord> {
  const result =
    await db.query<OrderDiscountCodeRecord>(
      `
        UPDATE order_discount_codes
        SET
          status = 'CREATING',
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Rabattcode-Datensatz nicht gefunden."
    );
  }

  return result.rows[0];
}

/* =========================================================
   COMPLETE / ACTIVE
========================================================= */

export async function completeOrderDiscountCode(
  id: string,
  shopifyDiscountId: string
): Promise<OrderDiscountCodeRecord> {
  const result =
    await db.query<OrderDiscountCodeRecord>(
      `
        UPDATE order_discount_codes
        SET
          shopify_discount_id = $2,
          status = 'ACTIVE',
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        shopifyDiscountId,
      ]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Rabattcode-Datensatz nicht gefunden."
    );
  }

  return result.rows[0];
}

/* =========================================================
   FAILED
========================================================= */

export async function failOrderDiscountCode(
  id: string,
  errorMessage: string
): Promise<void> {
  await db.query(
    `
      UPDATE order_discount_codes
      SET
        status = 'FAILED',
        error_message = $2,
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      id,
      errorMessage.slice(0, 2000),
    ]
  );
}
