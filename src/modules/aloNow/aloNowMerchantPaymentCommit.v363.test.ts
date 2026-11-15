import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID, randomInt} from "node:crypto";
import {db} from "../../database/db.js";
import {
  commitVerifiedAloNowOnlinePayment
} from "./aloNowVerifiedPaymentCommit.js";
import type {
  ShopifyPaymentReader,
  ShopifyPaymentSnapshot
} from "./aloNowTrustedPaymentVerification.js";

// V363B: Validate database identity, not URL credentials.
let localDatabase = false;
try {
  const url = new URL(process.env.DATABASE_URL ?? "");
  localDatabase =
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    url.hostname === "127.0.0.1" &&
    url.port === "55433" &&
    url.pathname === "/alo_staff_test" &&
    url.search === "" &&
    url.hash === "";
} catch {
  localDatabase = false;
}

if (
  process.env.NODE_ENV !== "test" ||
  process.env.ALO_RUNTIME_MODE !== "local_test" ||
  !localDatabase
) throw new Error("V363_LOCAL_DATABASE_GUARD");

const created: string[] = [];

function orderId() {
  return "gid://shopify/Order/" +
    String(Date.now()) +
    String(randomInt(100000, 999999));
}

function trustedReader(
  id: string,
  amount = "14.40",
  financialStatus = "PAID"
): ShopifyPaymentReader {
  const snapshot = {
    id,
    cancelledAt: null,
    displayFinancialStatus: financialStatus,
    totalPriceSet: {
      shopMoney: {
        amount,
        currencyCode: "CHF"
      }
    },
    totalOutstandingSet: {
      shopMoney: {
        amount: "0.00",
        currencyCode: "CHF"
      }
    },
    totalRefundedSet: {
      shopMoney: {
        amount: "0.00",
        currencyCode: "CHF"
      }
    }
  } as ShopifyPaymentSnapshot;

  return async (requestedId: string) => {
    assert.equal(requestedId, id);
    return snapshot;
  };
}

async function fixture(expired = false) {
  const id = randomUUID();
  const order = orderId();
  const reference = randomUUID();
  const client = await db.connect();

  let transaction = false;
  try {
    await client.query("BEGIN");
    transaction = true;

    await client.query(
      `INSERT INTO alo_now_order_requests
       (id,client_request_id,workspace,delivery_address,
        items,quote_status,road_distance_km,status,
        verified_subtotal_chf,verified_at,
        quoted_delivery_fee_chf)
       VALUES ($1,$2,'AARAU','V363 LOCAL ONLY',
         '[]'::jsonb,'STANDARD',1,'PENDING_REVIEW',
         9.90,NOW(),4.50)`,
      [id, "V363-" + id]
    );

    await client.query(
      `INSERT INTO alo_now_merchant_acceptances
       (request_id,fulfillment_method,accepted_by,
        assigned_driver_id,capacity_confirmed_at,
        capacity_confirmed_until)
       VALUES ($1,'INTERNAL_DELIVERY','v363-local-test',
         NULL,NOW() - INTERVAL '2 minutes',
         CASE WHEN $2::boolean
           THEN NOW() - INTERVAL '1 minute'
           ELSE NOW() + INTERVAL '10 minutes'
         END)`,
      [id, expired]
    );

    await client.query(
      `INSERT INTO alo_now_payment_states
       (id,request_id,phase,payment_method,version,
        shopify_order_id)
       VALUES ($1,$2,'AWAITING_PAYMENT','ONLINE',1,$3)`,
      [randomUUID(), id, order]
    );

    await client.query("COMMIT");
    transaction = false;
    created.push(id);

    return {id, order};
  } catch (error) {
    if (transaction)
      await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function payment(id: string) {
  const result = await db.query<{
    phase: string;
    version: number;
  }>(
    `SELECT phase,version
     FROM alo_now_payment_states
     WHERE request_id=$1`,
    [id]
  );
  return result.rows[0];
}

async function events(id: string) {
  const result = await db.query<{n: string}>(
    `SELECT count(*)::text AS n
     FROM alo_now_payment_events e
     JOIN alo_now_payment_states p
       ON p.id=e.payment_state_id
     WHERE p.request_id=$1`,
    [id]
  );
  return Number(result.rows[0].n);
}

async function reconciliations(id: string) {
  const result = await db.query<{n: string}>(
    `SELECT count(*)::text AS n
     FROM alo_now_payment_reconciliations
     WHERE request_id=$1`,
    [id]
  );
  return Number(result.rows[0].n);
}

async function cleanup() {
  for (const id of created.reverse()) {
    const client = await db.connect();
    let active = false;
    try {
      await client.query("BEGIN");
      active = true;

      await client.query(
        `DELETE FROM alo_now_payment_events
         WHERE payment_state_id IN (
           SELECT id FROM alo_now_payment_states
           WHERE request_id=$1
         )`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_payment_reconciliations
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_merchant_acceptances
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_checkout_intents
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_payment_states
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_order_requests
         WHERE id=$1`, [id]
      );

      await client.query("COMMIT");
      active = false;
    } finally {
      if (active)
        await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
}

test("V363 real PostgreSQL payment commit", async () => {
  try {
    const valid = await fixture();
    const reader = trustedReader(valid.order);

    const first =
      await commitVerifiedAloNowOnlinePayment(
        valid.id, reader
      );

    assert.deepEqual(
      {ok:first.ok, action:first.ok ? first.action : null},
      {ok:true, action:"CONFIRMED"},
      "First confirmation: " + JSON.stringify(first)
    );
    assert.equal(
      (await payment(valid.id)).phase,
      "PAYMENT_CONFIRMED"
    );
    assert.equal(await events(valid.id), 1);

    const again =
      await commitVerifiedAloNowOnlinePayment(
        valid.id, reader
      );
    assert.equal(again.ok, true, JSON.stringify(again));
    if (again.ok)
      assert.equal(again.action, "ALREADY_CONFIRMED");
    assert.equal(await events(valid.id), 1);
    console.log("OK: ALO-Eigenlieferung PAYMENT_CONFIRMED.");
    console.log("OK: Doppelte Bestätigung ohne Doppelevent.");

    const expired = await fixture(true);
    const reconciliation =
      await commitVerifiedAloNowOnlinePayment(
        expired.id,
        trustedReader(expired.order)
      );

    assert.deepEqual(
      reconciliation,
      {ok:true, action:"RECONCILE"}
    );
    assert.equal(
      (await payment(expired.id)).phase,
      "AWAITING_PAYMENT"
    );
    assert.equal(await reconciliations(expired.id), 1);
    console.log("OK: Abgelaufene Lieferzusage RECONCILE.");

    const mismatch = await fixture();
    const wrong =
      await commitVerifiedAloNowOnlinePayment(
        mismatch.id,
        trustedReader(mismatch.order, "19.99")
      );
    assert.equal(wrong.ok, false);
    assert.equal(
      (await payment(mismatch.id)).phase,
      "AWAITING_PAYMENT"
    );
    assert.equal(await events(mismatch.id), 0);
    console.log("OK: Falscher Shopify-Betrag blockiert.");

    const unpaid = await fixture();
    const noPayment =
      await commitVerifiedAloNowOnlinePayment(
        unpaid.id,
        trustedReader(unpaid.order, "14.40", "PENDING")
      );
    assert.equal(noPayment.ok, false);
    assert.equal(
      (await payment(unpaid.id)).phase,
      "AWAITING_PAYMENT"
    );
    console.log("OK: Nicht bezahlter Auftrag blockiert.");

    // ALO_V1704_REAL_REFUND_CASES
    // All cases call the actual PostgreSQL payment commit.

    const refunded = await fixture();
    const refundBase = await trustedReader(
      refunded.order
    )(refunded.order);

    assert.ok(refundBase);

    const refundResult =
      await commitVerifiedAloNowOnlinePayment(
        refunded.id,
        async () => ({
          ...refundBase,
          totalRefundedSet: {
            shopMoney: {
              amount: "0.01",
              currencyCode: "CHF"
            }
          }
        })
      );

    assert.equal(refundResult.ok, false);
    assert.equal((await payment(refunded.id)).phase, "AWAITING_PAYMENT");
    assert.equal((await payment(refunded.id)).version, 1);
    assert.equal(await events(refunded.id), 0);
    assert.equal(await reconciliations(refunded.id), 0);
    console.log("OK: Refund CHF 0.01 blocks actual payment commit.");

    const missing = await fixture();
    const missingBase = await trustedReader(
      missing.order
    )(missing.order);

    assert.ok(missingBase);

    const missingResult =
      await commitVerifiedAloNowOnlinePayment(
        missing.id,
        async () => ({
          ...missingBase,
          totalRefundedSet: undefined
        })
      );

    assert.equal(missingResult.ok, false);
    assert.equal((await payment(missing.id)).phase, "AWAITING_PAYMENT");
    assert.equal((await payment(missing.id)).version, 1);
    assert.equal(await events(missing.id), 0);
    assert.equal(await reconciliations(missing.id), 0);
    console.log("OK: Missing refund evidence blocks payment commit.");

    const outstanding = await fixture();
    const outstandingBase = await trustedReader(
      outstanding.order
    )(outstanding.order);

    assert.ok(outstandingBase);

    const outstandingResult =
      await commitVerifiedAloNowOnlinePayment(
        outstanding.id,
        async () => ({
          ...outstandingBase,
          totalOutstandingSet: {
            shopMoney: {
              amount: "0.01",
              currencyCode: "CHF"
            }
          }
        })
      );

    assert.equal(outstandingResult.ok, false);
    assert.equal(
      (await payment(outstanding.id)).phase,
      "AWAITING_PAYMENT"
    );
    assert.equal((await payment(outstanding.id)).version, 1);
    assert.equal(await events(outstanding.id), 0);
    assert.equal(await reconciliations(outstanding.id), 0);
    console.log("OK: Outstanding CHF 0.01 blocks payment commit.");

  } finally {
    await cleanup();
    await db.end();
  }
});
