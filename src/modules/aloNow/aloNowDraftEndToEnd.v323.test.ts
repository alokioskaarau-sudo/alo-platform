import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import {
  createAloNowDraftClaimService
} from "./aloNowDraftClaimService.js";
import {
  recordAloNowDraftOutcome
} from "./aloNowDraftOutcomeService.js";
import {
  runAloNowDraftSimulation
} from "./aloNowDraftSimulation.v322.js";

if (
  process.env.ALO_RUNTIME_MODE !== "local_test" ||
  process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED !== "true" ||
  process.env.NODE_ENV !== "test" ||
  process.env.DATABASE_URL !==
    "postgresql://maxim@127.0.0.1:55433/alo_staff_test"
) {
  throw new Error("V323_LOCAL_TEST_GUARD");
}

const ids: string[] = [];

const item = {
  variantId: "gid://shopify/ProductVariant/123",
  quantity: 2,
  unitPriceCHF: 4.95,
  title: "ALO V323 TEST"
};

const cart = {
  items: [item],
  subtotalCHF: 9.90,
  currency: "CHF" as const
};

async function fixture() {
  const id = randomUUID();
  const reference = randomUUID();

  const client = await db.connect();
  let active = false;

  try {
    await client.query("BEGIN");
    active = true;

    await client.query(`
      INSERT INTO alo_now_order_requests (
        id,client_request_id,workspace,
        delivery_address,items,quote_status,
        road_distance_km,status,
        driver_user_id,driver_accepted_at,
        reservation_expires_at,
        verified_subtotal_chf,verified_at,
        quoted_delivery_fee_chf
      ) VALUES (
        $1,$2,'AARAU','V323 LOCAL TEST',
        $3::jsonb,'STANDARD',1,
        'DRIVER_ACCEPTED','v323-test-driver',
        NOW(),NOW()+INTERVAL '10 minutes',
        9.90,NOW(),4.50
      )
    `, [id, "V323-" + id, JSON.stringify([item])]);

    await client.query(`
      INSERT INTO alo_now_payment_states (
        id,request_id,phase,payment_method,version
      ) VALUES (
        $1,$2,'AWAITING_PAYMENT','ONLINE',1
      )
    `, [randomUUID(), id]);

    await client.query(`
      INSERT INTO alo_now_checkout_intents (
        request_id,checkout_reference
      ) VALUES ($1,$2)
    `, [id, reference]);

    await client.query("COMMIT");
    active = false;
    ids.push(id);

    return id;
  } catch (error) {
    if (active) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function operation(id: string) {
  return (await db.query<{
    status: string;
    draft_order_id: string | null;
    attempt_id: string | null;
    expected_total_chf: string;
  }>(`
    SELECT status,draft_order_id,attempt_id::text,
           expected_total_chf::text
    FROM alo_now_draft_operations
    WHERE request_id=$1
  `, [id])).rows[0];
}

async function cleanup() {
  const client = await db.connect();
  let active = false;

  try {
    await client.query("BEGIN");
    active = true;

    for (const id of ids) {
      await client.query(
        "DELETE FROM alo_now_draft_operations WHERE request_id=$1",
        [id]
      );
      await client.query(
        "DELETE FROM alo_now_checkout_intents WHERE request_id=$1",
        [id]
      );
      await client.query(
        "DELETE FROM alo_now_payment_states WHERE request_id=$1",
        [id]
      );
      await client.query(
        "DELETE FROM alo_now_order_requests WHERE id=$1",
        [id]
      );
    }

    await client.query("COMMIT");
    active = false;

    const remaining = await db.query<{ total: number }>(`
      SELECT COUNT(*)::int AS total
      FROM alo_now_order_requests
      WHERE id=ANY($1::uuid[])
    `, [ids]);

    assert.equal(remaining.rows[0].total, 0);
    console.log("OK: Alle V323-Testdaten entfernt.");
  } catch (error) {
    if (active) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error("CLEANUP FEHLGESCHLAGEN. Test-IDs:");
    console.error(ids.join("\n"));
    throw error;
  } finally {
    client.release();
  }
}

const claim = createAloNowDraftClaimService(
  async () => cart
);

let sends = 0;

function sender(draftId: string) {
  return async () => {
    sends++;

    return {
      data: {
        draftOrderCreate: {
          draftOrder: {
            id: draftId,
            invoiceUrl:
              "https://example.myshopify.com/invoice/v323",
            totalPriceSet: {
              shopMoney: {
                amount: "14.40",
                currencyCode: "CHF"
              }
            }
          },
          userErrors: []
        }
      }
    };
  };
}

async function main() {
  const identity = (await db.query<{
    name:string;
    host:string;
    port:number;
  }>(`
    SELECT current_database() AS name,
           host(inet_server_addr()) AS host,
           inet_server_port() AS port
  `)).rows[0];

  assert.equal(identity.name, "alo_staff_test");
  assert.equal(identity.host, "127.0.0.1");
  assert.equal(Number(identity.port), 55433);

  console.log("OK: Lokale PostgreSQL-Testdatenbank.");

  // 1. Complete local flow.
  const id = await fixture();
  const draftId = "gid://shopify/DraftOrder/323001";

  const success = await runAloNowDraftSimulation(id, {
    claim,
    recordOutcome:recordAloNowDraftOutcome,
    simulatedSender:sender(draftId)
  });

  assert.deepEqual(success, {
    ok:true,
    status:"CREATED",
    draftOrderId:draftId
  });

  const saved = await operation(id);
  assert.equal(saved.status,"CREATED");
  assert.equal(saved.draft_order_id,draftId);
  assert.equal(saved.expected_total_chf,"14.40");
  assert.ok(saved.attempt_id);

  console.log("OK: Echte Claims und Outcomes in PostgreSQL.");

  // 2. Same request cannot run a second creation.
  const previousSends = sends;

  const retry = await runAloNowDraftSimulation(id, {
    claim,
    recordOutcome:recordAloNowDraftOutcome,
    simulatedSender:sender("gid://shopify/DraftOrder/323099")
  });

  assert.deepEqual(retry, {
    ok:false,
    reason:"DRAFT_ALREADY_CLAIMED"
  });
  assert.equal(sends,previousSends);

  console.log("OK: Zweite Erstellung verhindert.");

  // 3. Unknown Shopify outcome requires reconciliation.
  const timeoutId = await fixture();

  const timeout = await runAloNowDraftSimulation(timeoutId, {
    claim,
    recordOutcome:recordAloNowDraftOutcome,
    simulatedSender:async () => {
      sends++;
      throw new Error("SIMULATED_TIMEOUT");
    }
  });

  assert.deepEqual(timeout, {
    ok:true,
    status:"RECONCILE_REQUIRED"
  });

  const unknown = await operation(timeoutId);
  assert.equal(unknown.status,"RECONCILE_REQUIRED");
  assert.equal(unknown.draft_order_id,null);

  console.log("OK: Netzwerkfehler dauerhaft gesperrt.");

  const beforeRetry = sends;

  const unsafeRetry = await runAloNowDraftSimulation(timeoutId, {
    claim,
    recordOutcome:recordAloNowDraftOutcome,
    simulatedSender:sender("gid://shopify/DraftOrder/323098")
  });

  assert.deepEqual(unsafeRetry, {
    ok:false,
    reason:"DRAFT_ALREADY_CLAIMED"
  });
  assert.equal(sends,beforeRetry);

  console.log("OK: Kein automatischer Retry nach Timeout.");

  // 4. Concurrent attempts must never both send.
  const parallelId = await fixture();
  const parallelDraft = "gid://shopify/DraftOrder/323002";

  const calls = await Promise.all([
    runAloNowDraftSimulation(parallelId, {
      claim,
      recordOutcome:recordAloNowDraftOutcome,
      simulatedSender:sender(parallelDraft)
    }),
    runAloNowDraftSimulation(parallelId, {
      claim,
      recordOutcome:recordAloNowDraftOutcome,
      simulatedSender:sender(parallelDraft)
    })
  ]);

  assert.equal(calls.filter(x=>x.ok).length,1);
  assert.equal((await operation(parallelId)).status,"CREATED");

  console.log("OK: Parallele Checkout-Erstellungen gesperrt.");

  console.log("===== V323 – E2E TESTS BESTANDEN =====");
}

try {
  await main();
} finally {
  try {
    await cleanup();
  } finally {
    await db.end();
  }
}
