
import assert from "node:assert/strict";
import pg from "pg";

import {
  inspectWalletDbEvidenceV1689
} from "./aloNowWalletDbPreflight.v1689.js";

const { Client } = pg;

const client = new Client({
  connectionString:
    "postgresql://maxim@127.0.0.1:55433/alo_staff_test",
  ssl: false,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
  statement_timeout: 15000
});

const scope = {
  driverUserId: "999999999999999999",
  workspace: "AARAU" as const,
  orderId: "gid://shopify/Order/999999999999999999"
};

let connected = false;
let transactionOpen = false;
let queries = 0;

try {
  await client.connect();
  connected = true;

  await client.query("BEGIN READ ONLY");
  transactionOpen = true;

  const identity = await client.query(`
    SELECT current_database() AS name,
           host(inet_server_addr()) AS host,
           inet_server_port() AS port,
           current_setting('transaction_read_only')
             AS read_only
  `);

  const db = identity.rows[0];

  assert.equal(db.name, "alo_staff_test");
  assert.equal(db.host, "127.0.0.1");
  assert.equal(Number(db.port), 55433);
  assert.equal(db.read_only, "on");

  console.log("LOCAL_DATABASE_IDENTITY: PASS");
  console.log("READ_ONLY_TRANSACTION: PASS");

  const result = await inspectWalletDbEvidenceV1689(
    async (sql, params) => {
      queries++;

      assert.match(sql, /^\s*SELECT\b/i);
      assert.match(sql, /FROM alo_now_deliveries d/i);

      assert.deepEqual(params, [
        scope.orderId,
        scope.driverUserId,
        scope.workspace
      ]);

      // Validate the real SQL plan without modifying data.
      const plan = await client.query(
        "EXPLAIN " + sql,
        [...params]
      );

      assert.ok(plan.rows.length > 0);

      console.log("POSTGRES_QUERY_PLAN: PASS");

      const actual = await client.query(
        sql,
        [...params]
      );

      console.log(
        "MATCHING_TEST_ROWS:",
        actual.rows.length
      );

      return { rows: actual.rows };
    },
    scope
  );

  assert.equal(queries, 1);
  assert.equal(result.dbEvidenceChecked, true);

  // Regardless of database evidence, this preflight
  // cannot certify Shopify payments or authorize money.
  assert.equal(result.providerConfirmed, false);
  assert.equal(result.sourceVerified, false);
  assert.equal(result.payableOutstandingRappen, null);
  assert.equal(result.payoutEnabled, false);

  console.log("REAL_POSTGRES_QUERY: PASS");
  console.log("MONEY_AUTHORIZATION_BLOCKED: PASS");
  console.log("PREFLIGHT_STATUS:", result.status);

  const unavailable = await inspectWalletDbEvidenceV1689(
    async () => {
      throw new Error("SIMULATED_DATABASE_UNAVAILABLE");
    },
    scope
  );

  assert.equal(unavailable.status, "BLOCKED");
  assert.equal(unavailable.dbEvidenceChecked, false);
  assert.equal(unavailable.payableOutstandingRappen, null);

  console.log("DATABASE_FAILURE_FAIL_CLOSED: PASS");

  await client.query("ROLLBACK");
  transactionOpen = false;

  console.log("TRANSACTION_ROLLBACK: PASS");
  console.log("ALO_NOW_V1690_POSTGRES_PREFLIGHT_PASS");

} catch (error) {
  console.error("V1690_FAILED:", error);
  process.exitCode = 1;

} finally {
  if (connected && transactionOpen) {
    try {
      await client.query("ROLLBACK");
    } catch {
      process.exitCode = 1;
    }
  }

  if (connected) {
    await client.end();
  }
}
