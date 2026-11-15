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

test("V902 concurrent PostgreSQL payment commit", async () => {
  try {
    const valid = await fixture();
    const reader = trustedReader(valid.order);


    const results = await Promise.all([
      commitVerifiedAloNowOnlinePayment(valid.id, reader),
      commitVerifiedAloNowOnlinePayment(valid.id, reader)
    ]);

    const actions = results.map(result =>
      result.ok ? result.action : "FAILED"
    ).sort();

    assert.deepEqual(
      actions,
      ["ALREADY_CONFIRMED", "CONFIRMED"].sort(),
      "Parallele Commit-Ergebnisse: " + JSON.stringify(results)
    );

    assert.equal(
      (await payment(valid.id)).phase,
      "PAYMENT_CONFIRMED"
    );

    assert.equal(
      await events(valid.id),
      1,
      "Paralleler Commit darf genau ein Event erzeugen."
    );

    console.log("OK: Zwei parallele finale Commit-Aufrufe.");
    console.log("OK: Genau einmal CONFIRMED.");
    console.log("OK: Zweiter Aufruf ALREADY_CONFIRMED.");
    console.log("OK: Genau ein Payment-Event.");


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
  } finally {
    await cleanup();
    await db.end();
  }
});
