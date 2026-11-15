
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  createWebhookEvent,
  claimPendingPaidWebhookV380
} from "./shopifyWebhookEvents.js";

test("V380 atomic paid-webhook claim", async () => {
  const u = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55433");
  assert.equal(u.pathname, "/alo_staff_test");
  assert.equal(u.search, "");
  assert.equal(u.hash, "");

  const ids: string[] = [];

  async function fixture(topic = "orders/paid") {
    const result = await createWebhookEvent({
      webhookId: "V380-" + randomUUID(),
      topic,
      orderId: topic === "orders/paid"
        ? "gid://shopify/Order/987654321"
        : undefined
    });

    assert.equal(result.created, true);
    ids.push(result.event.id);
    return result.event.id;
  }

  try {
    const id = await fixture();

    const claims = await Promise.all([
      claimPendingPaidWebhookV380(id),
      claimPendingPaidWebhookV380(id)
    ]);

    assert.equal(claims.filter(Boolean).length, 1);

    const state = await db.query(
      `SELECT status,attempts
       FROM shopify_webhook_events
       WHERE id=$1`,
      [id]
    );

    assert.equal(state.rows[0].status, "PROCESSING");
    assert.equal(Number(state.rows[0].attempts), 1);

    assert.equal(await claimPendingPaidWebhookV380(id), false);
    console.log("OK: Zwei parallele Worker, ein Claim.");

    await db.query(
      `UPDATE shopify_webhook_events
       SET status='COMPLETED'
       WHERE id=$1`,
      [id]
    );

    assert.equal(await claimPendingPaidWebhookV380(id), false);
    console.log("OK: COMPLETED bleibt gesperrt.");

    const failed = await fixture();

    await db.query(
      `UPDATE shopify_webhook_events
       SET status='FAILED'
       WHERE id=$1`,
      [failed]
    );

    assert.equal(
      await claimPendingPaidWebhookV380(failed),
      false
    );
    console.log("OK: FAILED wird nicht blind wiederholt.");

    const other = await fixture("products/update");

    assert.equal(
      await claimPendingPaidWebhookV380(other),
      false
    );
    console.log("OK: Andere Webhook-Themen bleiben geschützt.");

    console.log("===== V380 INTEGRATIONSTEST BESTANDEN =====");
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
