
import assert from "node:assert/strict";
import pg from "pg";
import {
  readDriverWalletCandidatesV1678
} from "./aloNowWalletReader.v1678.js";

const { Client } = pg;

const databaseUrl =
  "postgresql://127.0.0.1:55433/alo_staff_test";

const client = new Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
  statement_timeout: 15000
});

let connected = false;
let inTransaction = false;

try {
  await client.connect();
  connected = true;

  await client.query("BEGIN READ ONLY");
  inTransaction = true;

  await client.query(
    "SET LOCAL statement_timeout = '15s'"
  );

  const identity = await client.query<{
    db: string;
    host: string;
    port: number;
    read_only: string;
  }>(`
    SELECT
      current_database() AS db,
      host(inet_server_addr()) AS host,
      inet_server_port() AS port,
      current_setting('transaction_read_only')
        AS read_only
  `);

  const db = identity.rows[0];

  assert.equal(db.db, "alo_staff_test");
  assert.equal(db.host, "127.0.0.1");
  assert.equal(Number(db.port), 55433);
  assert.equal(db.read_only, "on");

  console.log("DATABASE_IDENTITY: PASS");
  console.log("READ_ONLY_TRANSACTION: PASS");

  const requiredTables = [
    "alo_now_deliveries",
    "alo_now_payment_states",
    "alo_now_handoff_ledger",
    "alo_now_driver_finance_events",
    "alo_now_payment_reconciliations"
  ];

  for (const name of requiredTables) {
    const check = await client.query<{
      present: boolean
    }>(
      `SELECT to_regclass($1) IS NOT NULL
         AS present`,
      ["public." + name]
    );

    assert.equal(
      check.rows[0]?.present,
      true,
      "Missing table: " + name
    );
  }

  console.log("ALL_READER_TABLES_PRESENT: PASS");

  const result = await readDriverWalletCandidatesV1678(
    async (sql, params) => {
      // No INSERT, UPDATE, DELETE or DDL permitted.
      assert.match(sql.trimStart(), /^SELECT\b/i);

      const response = await client.query(
        sql, params
      );

      return {
        rows: response.rows
      };
    },
    "101",
    "AARAU"
  );

  assert.ok(Array.isArray(result));

  for (const item of result) {
    assert.equal(item.payoutEnabled, false);
    assert.equal(item.payableOutstandingRappen, null);
    assert.ok(item.blockers.includes(
      "TRUSTED_PROVIDER_AND_AMOUNT_CHECK_PENDING"
    ));
  }

  console.log("REAL_POSTGRES_QUERY: PASS");
  console.log("WALLET_CANDIDATES:", result.length);
  console.log("PAYOUT_DISABLED: PASS");
  console.log("UNVERIFIED_MONEY_HIDDEN: PASS");

  await client.query("ROLLBACK");
  inTransaction = false;

  console.log("TRANSACTION_ROLLED_BACK: PASS");
  console.log("ALO_NOW_V1679_POSTGRES_READER_PASS");

} catch (error) {
  console.error(
    "V1679_FAILED:",
    error instanceof Error
      ? error.message
      : String(error)
  );

  process.exitCode = 1;

} finally {
  if (connected && inTransaction) {
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
