
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.js";
import {
  listOrderRecoverySnapshotsV388
} from "./orderRecovery.v388.js";

test("V388 read-only recovery service", async () => {
  const u = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55433");
  assert.equal(u.pathname, "/alo_staff_test");

  try {
    const identity = await db.query(
      "SELECT current_setting('transaction_read_only') AS readonly"
    );
    assert.equal(identity.rows[0].readonly, "on");

    await assert.rejects(
      listOrderRecoverySnapshotsV388(0),
      /INVALID_RECOVERY_LIMIT/
    );

    await assert.rejects(
      listOrderRecoverySnapshotsV388(201),
      /INVALID_RECOVERY_LIMIT/
    );

    const rows = await listOrderRecoverySnapshotsV388(20);
    assert.ok(Array.isArray(rows));

    for (const row of rows) {
      assert.equal(typeof row.order_id, "string");
      assert.equal(typeof row.recovery_status, "string");
      assert.ok(Number(row.webhook_count) >= 1);
      assert.ok(Number(row.packing_slips) >= 0);
      assert.ok(Number(row.invoices) >= 0);
    }

    console.log("OK: Recovery-Service liest PostgreSQL.");
    console.log("OK: Grenzen validiert.");
    console.log("OK: Nur Read-only-Verbindung.");
    console.log("Anzahl vorhandener Testbestellungen:", rows.length);
  } finally {
    await db.end();
  }
});
