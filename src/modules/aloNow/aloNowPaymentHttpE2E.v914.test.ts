import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID, randomInt} from "node:crypto";
import {db} from "../../database/db.js";
import {
  commitVerifiedAloNowOnlinePayment
} from "./aloNowVerifiedPaymentCommit.js";
import type {
  ShopifyPaymentReader,
  ShopifyPaymentSnapshot
} from "./aloNowTrustedPaymentVerification.js";

// V363B: Validate database identity, not URL credentials.
let localDatabase = false;
try {
  const url = new URL(process.env.DATABASE_URL ?? "");
  localDatabase =
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    url.hostname === "127.0.0.1" &&
    url.port === "55433" &&
    url.pathname === "/alo_staff_test" &&
    url.search === "" &&
    url.hash === "";
} catch {
  localDatabase = false;
}

if (
  process.env.NODE_ENV !== "test" ||
  process.env.ALO_RUNTIME_MODE !== "local_test" ||
  !localDatabase
) throw new Error("V363_LOCAL_DATABASE_GUARD");

const created: string[] = [];

function orderId() {
  return "gid://shopify/Order/" +
    String(Date.now()) +
    String(randomInt(100000, 999999));
}

function trustedReader(
  id: string,
  amount = "14.40",
  financialStatus = "PAID"
): ShopifyPaymentReader {
  const snapshot = {
    id,
    cancelledAt: null,
    displayFinancialStatus: financialStatus,
    totalPriceSet: {
      shopMoney: {
        amount,
        currencyCode: "CHF"
      }
    },
    // ALO_V1707_HTTP_REFUND_FIXTURE
    totalOutstandingSet: {
      shopMoney: {
        amount: "0.00",
        currencyCode: "CHF"
      }
    },
    totalRefundedSet: {
      shopMoney: {
        amount: "0.00",
        currencyCode: "CHF"
      }
    }
  } as ShopifyPaymentSnapshot;

  return async (requestedId: string) => {
    assert.equal(requestedId, id);
    return snapshot;
  };
}

async function fixture(expired = false) {
  const id = randomUUID();
  const order = orderId();
  const reference = randomUUID();
  const client = await db.connect();

  let transaction = false;
  try {
    await client.query("BEGIN");
    transaction = true;

    await client.query(
      `INSERT INTO alo_now_order_requests
       (id,client_request_id,workspace,delivery_address,
        items,quote_status,road_distance_km,status,
        verified_subtotal_chf,verified_at,
        quoted_delivery_fee_chf)
       VALUES ($1,$2,'AARAU','V363 LOCAL ONLY',
         '[]'::jsonb,'STANDARD',1,'PENDING_REVIEW',
         9.90,NOW(),4.50)`,
      [id, "V363-" + id]
    );

    await client.query(
      `INSERT INTO alo_now_merchant_acceptances
       (request_id,fulfillment_method,accepted_by,
        assigned_driver_id,capacity_confirmed_at,
        capacity_confirmed_until)
       VALUES ($1,'INTERNAL_DELIVERY','v363-local-test',
         NULL,NOW() - INTERVAL '2 minutes',
         CASE WHEN $2::boolean
           THEN NOW() - INTERVAL '1 minute'
           ELSE NOW() + INTERVAL '10 minutes'
         END)`,
      [id, expired]
    );

    await client.query(
      `INSERT INTO alo_now_payment_states
       (id,request_id,phase,payment_method,version,
        shopify_order_id)
       VALUES ($1,$2,'AWAITING_PAYMENT','ONLINE',1,$3)`,
      [randomUUID(), id, order]
    );

    await client.query("COMMIT");
    transaction = false;
    created.push(id);

    return {id, order};
  } catch (error) {
    if (transaction)
      await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function payment(id: string) {
  const result = await db.query<{
    phase: string;
    version: number;
  }>(
    `SELECT phase,version
     FROM alo_now_payment_states
     WHERE request_id=$1`,
    [id]
  );
  return result.rows[0];
}

async function events(id: string) {
  const result = await db.query<{n: string}>(
    `SELECT count(*)::text AS n
     FROM alo_now_payment_events e
     JOIN alo_now_payment_states p
       ON p.id=e.payment_state_id
     WHERE p.request_id=$1`,
    [id]
  );
  return Number(result.rows[0].n);
}

async function reconciliations(id: string) {
  const result = await db.query<{n: string}>(
    `SELECT count(*)::text AS n
     FROM alo_now_payment_reconciliations
     WHERE request_id=$1`,
    [id]
  );
  return Number(result.rows[0].n);
}

async function cleanup() {
  for (const id of created.reverse()) {
    const client = await db.connect();
    let active = false;
    try {
      await client.query("BEGIN");
      active = true;

      await client.query(
        `DELETE FROM alo_now_payment_events
         WHERE payment_state_id IN (
           SELECT id FROM alo_now_payment_states
           WHERE request_id=$1
         )`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_payment_reconciliations
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_merchant_acceptances
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_checkout_intents
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_payment_states
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_order_requests
         WHERE id=$1`, [id]
      );

      await client.query("COMMIT");
      active = false;
    } finally {
      if (active)
        await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
}


import express from "express";
import * as vm from "node:vm";
import * as ts from "typescript";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

test("V914 HTTP -> real PostgreSQL payment commit", async () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const routeText = readFileSync(
      "src/routes/aloNow.routes.ts", "utf8"
    );
    const authText = readFileSync(
      "src/middleware/staffAuth.ts", "utf8"
    );

    const marker = "// ALO_NOW_V907_VERIFIED_PAYMENT_ENDPOINT";
    const anchor = "// Review without acceptance:";

    assert.equal(routeText.split(marker).length, 2);
    assert.equal(routeText.split(anchor).length, 2);

    let section = routeText.split(marker)[1].split(anchor)[0];

    const dynamicImport =
      /await import\(\s*["']([^"']+)["']\s*\)/g;

    const imports = [...section.matchAll(dynamicImport)]
      .map(m => m[1]);

    assert.deepEqual(imports, [
      "../modules/aloNow/aloNowVerifiedPaymentCommit.js",
      "../modules/aloNow/aloNowLiveShopifyPaymentReader.js"
    ]);

    section = section.replace(
      dynamicImport,
      (_all, name) =>
        `await v914Import(${JSON.stringify(name)})`
    );

    const token = "alo-v914-local-test-only";
    const tokenHash = createHash("sha256")
      .update(token).digest("hex");

    let sessionReads = 0;
    let sessionWrites = 0;

    const sessionDb = {
      async query(sql: string, params: unknown[]) {
        if (/SELECT\s+s\.id\s+AS\s+session_id/i.test(sql)) {
          sessionReads++;
          assert.equal(params[0], tokenHash);

          return { rows: [{
            session_id: "v914-local-session",
            staff_user_id: "v914-local-staff",
            username: "v914",
            display_name: "V914 Local",
            role: "ADMIN",
            job_key: "admin",
            job_keys: ["admin"],
            default_workspace: "AARAU",
            allowed_workspaces: ["AARAU"],
            permissions: [],
            denied_permissions: [],
            profile_note: null,
            avatar_url: null,
            active: true,
            approved_at: null,
            approved_by: null
          }] };
        }

        if (/UPDATE\s+staff_sessions/i.test(sql)) {
          sessionWrites++;
          assert.equal(params[0], "v914-local-session");
          return { rowCount: 1, rows: [] };
        }

        throw Error("V914_UNEXPECTED_AUTH_SQL");
      }
    };

    const transpiled = ts.transpileModule(authText, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText;

    const authExports: Record<string, any> = {};

    vm.runInNewContext(transpiled, {
      exports: authExports,
      require(name: string) {
        if (name === "node:crypto")
          return { createHash };

        if (name === "../database/db.js")
          return { db: sessionDb };

        throw Error("V914_UNEXPECTED_AUTH_IMPORT");
      },
      console
    }, { timeout: 2000 });

    const valid = await fixture();
    const shopifyReader = trustedReader(valid.order);

    let commitCalls = 0;
    let readerCalls = 0;

    const overrideReaders =
      new Map<string, ShopifyPaymentReader>();

    const reader = async (order: string) => {
      readerCalls++;
      return (overrideReaders.get(order) ?? shopifyReader)(order);
    };

    const v914Import = (name: string) => {
      if (
        name ===
        "../modules/aloNow/aloNowVerifiedPaymentCommit.js"
      ) {
        return {
          commitVerifiedAloNowOnlinePayment:
            async (id: string, injectedReader: ShopifyPaymentReader) => {
              assert.equal(injectedReader, reader);
              commitCalls++;
              return commitVerifiedAloNowOnlinePayment(
                id, injectedReader
              );
            }
        };
      }

      if (
        name ===
        "../modules/aloNow/aloNowLiveShopifyPaymentReader.js"
      ) {
        return { readAloNowLiveShopifyPayment: reader };
      }

      throw Error("V914_UNEXPECTED_ROUTE_IMPORT");
    };

    const flags = {
      ALO_NOW_REQUESTS_ENABLED: "true",
      ALO_NOW_MERCHANT_ACCEPT_ENABLED: "true",
      ALO_NOW_MERCHANT_PAYMENT_ENABLED: "true",
      ALO_NOW_VERIFIED_PAYMENT_COMMIT_ENABLED: "false"
    };

    const router = express.Router();

    vm.runInNewContext(section, {
      aloNowRouter: router,
      requireStaffAuth: authExports.requireStaffAuth,
      getStaffUser: authExports.getStaffUser,
      v914Import,
      process: { env: flags },
      console
    }, { timeout: 2000 });

    const app = express();
    app.use(express.json({ limit: "8kb" }));
    app.use("/alo-now", router);

    server = await new Promise<any>((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1");
      s.once("listening", () => resolve(s));
      s.once("error", reject);
    });

    if (!server) {
      throw new Error("V914_TEST_SERVER_NOT_STARTED");
    }

    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("V914_INVALID_TEST_LISTENER");

    const endpoint =
      `http://127.0.0.1:${address.port}` +
      `/alo-now/admin/order-requests/${valid.id}` +
      "/verify-online-payment";

    async function post(id: string = valid.id) {
      const response = await fetch(endpoint.replace(valid.id, id), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: "{}"
      });

      return {
        status: response.status,
        data: await response.json()
      };
    }

    const disabled = await post();

    assert.equal(disabled.status, 503);
    assert.equal(
      disabled.data.error,
      "VERIFIED_PAYMENT_COMMIT_DISABLED"
    );
    assert.equal(commitCalls, 0);
    assert.equal(await events(valid.id), 0);

    console.log("OK: Deaktivierter Endpunkt bucht nichts.");

    flags.ALO_NOW_VERIFIED_PAYMENT_COMMIT_ENABLED = "true";

    const parallel = await Promise.all([post(), post()]);

    for (const response of parallel) {
      assert.equal(
        response.status,
        200,
        JSON.stringify(response)
      );
      assert.equal(response.data.cashCollectionAllowed, false);
      assert.equal(response.data.canConfirmCashPayment, false);
      assert.equal(response.data.deliveryDispatched, false);
    }

    const actions = parallel.map(r => r.data.action).sort();

    assert.deepEqual(
      actions,
      ["ALREADY_CONFIRMED", "CONFIRMED"].sort()
    );

    assert.equal(
      (await payment(valid.id)).phase,
      "PAYMENT_CONFIRMED"
    );

    assert.equal(await events(valid.id), 1);

    console.log("OK: Zwei parallele HTTP-Commits.");
    console.log("OK: CONFIRMED + ALREADY_CONFIRMED.");
    console.log("OK: Genau ein PostgreSQL-Zahlungsevent.");

    const repeated = await post();

    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.action, "ALREADY_CONFIRMED");
    assert.equal(await events(valid.id), 1);

    console.log("OK: HTTP-Wiederholung ohne Doppelevent.");

    assert.equal(commitCalls, 3);
    assert.equal(readerCalls, 3);
    assert.equal(sessionReads, 4);
    assert.equal(sessionWrites, 4);


    // ALO_V1708_HTTP_REFUND_CASES
    // These requests reach the actual PostgreSQL payment commit.
    // Shopify evidence and staff authentication remain simulated.

    async function verifyBlockedHttpPayment(
      kind: "refund" | "missing" | "outstanding"
    ) {
      const sample = await fixture();

      const baseline = await trustedReader(
        sample.order
      )(sample.order);

      assert.ok(baseline);

      const evidence =
        kind === "refund"
          ? {
              ...baseline,
              totalRefundedSet: {
                shopMoney: {
                  amount: "0.01",
                  currencyCode: "CHF"
                }
              }
            }
          : kind === "missing"
          ? {
              ...baseline,
              totalRefundedSet: undefined
            }
          : {
              ...baseline,
              totalOutstandingSet: {
                shopMoney: {
                  amount: "0.01",
                  currencyCode: "CHF"
                }
              }
            };

      overrideReaders.set(
        sample.order,
        async requestedOrder => {
          assert.equal(requestedOrder, sample.order);
          return evidence;
        }
      );

      const response = await post(sample.id);

      assert.equal(
        response.status,
        409,
        kind + ": " + JSON.stringify(response)
      );
      assert.equal(response.data.ok, false);
      assert.equal(
        response.data.cashCollectionAllowed,
        false
      );

      const state = await payment(sample.id);

      assert.equal(state.phase, "AWAITING_PAYMENT");
      assert.equal(state.version, 1);
      assert.equal(await events(sample.id), 0);

      console.log(
        "OK: HTTP " + kind +
        " blocked without payment mutation."
      );
    }

    await verifyBlockedHttpPayment("refund");
    await verifyBlockedHttpPayment("missing");
    await verifyBlockedHttpPayment("outstanding");

    console.log("===== V914 BESTANDEN =====");
    console.log("Express + Staff-Auth + echter PostgreSQL-Commit.");
    console.log("Shopify-Reader kontrolliert simuliert.");
    console.log("Keine Live-Zahlung und keine Bargeldfreigabe.");
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close(error =>
          error ? reject(error) : resolve()
        );
      });
      console.log("Lokaler HTTP-Server geschlossen.");
    }

    try {
      await cleanup();
      console.log("Testbestellung bereinigt.");
    } finally {
      await db.end();
    }
  }
});
