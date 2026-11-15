// ALO_NOW_V1643B_PURE_ORDER_LOCK
// No production DB import. No HTTP or Shopify calls.

import {createHash} from "node:crypto";

export function orderLockKeyV1643(
  shopifyOrderId: string
): string {
  if (
    typeof shopifyOrderId !== "string" ||
    !shopifyOrderId.trim() ||
    shopifyOrderId !== shopifyOrderId.trim()
  ) {
    throw new Error("INVALID_SHOPIFY_ORDER_ID");
  }

  return createHash("sha256")
    .update("ALO_NOW_DELIVERY_COMPLETION_V1:")
    .update(shopifyOrderId)
    .digest()
    .readBigInt64BE(0)
    .toString();
}

export type OrderLockClientV1643 = {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{
    rows: any[];
    rowCount: number | null;
  }>;

  release(destroy?: boolean): void;
};

export type OrderLockPoolV1643 = {
  connect(): Promise<OrderLockClientV1643>;
};

export async function withOrderLockV1643<T>(
  shopifyOrderId: string,
  pool: OrderLockPoolV1643,
  operation: () => Promise<T>
): Promise<T> {
  const key = orderLockKeyV1643(shopifyOrderId);

  if (
    !pool ||
    typeof pool.connect !== "function" ||
    typeof operation !== "function"
  ) {
    throw new Error("INVALID_ORDER_LOCK_DEPENDENCIES");
  }

  const client = await pool.connect();
  let acquired = false;
  let acquisitionAttempted = false;
  let unlocked = false;

  try {
    // An interrupted acquisition can have an uncertain outcome.
    acquisitionAttempted = true;

    await client.query(
      "SELECT pg_advisory_lock($1::bigint)",
      [key]
    );

    acquired = true;

    return await operation();
  } finally {
    if (acquired) {
      try {
        const result = await client.query(
          "SELECT pg_advisory_unlock($1::bigint) AS released",
          [key]
        );

        unlocked = result.rows[0]?.released === true;
      } catch {
        unlocked = false;
      }
    }

    // Never reuse a connection with uncertain lock ownership.
    const destroy =
      acquisitionAttempted && !unlocked;

    client.release(destroy);

    if (acquired && !unlocked) {
      throw new Error(
        "ALO_NOW_ORDER_LOCK_RELEASE_UNCERTAIN"
      );
    }
  }
}
