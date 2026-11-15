
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  listOrderRecoverySnapshotsV388
} from "./orderRecovery.v388.js";

test("V389 real recovery service with rolled-back fixtures", async () => {
  const u = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55433");
  assert.equal(u.pathname, "/alo_staff_test");

  const client = await db.connect();
  let transactionOpen = false;

  try {
    const identity = await client.query(
      `SELECT current_database() AS name,
              inet_server_port() AS port`
    );

    assert.equal(identity.rows[0].name, "alo_staff_test");
    assert.equal(identity.rows[0].port, 55433);

    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '12000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");

    const prefix = (
      900000000000000000n
      + BigInt(Date.now()) * 100n
    );

    const cases = [
      {
        name: "PENDING",
        statuses: ["PENDING"],
        expected: "PENDING_RECONCILIATION"
      },
      {
        name: "PROCESSING",
        statuses: ["PROCESSING"],
        expected: "PROCESSING_RECONCILIATION"
      },
      {
        name: "COMPLETED_WITHOUT_ARTIFACTS",
        statuses: ["COMPLETED"],
        expected: "CHANNEL_REVIEW_REQUIRED"
      },
      {
        name: "FAILED",
        statuses: ["FAILED"],
        expected: "FAILED_RECONCILIATION"
      },
      {
        name: "MIXED",
        statuses: ["COMPLETED", "FAILED"],
        expected: "FAILED_RECONCILIATION"
      }
    ];

    const expectedByOrder = new Map<string, string>();

    for (const [index, item] of cases.entries()) {
      const orderId =
        "gid://shopify/Order/" + (prefix + BigInt(index));

      expectedByOrder.set(orderId, item.expected);

      for (const status of item.statuses) {
        await client.query(
          `INSERT INTO shopify_webhook_events (
             webhook_id,
             topic,
             shopify_order_id,
             status,
             attempts
           )
           VALUES ($1,'orders/paid',$2,$3,$4)`,
          [
            "V389-" + randomUUID(),
            orderId,
            status,
            status === "PENDING" ? 0 : 1
          ]
        );
      }
    }

    // Der echte V388-Service nutzt dieselbe Verbindung
    // und sieht deshalb auch uncommittete Testdaten.
    const rows = await listOrderRecoverySnapshotsV388(
      200,
      client
    );

    let passed = 0;

    for (const [orderId, expected] of expectedByOrder) {
      const row = rows.find(r => r.order_id === orderId);

      assert.ok(row, "Testbestellung fehlt: " + orderId);
      assert.equal(
        row.recovery_status,
        expected,
        "Falsche Recovery-Klasse"
      );

      passed++;
    }

    assert.equal(passed, 5);

    console.log("OK: PENDING korrekt.");
    console.log("OK: PROCESSING korrekt.");
    console.log("OK: COMPLETED ohne Artefakte erkannt.");
    console.log("OK: FAILED erkannt.");
    console.log("OK: Gemischte Ereignisse erkannt.");
    console.log("OK: Tatsächliche V388-Funktion ausgeführt.");
    console.log("===== V389: 5/5 BESTANDEN =====");

  } finally {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        console.log("OK: Testdaten zurückgerollt.");
      } finally {
        client.release();
      }
    } else {
      client.release();
    }
    await db.end();
  }
});
