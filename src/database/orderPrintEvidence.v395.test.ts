
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { getOrderPrintEvidenceV395 }
  from "./orderPrintEvidence.v395.js";

test("V395 label and print evidence", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55433");
  assert.equal(url.pathname, "/alo_staff_test");

  const client = await db.connect();
  let active = false;

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

    const base = BigInt(Date.now()) * 1000n;
    const pickup = "gid://shopify/Order/" + (base + 1n);
    const shipping = "gid://shopify/Order/" + (base + 2n);

    async function createLabel(orderId: string, mode: string) {
      const result = await client.query(
        `INSERT INTO shipping_labels (
          shopify_order_id,
          shopify_order_name,
          label_mode,
          status,
          label_pdf_base64
        ) VALUES ($1,$2,$3,'COMPLETED',$4)
        RETURNING id`,
        [orderId, "V395-" + randomUUID(), mode, "TESTPDF"]
      );
      return result.rows[0].id;
    }

    async function createJob(id: string, status: string) {
      await client.query(
        `INSERT INTO print_jobs (
          shipping_label_id,
          document_type,
          status
        ) VALUES ($1,'SHIPPING_LABEL',$2)`,
        [id, status]
      );
    }

    const pickupLabel = await createLabel(pickup, "PICKUP");
    const shippingLabel = await createLabel(shipping, "LIVE");

    await createJob(pickupLabel, "PRINTED");
    await createJob(shippingLabel, "PENDING");

    const a = await getOrderPrintEvidenceV395(pickup, client);
    const b = await getOrderPrintEvidenceV395(shipping, client);

    assert.equal(a.length, 1);
    assert.equal(a[0].label_mode, "PICKUP");
    assert.equal(a[0].label_count, 1);
    assert.equal(a[0].printed_jobs, 1);
    assert.equal(a[0].recovery_status, "PRINT_RECORDED");

    assert.equal(b.length, 1);
    assert.equal(b[0].label_mode, "LIVE");
    assert.equal(b[0].queued_jobs, 1);
    assert.equal(b[0].recovery_status, "PRINT_QUEUED");

    // Historischer Druckauftrag plus erneuter Job:
    // Diagnose muss eine Mehrfachausgabe markieren.
    await createJob(shippingLabel, "PRINTED");
    const duplicate = await getOrderPrintEvidenceV395(shipping, client);
    assert.equal(
      duplicate[0].recovery_status,
      "MULTIPLE_PRINT_JOBS_REVIEW"
    );

    await assert.rejects(
      getOrderPrintEvidenceV395("invalid", client),
      /INVALID_SHOPIFY_ORDER_ID/
    );

    console.log("OK: PICKUP gedruckt erkannt.");
    console.log("OK: SHIPPING in Druckqueue erkannt.");
    console.log("OK: Mehrfach-Printjob erkannt.");
    console.log("OK: Ungültige Bestell-ID abgewiesen.");
    console.log("===== V395 TEST BESTANDEN =====");
  } finally {
    try {
      if (active) {
        await client.query("ROLLBACK");
        console.log("OK: Testdaten zurückgerollt.");
      }
    } finally {
      client.release();
      await db.end();
    }
  }
});
