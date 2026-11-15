
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import {
  createAloNowAutomaticPackingSlipPrintJobV370
} from "../../database/shippingDashboard.js";

function guard() {
  const u = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55433");
  assert.equal(u.pathname, "/alo_staff_test");
  assert.equal(u.search, "");
  assert.equal(u.hash, "");
}

test("V373 real PostgreSQL automatic print concurrency", async () => {
  guard();

  const slips: string[] = [];

  async function fixture() {
    const orderId = "gid://shopify/Order/" +
      BigInt("9" + Date.now().toString() +
        Math.floor(Math.random() * 100000).toString().padStart(5,"0"));

    const row = await db.query<{id:string}>(
      `INSERT INTO packing_slips
        (shopify_order_id,shopify_order_name,
         status,pdf_base64,print_status)
       VALUES ($1,$2,'COMPLETED',$3,'NOT_PRINTED')
       RETURNING id::text`,
      [orderId, "V373-" + randomUUID(), "V373_TEST_PDF_ONLY"]
    );

    const id = row.rows[0].id;
    slips.push(id);
    return id;
  }

  async function count(id:string) {
    const result = await db.query<{n:number}>(
      `SELECT COUNT(*)::int AS n
       FROM print_jobs
       WHERE packing_slip_id=$1
         AND document_type='PACKING_SLIP'`,
      [id]
    );
    return result.rows[0].n;
  }

  try {
    const id = await fixture();

    const results = await Promise.all([
      createAloNowAutomaticPackingSlipPrintJobV370(id, "V373_TEST_ONLY"),
      createAloNowAutomaticPackingSlipPrintJobV370(id, "V373_TEST_ONLY")
    ]);

    assert.equal(results.filter(r=>r.created).length, 1);
    assert.equal(results.filter(r=>!r.created).length, 1);
    assert.equal(await count(id), 1);
    console.log("OK: Zwei parallele Aufrufe, ein Druckauftrag.");

    const repeated =
      await createAloNowAutomaticPackingSlipPrintJobV370(
        id, "V373_TEST_ONLY"
      );

    assert.equal(repeated.created, false);
    assert.equal(await count(id), 1);
    console.log("OK: Wiederholung erstellt keinen weiteren Job.");

    await db.query(
      `UPDATE print_jobs
       SET status='COMPLETED'
       WHERE packing_slip_id=$1
         AND document_type='PACKING_SLIP'`,
      [id]
    );

    const completed =
      await createAloNowAutomaticPackingSlipPrintJobV370(
        id, "V373_TEST_ONLY"
      );

    assert.equal(completed.created, false);
    assert.equal(await count(id), 1);
    console.log("OK: Bereits abgeschlossener Druck blockiert Nachdruck.");

    const missing = await fixture();

    await db.query(
      `UPDATE packing_slips
       SET status='PENDING',pdf_base64=NULL
       WHERE id=$1`,
      [missing]
    );

    await assert.rejects(
      () => createAloNowAutomaticPackingSlipPrintJobV370(
        missing, "V373_TEST_ONLY"
      ),
      /ALO_NOW_PACKING_SLIP_NOT_READY/
    );

    assert.equal(await count(missing), 0);
    console.log("OK: Unfertiger Lieferschein erzeugt keinen Druck.");

    console.log("===== V373 TEST BESTANDEN =====");
  } finally {
    for (const id of slips) {
      await db.query(
        "DELETE FROM print_jobs WHERE packing_slip_id=$1",
        [id]
      );
      await db.query(
        "DELETE FROM packing_slips WHERE id=$1",
        [id]
      );
    }
    await db.end();
  }
});
