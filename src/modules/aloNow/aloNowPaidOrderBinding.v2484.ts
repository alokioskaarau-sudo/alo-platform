/**
 * V2484: Read-only routing of a paid Shopify Order.
 * No Shopify calls, payments, printing or delivery writes.
 * Ambiguous matches fail closed.
 */
const ORDER = /^gid:\/\/shopify\/Order\/([1-9][0-9]*)$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  request_id: string;
  payment_order_id: string | null;
  intent_order_id: string | null;
  workspace: string;
};

type Reader = {
  query(
    sql: string,
    params: string[]
  ): Promise<{ rows: Row[] }>;
};

export type PaidBindingV2484 =
  | { kind: "WEBSHOP" }
  | {
      kind: "ALO_NOW";
      requestId: string;
      orderId: string;
      workspace: "AARAU";
    }
  | { kind: "BLOCKED"; reason: string };

export async function resolvePaidOrderBindingV2484(
  orderId: string,
  reader: Reader
): Promise<PaidBindingV2484> {
  const match = ORDER.exec(orderId);
  if (!match)
    return { kind: "BLOCKED", reason: "INVALID_ORDER_ID" };

  const numeric = match[1];

  let rows: Row[];
  try {
    const result = await reader.query(
      `SELECT
         p.request_id::text AS request_id,
         p.shopify_order_id AS payment_order_id,
         i.shopify_order_id AS intent_order_id,
         r.workspace
       FROM alo_now_payment_states p
       JOIN alo_now_order_requests r
         ON r.id = p.request_id
       LEFT JOIN alo_now_checkout_intents i
         ON i.request_id = p.request_id
       WHERE p.shopify_order_id IN ($1,$2)
          OR i.shopify_order_id IN ($1,$2)
       LIMIT 3`,
      [orderId, numeric]
    );
    if (!Array.isArray(result.rows))
      throw new Error("INVALID_QUERY_RESULT");
    rows = result.rows;
  } catch {
    return { kind: "BLOCKED", reason: "LOOKUP_UNAVAILABLE" };
  }

  if (rows.length === 0)
    return { kind: "WEBSHOP" };

  if (rows.length !== 1)
    return { kind: "BLOCKED", reason: "AMBIGUOUS_BINDING" };

  const row = rows[0];

  const sameOrder = (value: unknown) =>
    value === orderId || value === numeric;

  if (
    !UUID.test(row.request_id ?? "") ||
    !sameOrder(row.payment_order_id) ||
    !sameOrder(row.intent_order_id)
  ) {
    return { kind: "BLOCKED", reason: "BINDING_MISMATCH" };
  }

  if (row.workspace !== "AARAU")
    return { kind: "BLOCKED", reason: "WORKSPACE_NOT_RELEASED" };

  return {
    kind: "ALO_NOW",
    requestId: row.request_id,
    orderId,
    workspace: "AARAU"
  };
}
