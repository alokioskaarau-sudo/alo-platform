// ALO_NOW_V1653_LOCKED_PREFLIGHT
// No HTTP route, no fulfillment, no payment mutation.
// Injected PostgreSQL pool + trusted server-side readers.
// Uses one session and one advisory lock for the operation.

import {
  orderLockKeyV1643,
  type OrderLockPoolV1643,
} from "./aloNowOrderLock.v1643.js";

import {
  readReservedSnapshotV1645,
} from "./aloNowReservedSnapshot.v1645.js";

import {
  inspectCombinedPaymentV1652,
  type PaymentDependenciesV1652,
} from "./aloNowCombinedPaymentPrecheck.v1652.js";

type PreflightDependencies = {
  pool: OrderLockPoolV1643;
  payment?: Omit<PaymentDependenciesV1652, "db">;
  // V1657: create trusted readers using the lock-owning client.
  paymentForClient?: (
    client: Awaited<
      ReturnType<OrderLockPoolV1643["connect"]>
    >
  ) => Omit<PaymentDependenciesV1652, "db">;
};

export async function inspectLockedPreflightV1653(
  request: {
    shopifyOrderId: string;
    staffUserId: string;
  },
  dependencies: PreflightDependencies
): Promise<{
  ok: true;
  status: "PREFLIGHT_PASSED_NOT_AUTHORIZED";
  shopifyOrderId: string;
  requestId: string;
  expectedTotalRappen: number;
}> {
  const orderId = request?.shopifyOrderId;
  const driverId = request?.staffUserId;

  if (
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderId ?? "") ||
    !/^[1-9]\d*$/.test(driverId ?? "") ||
    typeof dependencies?.pool?.connect !== "function" ||
    !(
      typeof dependencies?.paymentForClient === "function" ||
      (
        typeof dependencies?.payment?.readShopifyPayment === "function" &&
        typeof dependencies?.payment?.readWorkflow === "function" &&
        typeof dependencies?.payment?.classifyFulfillment === "function"
      )
    )
  ) {
    throw new Error("INVALID_LOCKED_PREFLIGHT_REQUEST");
  }

  const key = orderLockKeyV1643(orderId);
  const client = await dependencies.pool.connect();

  let lockAttempted = false;
  let locked = false;
  let unlocked = false;
  let transaction = false;
  let destroy = false;

  try {
    lockAttempted = true;

    await client.query(
      "SELECT pg_advisory_lock($1::bigint)",
      [key]
    );

    locked = true;

    // V1645 opens and closes its own read-only transaction.
    // The order-wide advisory lock remains held.
    const snapshot = await readReservedSnapshotV1645(
      client,
      orderId,
      driverId
    );

    if (snapshot.shopifyOrderId !== orderId) {
      throw new Error("PREFLIGHT_SNAPSHOT_ORDER_MISMATCH");
    }

    // V1645 must finish its transaction before BEGIN here.
    await client.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    transaction = true;

    // V1657: trusted readers are bound to this same client.
    const paymentReaders =
      dependencies.paymentForClient
        ? dependencies.paymentForClient(client)
        : dependencies.payment;

    if (
      typeof paymentReaders?.readShopifyPayment !== "function" ||
      typeof paymentReaders?.readWorkflow !== "function" ||
      typeof paymentReaders?.classifyFulfillment !== "function"
    ) {
      throw new Error("INVALID_CLIENT_BOUND_PAYMENT_READERS");
    }

    const payment = await inspectCombinedPaymentV1652(
      orderId,
      {
        ...paymentReaders,
        db: client,
      }
    );

    await client.query("COMMIT");
    transaction = false;

    // Do not expose a dispatch plan or return permission to execute.
    return {
      ok: true,
      status: "PREFLIGHT_PASSED_NOT_AUTHORIZED",
      shopifyOrderId: orderId,
      requestId: payment.requestId,
      expectedTotalRappen: payment.expectedTotalRappen,
    };
  } catch (error) {
    if (transaction) {
      try {
        await client.query("ROLLBACK");
        transaction = false;
      } catch {
        destroy = true;
        throw new Error(
          "PREFLIGHT_ROLLBACK_UNCERTAIN"
        );
      }
    }

    if (
      error instanceof Error &&
      error.message ===
        "SNAPSHOT_ROLLBACK_UNCERTAIN_DESTROY_CLIENT"
    ) {
      destroy = true;
    }

    throw error;
  } finally {
    if (locked) {
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

    if (lockAttempted && !unlocked) {
      destroy = true;
    }

    client.release(destroy);

    if (locked && !unlocked) {
      throw new Error("PREFLIGHT_LOCK_RELEASE_UNCERTAIN");
    }
  }
}
