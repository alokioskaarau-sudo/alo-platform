
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  createWebhookEvent,
  claimOrderScopedPaidWebhookV383
} from "./shopifyWebhookEvents.js";

test("V383 order-scoped paid webhook claim", async () => {
  const u = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55433");
  assert.equal(u.pathname, "/alo_staff_test");

  const ids: string[] = [];
  const order1 = "gid://shopify/Order/9" + Date.now();
  const order2 = "gid://shopify/Order/8" + Date.now();

  async function fixture(orderId: string) {
    const result = await createWebhookEvent({
      webhookId: "V383-" + randomUUID(),
      topic: "orders/paid",
      orderId
    });
    assert.equal(result.created, true);
    ids.push(result.event.id);
    return result.event.id;
  }

  try {
    const a = await fixture(order1);
    const b = await fixture(order1);

    const claims = await Promise.all([
      claimOrderScopedPaidWebhookV383(a, order1),
      claimOrderScopedPaidWebhookV383(b, order1)
    ]);

    assert.equal(claims.filter(Boolean).length, 1);

    const result = await db.query(
      `SELECT status, attempts
       FROM shopify_webhook_events
       WHERE id=ANY($1::bigint[])
       ORDER BY id`,
      [ids]
    );

    assert.equal(
      result.rows.filter(x => x.status === "PROCESSING").length,
      1
    );
    assert.equal(
      result.rows.filter(x => x.status === "PENDING").length,
      1
    );
    assert.equal(
      result.rows.reduce(
        (sum, x) => sum + Number(x.attempts), 0
      ),
      1
    );

    console.log("OK: Zwei Webhook-IDs, ein Order-Claim.");

    const c = await fixture(order2);

    assert.equal(
      await claimOrderScopedPaidWebhookV383(c, order2),
      true
    );
    console.log("OK: Andere Bestellung unabhängig startbar.");

    assert.equal(
      await claimOrderScopedPaidWebhookV383(a, order2),
      false
    );
    console.log("OK: Falsche Order-Zuordnung blockiert.");

    const blocking = claims[0] ? a : b;

    await db.query(
      `UPDATE shopify_webhook_events
       SET status='FAILED'
       WHERE id=$1`,
      [blocking]
    );

    const other = await fixture(order1);
    assert.equal(
      await claimOrderScopedPaidWebhookV383(other, order1),
      false
    );
    console.log("OK: FAILED erzwingt Recovery statt Neuverarbeitung.");

    console.log("===== V383 TEST BESTANDEN =====");
  } finally {
    for (const id of ids) {
      await db.query(
        "DELETE FROM shopify_webhook_events WHERE id=$1",
        [id]
      );
    }
    await db.end();
  }
});
