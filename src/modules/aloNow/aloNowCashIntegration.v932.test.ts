import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import {
  openDriverCashShiftV843,
  bookDriverFinanceEventV843,
  bookCashBundleV929,
} from "./aloNowDriverCashService.v843.js";

async function main() {
  console.log("===== ALO NOW V932 POSTGRESQL E2E =====");

  const identity = await db.query(`
    SELECT current_database() AS name,
           inet_server_port() AS port,
           inet_server_addr()::text AS address
  `);

  const target = identity.rows[0];

  assert.equal(target.name, "alo_staff_test");
  assert.equal(Number(target.port), 55433);
  assert.match(String(target.address), /^127\.0\.0\.1/);
  // V932B: The project DB wrapper does not expose
  // connection options. Verify the explicit test env instead.
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(process.env.PGHOST, "127.0.0.1");
  assert.equal(process.env.PGPORT, "55433");
  assert.equal(process.env.PGDATABASE, "alo_staff_test");
  assert.equal(
    process.env.DATABASE_URL,
    "postgresql://maxim@127.0.0.1:55433/alo_staff_test"
  );

  console.log("OK: Isolierte Testdatenbank erkannt.");

  const suffix = randomUUID();
  const driverA = "V932-DRIVER-A-" + suffix;
  const driverB = "V932-DRIVER-B-" + suffix;

  const ctxA = {
    driverUserId: driverA,
    actorUserId: driverA,
    workspace: "AARAU" as const,
  };

  const ctxB = {
    driverUserId: driverB,
    actorUserId: driverB,
    workspace: "AARAU" as const,
  };

  const number = () =>
    randomBytes(8).readBigUInt64BE().toString();

  const orders = [
    "gid://shopify/Order/" + number(),
    "gid://shopify/Order/" + number(),
    "gid://shopify/Order/" + number(),
  ];

  const shifts: string[] = [];

  try {
    const a = await openDriverCashShiftV843(ctxA, 10000);
    shifts.push(a.shiftId);

    const b = await openDriverCashShiftV843(ctxB, 10000);
    shifts.push(b.shiftId);

    console.log("OK: Zwei Test-Fahrerkassen geöffnet.");

    // TEST 1: simultaneous collection across two shifts.
    const concurrent = await Promise.allSettled([
      bookCashBundleV929(
        ctxA, a.shiftId, orders[0], 5800, 200
      ),
      bookCashBundleV929(
        ctxB, b.shiftId, orders[0], 5800, 200
      ),
    ]);

    const successful = concurrent.filter(
      x => x.status === "fulfilled"
    );
    const rejected = concurrent.filter(
      x => x.status === "rejected"
    );

    assert.equal(successful.length, 1);
    assert.equal(rejected.length, 1);

    const booked = await db.query(`
      SELECT event_type, amount_rappen::text AS amount
      FROM alo_now_driver_finance_events
      WHERE order_id=$1
      ORDER BY event_type
    `, [orders[0]]);

    assert.equal(booked.rowCount, 2);

    const amounts = Object.fromEntries(
      booked.rows.map(x => [
        x.event_type,
        Number(x.amount),
      ])
    );

    assert.equal(amounts.CASH_ORDER_COLLECTED, 5800);
    assert.equal(amounts.CASH_TIP_COLLECTED, 200);

    console.log(
      "OK: Zwei parallele Versuche, nur eine Buchung."
    );
    console.log(
      "OK: CHF 58 Bestellung und CHF 2 Trinkgeld."
    );

    // TEST 2: force tip insert failure by reserving
    // its event key on a different test order.
    await bookDriverFinanceEventV843(
      ctxA,
      a.shiftId,
      {
        eventKey: "ALO-CASH-TIP:" + orders[1],
        type: "CASH_TIP_COLLECTED",
        amountRappen: 200,
        sourceReference: orders[2],
        orderId: orders[2],
      }
    );

    await assert.rejects(
      bookCashBundleV929(
        ctxA, a.shiftId, orders[1], 5800, 200
      )
    );

    const afterFailure = await db.query(`
      SELECT COUNT(*)::int AS count
      FROM alo_now_driver_finance_events
      WHERE order_id=$1
    `, [orders[1]]);

    assert.equal(afterFailure.rows[0].count, 0);

    console.log(
      "OK: Fehlgeschlagener Trinkgeldeintrag " +
      "rollt die gesamte Zahlung zurück."
    );

    console.log("===== V932 BESTANDEN =====");
  } finally {
    // Only the unique fixtures created by this test.
    if (shifts.length) {
      await db.query(`
        DELETE FROM alo_now_driver_finance_events
        WHERE cash_shift_id = ANY($1::uuid[])
      `, [shifts]);

      await db.query(`
        DELETE FROM alo_now_driver_cash_shifts
        WHERE id = ANY($1::uuid[])
          AND driver_user_id IN ($2,$3)
      `, [shifts, driverA, driverB]);

      console.log("Test-Finanzdaten entfernt.");
    }

    await db.end();
  }
}

main().catch(error => {
  console.error(
    "V932 FEHLER:",
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
