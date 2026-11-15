
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { db } from "../database/db.js";
import {
  aloNowFinanceV962Router
} from "./aloNowFinanceV962.routes.js";

type Workspace = "AARAU" | "OLTEN";

type Actor = {
  id: string;
  role: "ADMIN" | "STAFF";
  job: "driver" | "sales";
  workspaces: Workspace[];
};

const records = [
  { id: "A-101", driver: "101", workspace: "AARAU" },
  { id: "O-101", driver: "101", workspace: "OLTEN" },
  { id: "O-202", driver: "202", workspace: "OLTEN" }
];

let actor: Actor = {
  id: "101",
  role: "STAFF",
  job: "driver",
  workspaces: ["AARAU"]
};

let financeQueries = 0;
let walletQueries: Workspace[] = [];

const pool = db as unknown as {
  query: typeof db.query;
};

const originalQuery = pool.query;

function response(rows: unknown[]) {
  return {
    rows,
    rowCount: rows.length,
    command: "SELECT"
  };
}

// This mock exists only inside this test process.
// No authentication middleware or production source is edited.
pool.query = (async (
  sqlInput: unknown,
  paramsInput?: unknown
) => {
  const sql = String(sqlInput);
  const params = Array.isArray(paramsInput)
    ? paramsInput
    : [];

  // V1685C: simulated session bookkeeping, no actual DB write.
  if (/^\s*UPDATE\s+staff_sessions\s+SET\b/i.test(sql)) {
    return {
      rows: [],
      rowCount: 1,
      command: "UPDATE"
    };
  }

  if (!/^\s*SELECT\b/i.test(sql)) {
    throw new Error("V1685_NON_READ_QUERY_BLOCKED");
  }

  // The real auth middleware still runs.
  // Only its database session lookup is simulated.
  if (/FROM\s+staff_sessions\s+s\b/i.test(sql)) {
    return response([{
      session_id: "local-v1685-session",
      staff_user_id: actor.id,
      username: "local-test-driver",
      display_name: "Local Test Driver",
      role: actor.role,
      job_key: actor.job,
      job_keys: [actor.job],
      default_workspace: actor.workspaces[0] ?? "ONLINE",
      allowed_workspaces: actor.workspaces,
      permissions: [],
      denied_permissions: [],
      profile_note: null,
      avatar_url: null,
      active: true,
      approved_at: "2026-11-04T12:00:00Z",
      approved_by: "local-test"
    }]);
  }


  // V1685C_WALLET_QUERY_FIRST
  // Match the outer delivery query, not its nested subqueries.
  if (
    /^\s*SELECT\b/i.test(sql) &&
    /FROM\s+alo_now_deliveries\s+d\s+WHERE\s+d\.assigned_driver_user_id::text\s*=\s*\$1/i.test(
      sql
    )
  ) {
    assert.match(
      sql,
      /d\.fulfillment_workspace\s*=\s*\$2/i
    );

    assert.equal(String(params[0]), actor.id);

    const workspace = String(params[1]) as Workspace;

    assert.ok(actor.workspaces.includes(workspace));

    walletQueries.push(workspace);

    return response([]);
  }

  const financeTable =
    /FROM\s+alo_now_cash_custody_v958\b/i.test(sql)
      ? "cash"
      : /FROM\s+alo_now_driver_cash_shifts\b/i.test(sql)
      ? "shift"
      : /FROM\s+alo_now_driver_finance_events\b/i.test(sql)
      ? "events"
      : null;

  if (financeTable) {
    financeQueries++;

    assert.match(
      sql,
      /WHERE\s+driver_user_id\s*=\s*\$1/i
    );

    assert.match(
      sql,
      /workspace\s*=\s*ANY\s*\(\s*\$2::text\[\]\s*\)/i
    );

    assert.equal(String(params[0]), actor.id);
    assert.deepEqual(params[1], actor.workspaces);

    const permitted = records.filter(
      record =>
        record.driver === String(params[0]) &&
        actor.workspaces.includes(
          record.workspace as Workspace
        )
    );

    if (financeTable === "cash") {
      return response(permitted.map(record => ({
        id: record.id,
        workspace: record.workspace,
        opening_float_rappen: "1000",
        returned_float_rappen: null
      })));
    }

    if (financeTable === "shift") {
      return response(permitted.map(record => ({
        id: record.id,
        workspace: record.workspace,
        opening_cash_rappen: "1000"
      })));
    }

    return response(permitted.map(record => ({
      id: record.id,
      workspace: record.workspace,
      event_type: "COMMISSION_EARNED",
      amount_rappen: "250"
    })));
  }

  throw new Error(
    "V1685_UNEXPECTED_DATABASE_QUERY"
  );

}) as typeof db.query;

const app = express();
app.use(aloNowFinanceV962Router);

let server: Server | undefined;

async function requestOverview() {
  const address = server?.address();

  assert.ok(address && typeof address !== "string");

  const url =
    `http://127.0.0.1:${address.port}` +
    "/driver/finance-overview" +
    "?driverUserId=999&workspace=OLTEN";

  const result = await fetch(url, {
    headers: {
      Authorization:
        "Bearer v1685-fixture-session-not-real"
    },
    signal: AbortSignal.timeout(5000)
  });

  return {
    status: result.status,
    body: await result.json() as any
  };
}

async function verify(
  current: Actor,
  expectedIds: string[],
  expectedWorkspaces: Workspace[]
) {
  actor = current;
  financeQueries = 0;
  walletQueries = [];

  const result = await requestOverview();

  assert.equal(result.status, 200);
  assert.equal(result.body.driverUserId, current.id);

  for (const field of [
    "cashboxes", "cashShifts", "financeEvents"
  ]) {
    const actualIds = result.body[field]
      .map((item: any) => String(item.id))
      .sort();

    assert.deepEqual(
      actualIds,
      [...expectedIds].sort(),
      field + " contains wrong records"
    );
  }

  assert.equal(financeQueries, 3);

  assert.deepEqual(
    [...walletQueries].sort(),
    [...expectedWorkspaces].sort()
  );

  assert.equal(
    result.body.payableOutstandingRappen,
    null
  );

  assert.equal(
    result.body.walletEvidence.payoutEnabled,
    false
  );

  assert.equal(result.body.readOnly, true);
}

try {
  server = await new Promise<Server>(
    (resolve, reject) => {
      const instance = app.listen(
        0, "127.0.0.1"
      );

      instance.once("listening", () => {
        resolve(instance);
      });

      instance.once("error", reject);
    }
  );

  await verify(
    {
      id: "101",
      role: "STAFF",
      job: "driver",
      workspaces: ["AARAU"]
    },
    ["A-101"],
    ["AARAU"]
  );

  console.log("AARAU_ONLY_DRIVER: PASS");

  await verify(
    {
      id: "202",
      role: "STAFF",
      job: "driver",
      workspaces: ["OLTEN"]
    },
    ["O-202"],
    ["OLTEN"]
  );

  console.log("OLTEN_ONLY_DRIVER: PASS");

  await verify(
    {
      id: "101",
      role: "STAFF",
      job: "driver",
      workspaces: ["AARAU", "OLTEN"]
    },
    ["A-101", "O-101"],
    ["AARAU", "OLTEN"]
  );

  console.log("TWO_WORKSPACES: PASS");

  actor = {
    id: "303",
    role: "STAFF",
    job: "sales",
    workspaces: ["AARAU"]
  };

  financeQueries = 0;

  const forbidden = await requestOverview();

  assert.equal(forbidden.status, 403);
  assert.equal(
    forbidden.body.error,
    "DRIVER_ACCESS_REQUIRED"
  );
  assert.equal(financeQueries, 0);

  console.log("NON_DRIVER_HTTP_403: PASS");

  await verify(
    {
      id: "101",
      role: "STAFF",
      job: "driver",
      workspaces: []
    },
    [],
    []
  );

  console.log("NO_WORKSPACE_NO_DATA: PASS");
  console.log("FOREIGN_DRIVER_QUERY_IGNORED: PASS");
  console.log("UNVERIFIED_PAYOUT_BLOCKED: PASS");

  console.log("ALO_NOW_V1685_HTTP_ISOLATION_PASS");

} catch (error) {
  console.error("V1685_FAILED:", error);
  process.exitCode = 1;

} finally {
  pool.query = originalQuery;

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close(error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  await db.end();
}
