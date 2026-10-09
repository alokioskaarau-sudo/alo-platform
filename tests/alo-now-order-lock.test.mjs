import test from "node:test";
import assert from "node:assert/strict";

function createHarness() {
  const held = new Set();
  const waiting = new Map();
  const events = [];
  let failUnlock = false;

  const db = {
    async connect() {
      return {
        async query(sql, params) {
          const key = params?.join(":");

          if (sql.includes("pg_advisory_lock(")) {
            while (held.has(key)) {
              await new Promise(resolve => {
                const list = waiting.get(key) || [];
                list.push(resolve);
                waiting.set(key, list);
              });
            }
            held.add(key);
            events.push("lock:" + key);
            return { rows: [{ locked: true }] };
          }

          if (sql.includes("pg_advisory_unlock(")) {
            if (failUnlock) throw new Error("UNLOCK_CONNECTION_ERROR");
            const existed = held.delete(key);
            events.push("unlock:" + key);
            for (const resolve of waiting.get(key) || []) resolve();
            waiting.delete(key);
            return { rows: [{ unlocked: existed }] };
          }

          throw new Error("Unexpected SQL: " + sql);
        },
        release(discard) {
          events.push("release:" + Boolean(discard));
        }
      };
    }
  };

  async function run(orderId, work) {
  // ALO_ORDER_PIPELINE_LOCK_V1
  // Exklusive Verarbeitung pro Shopify-Bestellung.
  const lockClient = await db.connect();
  let lockAcquired = false;
  let discardConnection = false;

  try {
    await lockClient.query(
      "SELECT pg_advisory_lock(hashtext($1::text), hashtext($2::text))",
      ["alo-paid-order", String(orderId)]
    );
    lockAcquired = true;



    return await work(events);
  } finally {
    try {
      if (lockAcquired) {
        const unlockResult = await lockClient.query(
          "SELECT pg_advisory_unlock(hashtext($1::text), hashtext($2::text)) AS unlocked",
          ["alo-paid-order", String(orderId)]
        );
        if (unlockResult.rows[0]?.unlocked !== true) {
          throw new Error("ALO_ORDER_PIPELINE_UNLOCK_FAILED");
        }
      }
    } catch (unlockError) {
      discardConnection = true;
      throw unlockError;
    } finally {
      lockClient.release(discardConnection);
    }
  }
  }

  return {
    run,
    events,
    setFailUnlock(value) { failUnlock = value; }
  };
}

test("Gleiche Bestell-ID wird serialisiert", async () => {
  const h = createHarness();
  let finishFirst;
  const first = h.run("100", async events => {
    events.push("work:first");
    await new Promise(resolve => { finishFirst = resolve; });
  });

  await new Promise(resolve => setImmediate(resolve));
  const second = h.run("100", async events => {
    events.push("work:second");
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.events.includes("work:second"), false);
  finishFirst();
  await Promise.all([first, second]);

  assert.ok(
    h.events.indexOf("work:second") >
    h.events.indexOf("unlock:alo-paid-order:100")
  );
});

test("Unterschiedliche Bestell-IDs laufen parallel", async () => {
  const h = createHarness();
  let finishFirst;
  const first = h.run("100", async events => {
    events.push("work:first");
    await new Promise(resolve => { finishFirst = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));

  await h.run("200", async events => {
    events.push("work:second");
  });

  assert.equal(h.events.includes("work:second"), true);
  finishFirst();
  await first;
});

test("Fehler gibt die Sperre frei", async () => {
  const h = createHarness();
  await assert.rejects(
    h.run("100", async () => { throw new Error("WORK_ERROR"); }),
    /WORK_ERROR/
  );
  await h.run("100", async () => {});
  assert.equal(
    h.events.filter(x => x === "unlock:alo-paid-order:100").length,
    2
  );
});

test("Unlock-Fehler verwirft Verbindung", async () => {
  const h = createHarness();
  h.setFailUnlock(true);
  await assert.rejects(h.run("100", async () => {}), /UNLOCK_CONNECTION_ERROR/);
  assert.ok(h.events.includes("release:true"));
});
