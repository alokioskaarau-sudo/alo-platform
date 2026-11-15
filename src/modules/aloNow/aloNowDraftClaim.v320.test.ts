import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import {
  createAloNowDraftClaimService
} from "./aloNowDraftClaimService.js";
import type {
  VerifiedAloCart
} from "./aloNowShopifyCartGuard.service.js";

const variantId = "gid://shopify/ProductVariant/123";
const item = {
  variantId,
  quantity: 2,
  unitPriceCHF: 4.95,
  title: "ALO V320 Testartikel"
};

const cart: VerifiedAloCart = {
  items: [item],
  subtotalCHF: 9.90,
  currency: "CHF"
};

const created: string[] = [];

async function fixture(options: {
  expired?: boolean;
  method?: string;
} = {}) {
  const id = randomUUID();
  const reference = randomUUID();

  const expiry = options.expired
    ? new Date(Date.now() - 60_000)
    : new Date(Date.now() + 600_000);

  const client = await db.connect();
  let active = false;

  try {
    await client.query("BEGIN");
    active = true;

    await client.query(`
      INSERT INTO alo_now_order_requests (
        id,client_request_id,workspace,
        delivery_address,items,quote_status,
        road_distance_km,status,
        driver_user_id,driver_accepted_at,
        reservation_expires_at,
        verified_subtotal_chf,verified_at,
        quoted_delivery_fee_chf
      )
      VALUES (
        $1,$2,'AARAU','V320 LOKALER TEST',
        $3::jsonb,'STANDARD',1,
        'DRIVER_ACCEPTED','v320-test-driver',
        NOW(),$4,9.90,NOW(),4.50
      )
    `, [
      id,
      "V320-" + id,
      JSON.stringify([item]),
      expiry
    ]);

    await client.query(`
      INSERT INTO alo_now_payment_states (
        id,request_id,phase,payment_method,version
      )
      VALUES ($1,$2,'AWAITING_PAYMENT',$3,1)
    `, [randomUUID(), id, options.method ?? "ONLINE"]);

    await client.query(`
      INSERT INTO alo_now_checkout_intents (
        request_id,checkout_reference
      )
      VALUES ($1,$2)
    `, [id, reference]);

    await client.query("COMMIT");
    active = false;
    created.push(id);

    return id;
  } catch (e) {
    if (active)
      await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup() {
  if (!created.length) return;

  const client = await db.connect();
  let active = false;

  try {
    await client.query("BEGIN");
    active = true;

    // Only delete rows whose request IDs were generated here.
    for (const id of created) {
      await client.query(
        `DELETE FROM alo_now_draft_operations
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
    }

    await client.query("COMMIT");
    active = false;

    const remaining = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM alo_now_order_requests
       WHERE id = ANY($1::uuid[])`,
      [created]
    );

    assert.equal(remaining.rows[0].total, 0);
    console.log("OK: V320-Testanfragen entfernt.");
  } catch (e) {
    if (active)
      await client.query("ROLLBACK").catch(() => {});

    console.error("CLEANUP FEHLGESCHLAGEN – IDs:");
    console.error(created.join("\n"));
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  console.log("===== V320 – ECHTER PG-INTEGRATIONSTEST =====");

  const identity = (await db.query(`
    SELECT current_database() AS name,
           host(inet_server_addr()) AS host,
           inet_server_port() AS port,
           current_user AS username
  `)).rows[0];

  assert.equal(identity.name, "alo_staff_test");
  assert.equal(identity.host, "127.0.0.1");
  assert.equal(Number(identity.port), 55433);
  assert.equal(identity.username, "maxim");

  console.log("OK: Ausschliesslich lokale Testdatenbank.");

  let cartReads = 0;

  const claim = createAloNowDraftClaimService(
    async () => {
      cartReads++;
      return cart;
    }
  );

  // Two requests compete to claim the same checkout.
  const firstId = await fixture();

  const attempts = await Promise.all([
    claim(firstId),
    claim(firstId)
  ]);

  const successes = attempts.filter(x => x.ok);
  const failures = attempts.filter(x => !x.ok);

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);

  assert.equal(
    failures[0].ok ? "" : failures[0].reason,
    "DRAFT_ALREADY_CLAIMED"
  );

  console.log("OK: Zwei parallele Claims, exakt einer erfolgreich.");

  const success = successes[0];
  assert.equal(success.ok, true);

  if (success.ok) {
    assert.equal(success.expectedTotalCHF, "14.40");
    assert.equal(
      success.graphql.variables.input.lineItems[0].quantity,
      2
    );
  }

  console.log("OK: Shopify-Payload und Gesamtbetrag korrekt.");

  const persisted = (await db.query(`
    SELECT status,attempt_id,
           expected_total_chf::text AS total
    FROM alo_now_draft_operations
    WHERE request_id=$1
  `, [firstId])).rows[0];

  assert.equal(persisted.status, "CREATING");
  assert.ok(persisted.attempt_id);
  assert.equal(persisted.total, "14.40");

  console.log("OK: Claim tatsächlich in PostgreSQL gespeichert.");

  const retry = await claim(firstId);

  assert.equal(retry.ok, false);
  if (!retry.ok)
    assert.equal(retry.reason, "DRAFT_ALREADY_CLAIMED");

  console.log("OK: Wiederholter Claim blockiert.");

  // Expired driver reservation.
  const expiredId = await fixture({expired:true});
  const expired = await claim(expiredId);

  assert.equal(expired.ok, false);
  if (!expired.ok)
    assert.equal(expired.reason, "DRIVER_RESERVATION_REQUIRED");

  console.log("OK: Abgelaufene Fahrerreservierung blockiert.");

  // Cart reader returns a different Shopify price.
  const changedId = await fixture();

  const changed = createAloNowDraftClaimService(
    async () => ({
      items:[{...item,unitPriceCHF:5.95}],
      subtotalCHF:11.90,
      currency:"CHF"
    })
  );

  const priceResult = await changed(changedId);

  assert.equal(priceResult.ok,false);
  if (!priceResult.ok)
    assert.equal(priceResult.reason,"CART_OR_TOTAL_CHANGED");

  console.log("OK: Preisänderung blockiert.");

  const noClaim = await db.query(`
    SELECT COUNT(*)::int AS total
    FROM alo_now_draft_operations
    WHERE request_id=$1
  `, [changedId]);

  assert.equal(noClaim.rows[0].total,0);
  console.log("OK: Kein Claim nach Preisänderung gespeichert.");

  // Wrong payment method must not claim an operation.
  const cashId = await fixture();

// AWAITING_DRIVER + NULL ist ein Zustand vor dem Zahlungsstart.
// Der Claim muss auch diesen Zustand ablehnen.
await db.query(
  `UPDATE alo_now_payment_states
   SET phase='AWAITING_DRIVER',
       payment_method=NULL
   WHERE request_id=$1`,
  [cashId]
);
  const cash = await claim(cashId);

  assert.equal(cash.ok,false);
  if (!cash.ok)
    assert.equal(cash.reason,"ONLINE_PAYMENT_NOT_READY");

  console.log("OK: Falsche Zahlungsart blockiert.");

  assert.ok(cartReads >= 4);

  console.log("===== V320 – ALLE INTEGRATIONSPRÜFUNGEN BESTANDEN =====");
}

try {
  await main();
} finally {
  try {
    await cleanup();
  } finally {
    await db.end();
  }
}
