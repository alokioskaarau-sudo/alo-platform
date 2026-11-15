
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  claimStaffPushEvent,
  markStaffPushEventSent,
  markStaffPushEventFailed
} from "./staffPush.js";

test("V376: reale Push-Idempotenz", async () => {
  const u = new URL(process.env.DATABASE_URL ?? "");

  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.ALO_RUNTIME_MODE, "local_test");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "55433");
  assert.equal(u.pathname, "/alo_staff_test");
  assert.equal(u.search, "");
  assert.equal(u.hash, "");

  const keys: string[] = [];

  async function createKey() {
    const key = "V376_TEST_" + randomUUID();
    keys.push(key);
    return key;
  }

  async function status(key: string) {
    const result = await db.query<{
      status: string;
      error_message: string | null;
    }>(
      `SELECT status,error_message
       FROM staff_push_events
       WHERE event_key=$1`,
      [key]
    );
    return result.rows[0];
  }

  try {
    const parallel = await createKey();

    const claims = await Promise.all([
      claimStaffPushEvent(parallel, "V376_TEST", null),
      claimStaffPushEvent(parallel, "V376_TEST", null)
    ]);

    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await status(parallel)).status, "PENDING");
    console.log("OK: Parallele Reservierung genau einmal.");

    await markStaffPushEventSent(parallel);
    assert.equal((await status(parallel)).status, "SENT");
    assert.equal(
      await claimStaffPushEvent(parallel, "V376_TEST", null),
      false
    );
    console.log("OK: SENT darf nicht erneut versendet werden.");

    const uncertain = await createKey();
    assert.equal(
      await claimStaffPushEvent(uncertain, "V376_TEST", null),
      true
    );

    await markStaffPushEventFailed(
      uncertain,
      "EXPO_TRANSPORT_UNCONFIRMED"
    );

    assert.equal(
      await claimStaffPushEvent(uncertain, "V376_TEST", null),
      false
    );
    assert.equal((await status(uncertain)).status, "FAILED");
    console.log("OK: Ungewisser Versand wird nicht wiederholt.");

    const noTokens = await createKey();
    assert.equal(
      await claimStaffPushEvent(noTokens, "V376_TEST", null),
      true
    );

    await markStaffPushEventFailed(
      noTokens,
      "NO_ACTIVE_PUSH_TOKENS"
    );

    assert.equal(
      await claimStaffPushEvent(noTokens, "V376_TEST", null),
      true
    );
    assert.equal((await status(noTokens)).status, "PENDING");

    assert.equal(
      await claimStaffPushEvent(noTokens, "V376_TEST", null),
      false
    );
    console.log("OK: NO_ACTIVE_PUSH_TOKENS genau einmal erneut reservierbar.");

    console.log("===== V376 TEST BESTANDEN =====");
  } finally {
    for (const key of keys) {
      await db.query(
        "DELETE FROM staff_push_events WHERE event_key=$1",
        [key]
      );
    }
    await db.end();
  }
});
