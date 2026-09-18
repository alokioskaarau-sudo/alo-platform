import { db } from "./db.js";

export type OrderAlertItem = {
  name: string;
  quantity: number;
};

export type OrderAlert = {
  id: string;
  shopify_order_id: string;
  shopify_order_name: string;
  total_amount: string;
  currency_code: string;
  fulfillment_type: string;
  items: OrderAlertItem[];
  status: string;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
};

export async function createOrderAlert(
  input: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    totalAmount: string;
    currencyCode: string;
    fulfillmentType: string;
    items: OrderAlertItem[];
  }
): Promise<{
  created: boolean;
  alert: OrderAlert;
}> {
  const result =
    await db.query<OrderAlert>(
      `
        INSERT INTO order_alerts (
          shopify_order_id,
          shopify_order_name,
          total_amount,
          currency_code,
          fulfillment_type,
          items,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          'PENDING'
        )
        ON CONFLICT (shopify_order_id)
        DO NOTHING
        RETURNING *
      `,
      [
        input.shopifyOrderId,
        input.shopifyOrderName,
        input.totalAmount,
        input.currencyCode,
        input.fulfillmentType,
        JSON.stringify(input.items),
      ]
    );

  if (result.rows[0]) {
    return {
      created: true,
      alert: result.rows[0],
    };
  }

  const existing =
    await db.query<OrderAlert>(
      `
        SELECT *
        FROM order_alerts
        WHERE shopify_order_id = $1
        LIMIT 1
      `,
      [input.shopifyOrderId]
    );

  if (!existing.rows[0]) {
    throw new Error(
      "Order Alert konnte nicht gespeichert werden."
    );
  }

  return {
    created: false,
    alert: existing.rows[0],
  };
}

export async function claimNextOrderAlert():
Promise<OrderAlert | null> {
  const result =
    await db.query<OrderAlert>(
      `
        WITH next_alert AS (
          SELECT id
          FROM order_alerts
          WHERE status = 'PENDING'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE order_alerts oa
        SET
          status = 'CLAIMED',
          claimed_at = NOW(),
          updated_at = NOW()
        FROM next_alert
        WHERE oa.id = next_alert.id
        RETURNING oa.*
      `
    );

  return result.rows[0] ?? null;
}

export async function completeOrderAlert(
  id: string
) {
  const result =
    await db.query<OrderAlert>(
      `
        UPDATE order_alerts
        SET
          status = 'COMPLETED',
          completed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id]
    );

  if (!result.rows[0]) {
    throw new Error(
      "Order Alert wurde nicht gefunden."
    );
  }

  return result.rows[0];
}
