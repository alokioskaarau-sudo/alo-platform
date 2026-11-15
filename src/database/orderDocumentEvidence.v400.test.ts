
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  getOrderDocumentEvidenceV399
} from "./orderDocumentEvidence.v399.js";

test("V400 real packing slip and invoice evidence", async () => {
  const u = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55433");
  assert.equal(u.pathname, "/alo_staff_test");

  const client = await db.connect();
  let open = false;
  let destroy = false;

  try {
    const check = await client.query(
      `SELECT current_database() AS name,
              inet_server_port() AS port`
    );

    assert.equal(check.rows[0].name, "alo_staff_test");
    assert.equal(check.rows[0].port, 55433);

    await client.query("BEGIN");
    open = true;
    await client.query("SET LOCAL statement_timeout='12s'");
    await client.query("SET LOCAL lock_timeout='2s'");

    const orderId =
      "gid://shopify/Order/" +
      (BigInt(Date.now()) * 100000n + 400n);

    const orderName = "V400-" + randomUUID();

    const slip = await client.query(
      `INSERT INTO packing_slips (
        shopify_order_id,
        shopify_order_name,
        status,
        pdf_base64
      ) VALUES ($1,$2,'COMPLETED','TESTPDF')
      RETURNING id`,
      [orderId, orderName]
    );

    const invoice = await client.query(
      `INSERT INTO invoices (
        shopify_order_id,
        shopify_order_name,
        invoice_number,
        status,
        pdf_base64
      ) VALUES ($1,$2,$3,'COMPLETED','TESTPDF')
      RETURNING id`,
      [orderId, orderName, "INV-" + randomUUID()]
    );

    const slipId = slip.rows[0].id;
    const invoiceId = invoice.rows[0].id;

    await client.query(
      `INSERT INTO print_jobs (
        packing_slip_id,document_type,status
      ) VALUES ($1,'PACKING_SLIP','PENDING')`,
      [slipId]
    );

    await client.query(
      `INSERT INTO print_jobs (
        invoice_id,document_type,status
      ) VALUES ($1,'INVOICE','PRINTED')`,
      [invoiceId]
    );

    const first = await getOrderDocumentEvidenceV399(
      orderId, client
    );

    assert.equal(first.length, 2);

    const packing = first.find(
      d => d.document_type === "PACKING_SLIP"
    );
    const billing = first.find(
      d => d.document_type === "INVOICE"
    );

    assert.ok(packing);
    assert.ok(billing);

    assert.equal(packing.document_count, 1);
    assert.equal(packing.complete_documents, 1);
    assert.equal(packing.total_jobs, 1);
    assert.equal(packing.queued_jobs, 1);

    assert.equal(billing.document_count, 1);
    assert.equal(billing.complete_documents, 1);
    assert.equal(billing.total_jobs, 1);
    assert.equal(billing.printed_jobs, 1);

    console.log("OK: Lieferschein und Queue korrekt.");
    console.log("OK: Rechnung und PRINTED korrekt.");

    await client.query(
      `INSERT INTO print_jobs (
        packing_slip_id,document_type,status
      ) VALUES ($1,'PACKING_SLIP','PRINTED')`,
      [slipId]
    );

    const second = await getOrderDocumentEvidenceV399(
      orderId, client
    );

    const updated = second.find(
      d => d.document_type === "PACKING_SLIP"
    );

    assert.ok(updated);
    assert.equal(updated.document_count, 1);
    assert.equal(updated.complete_documents, 1);
    assert.equal(updated.total_jobs, 2);
    assert.equal(updated.queued_jobs, 1);
    assert.equal(updated.printed_jobs, 1);

    console.log("OK: Doppelter Druckjob erkannt.");
    console.log("OK: Lieferschein bleibt ein Dokument.");
    console.log("===== V400 TEST BESTANDEN =====");
  } finally {
    try {
      if (open) {
        await client.query("ROLLBACK");
        console.log("OK: ROLLBACK ausgeführt.");
      }
    } catch {
      destroy = true;
      throw new Error("V400_ROLLBACK_FAILED");
    } finally {
      client.release(destroy);
      await db.end();
    }
  }
});
