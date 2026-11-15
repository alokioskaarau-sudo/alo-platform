
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  getOrderRecoveryDetailV396
} from "./orderRecoveryDetail.v396.js";

test("V396 unified order recovery", async () => {
  const u = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55433");
  assert.equal(u.pathname, "/alo_staff_test");

  const client = await db.connect();
  let active = false;
  let destroy = false;

  try {
    const identity = await client.query(
      `SELECT current_database() AS db_name,
              inet_server_port() AS port`
    );

    assert.equal(identity.rows[0].db_name, "alo_staff_test");
    assert.equal(identity.rows[0].port, 55433);

    await client.query("BEGIN");
    active = true;
    await client.query("SET LOCAL statement_timeout='12s'");
    await client.query("SET LOCAL lock_timeout='2s'");

    const base =
      BigInt(Date.now()) * 10000n;

    const pickup =
      "gid://shopify/Order/" + (base + 101n);
    const shipping =
      "gid://shopify/Order/" + (base + 102n);
    const unknown =
      "gid://shopify/Order/" + (base + 103n);

    async function fixture(orderId: string, mode: string, status: string) {
      await client.query(
        `INSERT INTO shopify_webhook_events
          (webhook_id,topic,shopify_order_id,status,attempts)
         VALUES ($1,'orders/paid',$2,'PENDING',0)`,
        ["V396-" + randomUUID(), orderId]
      );

      const label = await client.query(
        `INSERT INTO shipping_labels
          (shopify_order_id,shopify_order_name,label_mode,
           status,label_pdf_base64)
         VALUES ($1,$2,$3,'COMPLETED','TESTPDF')
         RETURNING id`,
        [orderId, "V396-" + randomUUID(), mode]
      );

      await client.query(
        `INSERT INTO print_jobs
          (shipping_label_id,document_type,status)
         VALUES ($1,'SHIPPING_LABEL',$2)`,
        [label.rows[0].id, status]
      );
    }

    await fixture(pickup, "PICKUP", "PRINTED");
    await fixture(shipping, "LIVE", "PENDING");

    const a = await getOrderRecoveryDetailV396(pickup, client);
    const b = await getOrderRecoveryDetailV396(shipping, client);
    const c = await getOrderRecoveryDetailV396(unknown, client);

    assert.equal(a.orderId, pickup);
    assert.equal(a.snapshot?.recovery_status, "PENDING_RECONCILIATION");
    assert.equal(a.labels.length, 1);
    assert.equal(a.labels[0].label_mode, "PICKUP");
    assert.equal(a.labels[0].recovery_status, "PRINT_RECORDED");

    assert.equal(b.orderId, shipping);
    assert.equal(b.snapshot?.recovery_status, "PENDING_RECONCILIATION");
    assert.equal(b.labels.length, 1);
    assert.equal(b.labels[0].label_mode, "LIVE");
    assert.equal(b.labels[0].recovery_status, "PRINT_QUEUED");

    assert.equal(c.snapshot, null);
    assert.deepEqual(c.labels, []);
    assert.equal(
      c.diagnosticStatus,
      "NO_PAID_WEBHOOK_EVIDENCE"
    );

    await assert.rejects(
      getOrderRecoveryDetailV396("invalid", client),
      /INVALID_SHOPIFY_ORDER_ID/
    );

    console.log("OK: PICKUP-Webhook und Druckdiagnose verbunden.");
    console.log("OK: SHIPPING-Webhook und Druckqueue verbunden.");
    console.log("OK: Unbekannte Bestellung sicher behandelt.");
    console.log("OK: Ungültige Shopify-ID blockiert.");
    console.log("===== V396: 4/4 BESTANDEN =====");
  } finally {
    if (active) {
      try {
        await client.query("ROLLBACK");
        console.log("OK: Testdaten zurückgerollt.");
      } catch {
        destroy = true;
        throw new Error("V396_ROLLBACK_FAILED");
      } finally {
        client.release(destroy);
        await db.end();
      }
    } else {
      client.release();
      await db.end();
    }
  }
});
