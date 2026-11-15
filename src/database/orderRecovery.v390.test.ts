
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  getOrderRecoverySnapshotV390
} from "./orderRecovery.v388.js";

test("V390 single order recovery", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55433");
  assert.equal(url.pathname, "/alo_staff_test");

  const client = await db.connect();
  let opened = false;

  try {
    const identity = await client.query(
      `SELECT current_database() AS database,
              inet_server_port() AS port`
    );

    assert.equal(identity.rows[0].database, "alo_staff_test");
    assert.equal(identity.rows[0].port, 55433);

    await client.query("BEGIN");
    opened = true;
    await client.query("SET LOCAL statement_timeout='12s'");

    const base = BigInt(Date.now()) * 1000n;
    const orderA =
      "gid://shopify/Order/" + (base + 11n);
    const orderB =
      "gid://shopify/Order/" + (base + 12n);

    for (const orderId of [orderA, orderB]) {
      await client.query(
        `INSERT INTO shopify_webhook_events
          (webhook_id,topic,shopify_order_id,status,attempts)
         VALUES ($1,'orders/paid',$2,'PENDING',0)`,
        ["V390-" + randomUUID(), orderId]
      );
    }

    const snapshot = await getOrderRecoverySnapshotV390(
      orderB,
      client
    );

    assert.ok(snapshot);
    assert.equal(snapshot.order_id, orderB);
    assert.equal(snapshot.webhook_count, 1);
    assert.equal(
      snapshot.recovery_status,
      "PENDING_RECONCILIATION"
    );

    console.log("OK: Einzelbestellung korrekt gefunden.");
    console.log("OK: Andere Bestellung nicht verwechselt.");

    const missing =
      "gid://shopify/Order/" + (base + 99n);

    assert.equal(
      await getOrderRecoverySnapshotV390(missing, client),
      null
    );

    console.log("OK: Unbekannte Bestellung ergibt null.");

    await assert.rejects(
      getOrderRecoverySnapshotV390("123", client),
      /INVALID_SHOPIFY_ORDER_ID/
    );

    console.log("OK: Ungültige Shopify-ID abgewiesen.");

  } finally {
    try {
      if (opened) {
        await client.query("ROLLBACK");
        console.log("OK: Testdaten zurückgerollt.");
      }
    } finally {
      client.release();
      await db.end();
    }
  }
});
