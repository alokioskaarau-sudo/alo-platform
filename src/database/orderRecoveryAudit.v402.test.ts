
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  getOrderRecoveryAuditV401
} from "./orderRecoveryAudit.v401.js";

test("V402 complete V401 PostgreSQL integration", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55433");
  assert.equal(url.pathname, "/alo_staff_test");

  const client = await db.connect();
  let active = false;
  let destroy = false;

  try {
    const identity = await client.query(
      `SELECT current_database() AS name,
              inet_server_port() AS port`
    );

    assert.equal(identity.rows[0].name, "alo_staff_test");
    assert.equal(identity.rows[0].port, 55433);

    await client.query("BEGIN");
    active = true;

    await client.query("SET LOCAL statement_timeout='12s'");
    await client.query("SET LOCAL lock_timeout='2s'");

    const base = BigInt(Date.now()) * 100000n;
    const orderId =
      "gid://shopify/Order/" + (base + 402n);

    const missingOrderId =
      "gid://shopify/Order/" + (base + 403n);

    await client.query(
      `INSERT INTO shopify_webhook_events
       (webhook_id,topic,shopify_order_id,status,attempts)
       VALUES ($1,'orders/paid',$2,'PENDING',0)`,
      ["V402-" + randomUUID(), orderId]
    );

    const label = await client.query(
      `INSERT INTO shipping_labels (
        shopify_order_id,
        shopify_order_name,
        label_mode,
        status,
        label_pdf_base64
      )
      VALUES ($1,$2,'PICKUP','COMPLETED','TESTPDF')
      RETURNING id`,
      [orderId, "V402-" + randomUUID()]
    );

    await client.query(
      `INSERT INTO print_jobs (
        shipping_label_id,document_type,status
      ) VALUES ($1,'SHIPPING_LABEL','PRINTED')`,
      [label.rows[0].id]
    );

    const result = await getOrderRecoveryAuditV401(
      orderId, client
    );

    assert.equal(result.orderId, orderId);
    assert.equal(result.detail.orderId, orderId);
    assert.equal(result.detail.snapshot?.pending_count, 1);
    assert.equal(result.automaticRetryAllowed, false);

    const pickupDocument =
      result.assessment.documentEvidence.find(
        d =>
          d.document_type === "SHIPPING_LABEL" &&
          d.label_mode === "PICKUP"
      );

    assert.ok(pickupDocument);
    assert.equal(pickupDocument.document_count, 1);
    assert.equal(pickupDocument.complete_documents, 1);
    assert.equal(pickupDocument.total_jobs, 1);
    assert.equal(pickupDocument.printed_jobs, 1);

    assert.equal(result.assessment.channel, "UNKNOWN");
    assert.ok(
      result.assessment.missing.includes(
        "COMPLETED_PAID_WEBHOOK"
      )
    );
    assert.equal(
      result.assessment.automaticRetryAllowed,
      false
    );

    console.log("OK: Webhook-Nachweis geladen.");
    console.log("OK: Abholbon geladen.");
    console.log("OK: PRINTED-Druckauftrag geladen.");
    console.log("OK: Unbekannter Kanal nicht freigegeben.");

    const missing = await getOrderRecoveryAuditV401(
      missingOrderId, client
    );

    assert.equal(missing.detail.snapshot, null);
    assert.deepEqual(
      missing.assessment.documentEvidence, []
    );
    assert.equal(missing.automaticRetryAllowed, false);

    console.log("OK: Nicht vorhandene Bestellung behandelt.");

    await assert.rejects(
      getOrderRecoveryAuditV401("invalid", client),
      /INVALID_SHOPIFY_ORDER_ID/
    );

    console.log("OK: Ungültige Shopify-ID abgewiesen.");
    console.log("===== V402 INTEGRATION BESTANDEN =====");

  } finally {
    try {
      if (active) {
        await client.query("ROLLBACK");
        console.log("OK: Testdaten zurückgerollt.");
      }
    } catch {
      destroy = true;
      throw new Error("V402_ROLLBACK_FAILED");
    } finally {
      client.release(destroy);
      await db.end();
    }
  }
});
