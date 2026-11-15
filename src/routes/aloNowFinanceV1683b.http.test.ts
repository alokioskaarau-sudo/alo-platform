
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { db } from "../database/db.js";
import {
  aloNowFinanceV962Router
} from "./aloNowFinanceV962.routes.js";

// V1683B: only affects this short-lived test process.
// Never modify production connection configuration.
const pool = db as unknown as {
  options: { ssl?: boolean | object };
};

pool.options.ssl = false;

const app = express();
app.use(aloNowFinanceV962Router);

let server: Server | undefined;

try {
  const identity = await db.query(`
    SELECT
      current_database() AS name,
      host(inet_server_addr()) AS host,
      inet_server_port() AS port,
      current_setting('default_transaction_read_only')
        AS read_only
  `);

  const row = identity.rows[0];

  assert.equal(row.name, "alo_staff_test");
  assert.equal(row.host, "127.0.0.1");
  assert.equal(Number(row.port), 55433);
  assert.equal(row.read_only, "on");

  console.log("LOCAL_TEST_DATABASE: PASS");
  console.log("DATABASE_READ_ONLY: PASS");
  console.log("LOCAL_SSL_DISABLED: PASS");

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

  const address = server.address();

  assert.ok(address);
  assert.notEqual(typeof address, "string");

  if (typeof address === "string") {
    throw new Error("INVALID_SERVER_ADDRESS");
  }

  const url =
    `http://127.0.0.1:${address.port}` +
    "/driver/finance-overview";

  const anonymous = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000)
  });

  assert.equal(anonymous.status, 401);
  console.log("ANONYMOUS_HTTP_401: PASS");

  const invalid = await fetch(url, {
    headers: {
      Authorization:
        "Bearer v1683b-invalid-test-session"
    },
    redirect: "manual",
    signal: AbortSignal.timeout(5000)
  });

  assert.equal(invalid.status, 401);
  console.log("INVALID_SESSION_HTTP_401: PASS");

  console.log(
    "ALO_NOW_V1683B_HTTP_AUTH_PASS"
  );

} catch (error) {
  console.error("V1683B_FAILED:", error);
  process.exitCode = 1;

} finally {
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
