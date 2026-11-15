
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  getAssessedOrderRecoveryV398
} from "./orderRecoveryAssessed.v398.js";

test("V398 real PostgreSQL recovery assessment", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55433");
  assert.equal(url.pathname, "/alo_staff_test");

  const client = await db.connect();
  let transactionOpen = false;
  let destroy = false;

  try {
    const identity = await client.query(
      `SELECT current_database() AS database_name,
              inet_server_port() AS port`
    );

    assert.equal(identity.rows[0].database_name, "alo_staff_test");
    assert.equal(identity.rows[0].port, 55433);

    await client.query("BEGIN");
    transactionOpen = true;

    await client.query(
      "SET LOCAL statement_timeout='12s'"
    );
    await client.query(
      "SET LOCAL lock_timeout='2s'"
    );

    const orderId =
      "gid://shopify/Order/" +
      (BigInt(Date.now()) * 100000n + 398n);

    await client.query(
      `INSERT INTO shopify_webhook_events
       (webhook_id,topic,shopify_order_id,status,attempts)
       VALUES ($1,'orders/paid',$2,'PENDING',0)`,
      ["V398-" + randomUUID(), orderId]
    );

    const result = await getAssessedOrderRecoveryV398(
      orderId,
      client
    );

    assert.equal(result.detail.orderId, orderId);
    assert.equal(result.detail.snapshot?.pending_count, 1);
    assert.equal(
      result.detail.snapshot?.recovery_status,
      "PENDING_RECONCILIATION"
    );

    assert.equal(result.assessment.orderId, orderId);
    assert.equal(result.assessment.channel, "UNKNOWN");
    assert.equal(
      result.assessment.status,
      "INCOMPLETE_ARTIFACTS"
    );
    assert.ok(
      result.assessment.missing.includes(
        "COMPLETED_PAID_WEBHOOK"
      )
    );
    assert.ok(
      result.assessment.warnings.includes(
        "ORDER_CHANNEL_NOT_VERIFIED"
      )
    );
    assert.equal(
      result.assessment.automaticRetryAllowed,
      false
    );

    console.log("OK: Echter PostgreSQL-Webhook gelesen.");
    console.log("OK: V396-Diagnose korrekt verbunden.");
    console.log("OK: V397-Bewertung korrekt ausgeführt.");
    console.log("OK: Unbekannter Kanal nicht freigegeben.");

    const unknownId =
      "gid://shopify/Order/" +
      (BigInt(Date.now()) * 100000n + 399n);

    const missing = await getAssessedOrderRecoveryV398(
      unknownId,
      client
    );

    assert.equal(missing.detail.snapshot, null);
    assert.ok(
      missing.assessment.missing.includes(
        "PAID_WEBHOOK_EVIDENCE"
      )
    );
    assert.equal(
      missing.assessment.automaticRetryAllowed,
      false
    );

    console.log("OK: Bestellung ohne Webhook blockiert.");

    await assert.rejects(
      getAssessedOrderRecoveryV398("invalid", client),
      /INVALID_SHOPIFY_ORDER_ID/
    );

    console.log("OK: Ungültige Bestell-ID abgewiesen.");
    console.log("===== V398 INTEGRATION BESTANDEN =====");

  } finally {
    try {
      if (transactionOpen) {
        await client.query("ROLLBACK");
        console.log("OK: Testdaten zurückgerollt.");
      }
    } catch {
      destroy = true;
      throw new Error("V398_ROLLBACK_FAILED");
    } finally {
      client.release(destroy);
      await db.end();
    }
  }
});
