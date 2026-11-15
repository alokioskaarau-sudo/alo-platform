
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  getOrderDocumentEvidenceV399
} from "./orderDocumentEvidence.v399.js";

test("V399 document and print evidence", async () => {
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
      "gid://shopify/Order/" + (base + 399n);

    const label = await client.query(
      `INSERT INTO shipping_labels (
        shopify_order_id,
        shopify_order_name,
        label_mode,
        status,
        label_pdf_base64
      ) VALUES ($1,$2,'PICKUP','COMPLETED','TESTPDF')
      RETURNING id`,
      [orderId, "V399-" + randomUUID()]
    );

    const labelId = label.rows[0].id;

    await client.query(
      `INSERT INTO print_jobs (
        shipping_label_id,
        document_type,
        status
      ) VALUES ($1,'SHIPPING_LABEL','PENDING')`,
      [labelId]
    );

    const first = await getOrderDocumentEvidenceV399(
      orderId,
      client
    );

    assert.equal(first.length, 1);
    assert.equal(first[0].document_type, "SHIPPING_LABEL");
    assert.equal(first[0].label_mode, "PICKUP");
    assert.equal(first[0].document_count, 1);
    assert.equal(first[0].complete_documents, 1);
    assert.equal(first[0].queued_jobs, 1);
    assert.equal(first[0].total_jobs, 1);

    console.log("OK: Abholbon und Druckqueue erkannt.");

    await client.query(
      `INSERT INTO print_jobs (
        shipping_label_id,
        document_type,
        status
      ) VALUES ($1,'SHIPPING_LABEL','PRINTED')`,
      [labelId]
    );

    const second = await getOrderDocumentEvidenceV399(
      orderId,
      client
    );

    assert.equal(second[0].document_count, 1);
    assert.equal(second[0].complete_documents, 1);
    assert.equal(second[0].total_jobs, 2);
    assert.equal(second[0].printed_jobs, 1);
    assert.equal(second[0].queued_jobs, 1);

    console.log("OK: Zwei Jobs zählen nicht als zwei Dokumente.");
    console.log("OK: Gedruckter Job separat erkannt.");

    const missing =
      "gid://shopify/Order/" + (base + 400n);

    assert.deepEqual(
      await getOrderDocumentEvidenceV399(missing, client),
      []
    );

    console.log("OK: Fehlende Dokumente ergeben leere Evidenz.");

    await assert.rejects(
      getOrderDocumentEvidenceV399("invalid", client),
      /INVALID_SHOPIFY_ORDER_ID/
    );

    console.log("OK: Ungültige ID abgewiesen.");
    console.log("===== V399 TEST BESTANDEN =====");

  } finally {
    try {
      if (active) {
        await client.query("ROLLBACK");
        console.log("OK: Testdaten zurückgerollt.");
      }
    } catch {
      destroy = true;
      throw new Error("V399_ROLLBACK_FAILED");
    } finally {
      client.release(destroy);
      await db.end();
    }
  }
});
