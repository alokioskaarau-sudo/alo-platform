import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import {
  recordAloNowDraftOutcome
} from "./aloNowDraftOutcomeService.js";

const ids: string[] = [];

async function fixture() {
  const id = randomUUID();
  const reference = randomUUID();
  const attempt = randomUUID();

  const client = await db.connect();
  let active = false;

  try {
    await client.query("BEGIN");
    active = true;

    await client.query(`
      INSERT INTO alo_now_order_requests
        (id,client_request_id,workspace,
         delivery_address,items,quote_status,
         road_distance_km,status)
      VALUES
        ($1,$2,'AARAU','V321 LOCAL TEST',
         '[]'::jsonb,'STANDARD',0,'PENDING_REVIEW')
    `, [id, "V321-" + id]);

    await client.query(`
      INSERT INTO alo_now_checkout_intents
        (request_id,checkout_reference)
      VALUES ($1,$2)
    `, [id, reference]);

    await client.query(`
      INSERT INTO alo_now_draft_operations
        (request_id,checkout_reference,expected_total_chf)
      VALUES ($1,$2,14.40)
    `, [id, reference]);

    await client.query(`
      UPDATE alo_now_draft_operations
      SET status='CREATING',attempt_id=$2
      WHERE request_id=$1 AND status='PREPARED'
    `, [id, attempt]);

    await client.query("COMMIT");
    active = false;
    ids.push(id);

    return { id, attempt };
  } catch (error) {
    if (active)
      await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function response(draftId: string, amount = "14.40") {
  return {
    data: {
      draftOrderCreate: {
        draftOrder: {
          id: draftId,
          invoiceUrl: "https://example.myshopify.com/invoice/test",
          totalPriceSet: {
            shopMoney: {
              amount,
              currencyCode: "CHF"
            }
          }
        },
        userErrors: []
      }
    }
  };
}

async function status(id: string) {
  return (await db.query<{
    status: string;
    draft_order_id: string | null;
  }>(
    `SELECT status,draft_order_id
     FROM alo_now_draft_operations
     WHERE request_id=$1`,
    [id]
  )).rows[0];
}

async function cleanup() {
  if (!ids.length) return;

  const client = await db.connect();
  let active = false;

  try {
    await client.query("BEGIN");
    active = true;

    for (const id of ids) {
      await client.query(
        `DELETE FROM alo_now_draft_operations
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_checkout_intents
         WHERE request_id=$1`, [id]
      );
      await client.query(
        `DELETE FROM alo_now_order_requests
         WHERE id=$1`, [id]
      );
    }

    await client.query("COMMIT");
    active = false;

    const count = await client.query<{total:number}>(
      `SELECT COUNT(*)::int AS total
       FROM alo_now_order_requests
       WHERE id=ANY($1::uuid[])`,
      [ids]
    );

    assert.equal(count.rows[0].total, 0);
    console.log("OK: Sämtliche V321-Testdaten entfernt.");
  } catch (error) {
    if (active)
      await client.query("ROLLBACK").catch(() => {});
    console.error("CLEANUP-FEHLER. Test-IDs:", ids.join(", "));
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  console.log("===== V321 – OUTCOME INTEGRATION TEST =====");

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
  console.log("OK: Lokale Testdatenbank bestätigt.");

  const one = await fixture();
  const draftId = "gid://shopify/DraftOrder/321001";

  const wrong = await recordAloNowDraftOutcome(
    one.id, randomUUID(), response(draftId)
  );

  assert.equal(wrong.ok, false);
  assert.equal((await status(one.id)).status, "CREATING");
  console.log("OK: Fremde attemptId blockiert.");

  const good = await recordAloNowDraftOutcome(
    one.id, one.attempt, response(draftId)
  );

  assert.deepEqual(good, {
    ok:true,
    status:"CREATED",
    draftOrderId:draftId
  });

  assert.deepEqual(await status(one.id), {
    status:"CREATED",
    draft_order_id:draftId
  });
  console.log("OK: Gültiges Ergebnis atomar gespeichert.");

  const repeat = await recordAloNowDraftOutcome(
    one.id, one.attempt, response(draftId)
  );

  assert.equal(repeat.ok, false);
  console.log("OK: Wiederholte Verarbeitung blockiert.");

  const two = await fixture();

  const uncertain = await recordAloNowDraftOutcome(
    two.id, two.attempt, null
  );

  assert.deepEqual(uncertain, {
    ok:true,
    status:"RECONCILE_REQUIRED"
  });

  assert.deepEqual(await status(two.id), {
    status:"RECONCILE_REQUIRED",
    draft_order_id:null
  });
  console.log("OK: Unklare Antwort gesperrt.");

  const delayed = await recordAloNowDraftOutcome(
    two.id,
    two.attempt,
    response("gid://shopify/DraftOrder/321002")
  );

  assert.equal(delayed.ok, false);
  console.log("OK: Nachträgliches Überschreiben blockiert.");

  const three = await fixture();

  const mismatch = await recordAloNowDraftOutcome(
    three.id,
    three.attempt,
    response("gid://shopify/DraftOrder/321003", "15.40")
  );

  assert.deepEqual(mismatch, {
    ok:true,
    status:"RECONCILE_REQUIRED"
  });

  console.log("OK: Betragabweichung nicht als CREATED gespeichert.");

  const four = await fixture();

  const concurrent = await Promise.all([
    recordAloNowDraftOutcome(
      four.id,
      four.attempt,
      response("gid://shopify/DraftOrder/321004")
    ),
    recordAloNowDraftOutcome(
      four.id,
      four.attempt,
      response("gid://shopify/DraftOrder/321004")
    )
  ]);

  assert.equal(concurrent.filter(x => x.ok).length, 1);
  assert.equal((await status(four.id)).status, "CREATED");

  console.log("OK: Gleichzeitige Ergebnisse nur einmal gespeichert.");
  console.log("===== V321 ALLE TESTS BESTANDEN =====");
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
