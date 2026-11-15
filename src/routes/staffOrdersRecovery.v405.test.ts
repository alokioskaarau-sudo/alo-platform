
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

test("V405 recovery endpoints reject unauthenticated HTTP", async () => {
  const dbUrl = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(dbUrl.hostname, "127.0.0.1");
  assert.equal(dbUrl.port, "55433");
  assert.equal(dbUrl.pathname, "/alo_staff_test");

  const module = await import("./staffOrders.routes.js");

  const router =
    Object.values(module).find((value: unknown) => (
      typeof value === "function" &&
      "stack" in value
    )) as express.Router | undefined;

  assert.ok(router, "Staff-Orders-Router nicht gefunden");

  const app = express();
  app.disable("x-powered-by");
  app.use("/api/staff/orders", router);

  const server: Server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      resolve(instance);
    });
    instance.once("error", reject);
  });

  try {
    const address = server.address();

    assert.ok(
      address !== null &&
      typeof address !== "string"
    );

    const root =
      "http://127.0.0.1:" + address.port;

    const paths = [
      "/api/staff/orders/recovery",
      "/api/staff/orders/recovery?limit=5",
      "/api/staff/orders/recovery/gid%3A%2F%2Fshopify%2FOrder%2F123456",
    ];

    for (const path of paths) {
      const response = await fetch(root + path, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(5000)
      });

      assert.ok(
        response.status === 401 ||
        response.status === 403,
        `${path}: erwartete 401/403, erhalten ${response.status}`
      );

      console.log(
        "OK: Ohne Anmeldung blockiert:",
        path,
        "HTTP", response.status
      );
    }

    console.log("===== V405 HTTP AUTH BESTANDEN =====");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
