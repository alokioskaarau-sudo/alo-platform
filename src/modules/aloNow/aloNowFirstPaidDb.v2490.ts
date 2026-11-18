/**
 * V2490: Read-only PostgreSQL adapter for first paid ALO NOW binding.
 * No writes, no order processing, no fulfillment.
 */

export type FirstPaidCheckoutRowV2490 = {
  request_id: string;
  checkout_reference: string;
  payment_order_id: string | null;
  intent_order_id: string | null;
  workspace: string;
  phase: string;
  payment_method: string;
};

export type FirstPaidQueryV2490 = {
  query(
    sql: string,
    params: string[]
  ): Promise<{ rows: FirstPaidCheckoutRowV2490[] }>;
};

export async function readFirstPaidCheckoutV2490(
  requestId: string,
  checkoutReference: string,
  database: FirstPaidQueryV2490
): Promise<FirstPaidCheckoutRowV2490[]> {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!uuid.test(requestId) || !uuid.test(checkoutReference))
    throw new Error("INVALID_CHECKOUT_IDENTITY");

  const result = await database.query(
    `SELECT
       r.id::text AS request_id,
       i.checkout_reference::text AS checkout_reference,
       p.shopify_order_id AS payment_order_id,
       i.shopify_order_id AS intent_order_id,
       r.workspace,
       p.phase,
       p.payment_method
     FROM alo_now_order_requests r
     JOIN alo_now_checkout_intents i
       ON i.request_id = r.id
     JOIN alo_now_payment_states p
       ON p.request_id = r.id
     WHERE r.id = $1::uuid
       AND i.checkout_reference = $2::uuid
     LIMIT 2`,
    [requestId, checkoutReference]
  );

  if (!Array.isArray(result.rows))
    throw new Error("INVALID_CHECKOUT_QUERY_RESULT");

  return result.rows;
}
