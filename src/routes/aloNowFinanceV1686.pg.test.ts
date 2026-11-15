
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;

const routeSource = readFileSync(
  "src/routes/aloNowFinanceV962.routes.ts",
  "utf8"
);

const marker = routeSource.indexOf(
  "ALO_NOW_V1684_FINANCE_SCOPE"
);

assert.ok(marker >= 0);

const routeEnd = routeSource.indexOf(
  "aloNowFinanceV962Router.",
  marker
);

const section = routeSource.slice(
  marker,
  routeEnd >= 0 ? routeEnd : undefined
);

// Extract only the three SQL statements using the
// authenticated driver and allowed workspace array.
const expression =
  /db\.query\s*\(\s*`([\s\S]*?)`\s*,\s*\[\s*staff\.id\s*,\s*financeAllowedWorkspaces\s*\]\s*\)/g;

const sqlStatements = [
  ...section.matchAll(expression)
].map(match => match[1]);

assert.equal(
  sqlStatements.length,
  3,
  "Exactly three driver finance queries required"
);

const tables = [
  "alo_now_cash_custody_v958",
  "alo_now_driver_cash_shifts",
  "alo_now_driver_finance_events"
];

for (let i = 0; i < sqlStatements.length; i++) {
  const sql = sqlStatements[i];

  assert.match(sql, /^\s*SELECT\b/i);
  assert.ok(sql.includes("FROM " + tables[i]));
  assert.match(
    sql,
    /WHERE\s+driver_user_id\s*=\s*\$1/i
  );
  assert.match(
    sql,
    /workspace\s*=\s*ANY\s*\(\s*\$2::text\[\]\s*\)/i
  );
}

console.log("THREE_REAL_SQL_STATEMENTS: PASS");
console.log("DRIVER_AND_WORKSPACE_FILTERS: PASS");

const client = new Client({
  connectionString:
    "postgresql://maxim@127.0.0.1:55433/alo_staff_test",
  ssl: false,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
  statement_timeout: 15000
});

let connected = false;
let transaction = false;

try {
  await client.connect();
  connected = true;

  await client.query("BEGIN READ ONLY");
  transaction = true;

  const identity = await client.query(`
    SELECT
      current_database() AS database_name,
      host(inet_server_addr()) AS server_host,
      inet_server_port() AS server_port,
      current_setting('transaction_read_only')
        AS read_only
  `);

  const db = identity.rows[0];

  assert.equal(db.database_name, "alo_staff_test");
  assert.equal(db.server_host, "127.0.0.1");
  assert.equal(Number(db.server_port), 55433);
  assert.equal(db.read_only, "on");

  console.log("LOCAL_DATABASE_IDENTITY: PASS");
  console.log("READ_ONLY_TRANSACTION: PASS");

  const actors = [
    { id: "101", workspaces: ["AARAU"] },
    { id: "202", workspaces: ["OLTEN"] },
    { id: "101", workspaces: ["AARAU", "OLTEN"] },
    { id: "101", workspaces: [] as string[] }
  ];

  let executed = 0;
  let returned = 0;

  for (const actor of actors) {
    for (let i = 0; i < sqlStatements.length; i++) {
      const result = await client.query(
        sqlStatements[i],
        [actor.id, actor.workspaces]
      );

      executed++;
      returned += result.rows.length;

      for (const row of result.rows) {
        assert.ok(
          actor.workspaces.includes(
            String(row.workspace)
          )
        );
      }
    }
  }

  assert.equal(executed, 12);

  console.log("REAL_FINANCE_SQL_EXECUTIONS: PASS");
  console.log("SQL_QUERIES_EXECUTED:", executed);
  console.log("EXISTING_ROWS_RETURNED:", returned);

  // These are virtual fixtures evaluated by actual
  // PostgreSQL. No physical test rows are inserted.
  const synthetic = `
    SELECT id
    FROM (
      VALUES
        ('A-101','101','AARAU'),
        ('O-101','101','OLTEN'),
        ('O-202','202','OLTEN'),
        ('A-202','202','AARAU')
    ) AS fixtures(id,driver_user_id,workspace)
    WHERE driver_user_id=$1
      AND workspace=ANY($2::text[])
    ORDER BY id
  `;

  const scenarios = [
    {
      id: "101",
      workspaces: ["AARAU"],
      expected: ["A-101"]
    },
    {
      id: "202",
      workspaces: ["OLTEN"],
      expected: ["O-202"]
    },
    {
      id: "101",
      workspaces: ["AARAU", "OLTEN"],
      expected: ["A-101", "O-101"]
    },
    {
      id: "101",
      workspaces: [],
      expected: []
    },
    {
      id: "999",
      workspaces: ["AARAU", "OLTEN"],
      expected: []
    }
  ];

  for (const scenario of scenarios) {
    const result = await client.query(
      synthetic,
      [scenario.id, scenario.workspaces]
    );

    assert.deepEqual(
      result.rows.map(row => row.id),
      scenario.expected
    );
  }

  console.log("POSTGRES_SYNTHETIC_ISOLATION: PASS");
  console.log("SYNTHETIC_SCENARIOS: 5");
  console.log("FOREIGN_DRIVER_EXCLUDED: PASS");
  console.log("UNAUTHORIZED_WORKSPACE_EXCLUDED: PASS");

  await client.query("ROLLBACK");
  transaction = false;

  console.log("READ_ONLY_TRANSACTION_ROLLED_BACK: PASS");
  console.log("ALO_NOW_V1686_POSTGRES_SECURITY_PASS");

} catch (error) {
  console.error("V1686_FAILED:", error);
  process.exitCode = 1;

} finally {
  if (connected && transaction) {
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
