import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {db} from "../../database/db.js";
import {
  createAloNowLocalDraftRunnerV360
} from "./aloNowLocalDraftRunner.v360.js";

const created: string[] = [];
const variantId = "gid://shopify/ProductVariant/123";
const item = {
  variantId,
  quantity: 2,
  unitPriceCHF: 4.95,
  title: "ALO V360 LOCAL TEST"
};

async function fixture() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO alo_now_order_requests
       (id,client_request_id,workspace,
        delivery_address,items,quote_status,
        road_distance_km,status,
        driver_user_id,driver_accepted_at,
        reservation_expires_at,
        verified_subtotal_chf,verified_at,
        quoted_delivery_fee_chf)
     VALUES ($1,$2,'AARAU','V360 LOCAL TEST',
             $3::jsonb,'STANDARD',1,
             'DRIVER_ACCEPTED','v360-test-driver',
             NOW(),NOW()+INTERVAL '10 minutes',
             9.90,NOW(),4.50)`,
    [id, "V360-" + id, JSON.stringify([item])]
  );
  created.push(id);

  await db.query(
    `INSERT INTO alo_now_payment_states
       (id,request_id,phase,payment_method,version)
     VALUES ($1,$2,'AWAITING_PAYMENT','ONLINE',1)`,
    [randomUUID(), id]
  );
  return id;
}

async function readCart(lines: Array<{
  variantId:string;
  quantity:number;
}>) {
  assert.deepEqual(lines, [{variantId, quantity:2}]);
  return {
    items:[item],
    subtotalCHF:9.90,
    currency:"CHF" as const
  };
}

function response(total: string) {
  return {
    data:{
      draftOrderCreate:{
        userErrors:[],
        draftOrder:{
          id:"gid://shopify/DraftOrder/360123",
          invoiceUrl:"https://example.myshopify.com/invoice/v360",
          totalPriceSet:{
            shopMoney:{amount:total,currencyCode:"CHF"}
          }
        }
      }
    }
  };
}

async function operation(id:string) {
  const result = await db.query<{
    status:string;
    draft_order_id:string|null;
  }>(
    `SELECT status,draft_order_id
     FROM alo_now_draft_operations
     WHERE request_id=$1`,
    [id]
  );
  return result.rows[0];
}

test("V360 PostgreSQL checkout integration", async () => {
  try {
    const id = await fixture();
    let sends = 0;

    const run = createAloNowLocalDraftRunnerV360(
      readCart,
      async (_graphql, amount) => {
        sends++;
        assert.equal(amount,"14.40");
        return response(amount);
      }
    );

    const first = await run(id);
    assert.equal(first.ok,true,JSON.stringify(first));

    const stored = await operation(id);
    assert.equal(stored.status,"CREATED");
    assert.equal(
      stored.draft_order_id,
      "gid://shopify/DraftOrder/360123"
    );

    const second = await run(id);
    assert.equal(second.ok,false);
    assert.equal(sends,1,"Second Shopify send prohibited");

    const timeoutId = await fixture();
    const failing = createAloNowLocalDraftRunnerV360(
      readCart,
      async () => { throw new Error("SIMULATED_TIMEOUT"); }
    );

    const failed = await failing(timeoutId);
    assert.deepEqual(
      failed,
      {ok:false,reason:"RECONCILE_REQUIRED"}
    );
    assert.equal(
      (await operation(timeoutId)).status,
      "RECONCILE_REQUIRED"
    );

    console.log("OK: DB-Intent und Claim.");
    console.log("OK: Draft-Ergebnis persistent CREATED.");
    console.log("OK: Zweiter Aufruf sendet nicht erneut.");
    console.log("OK: Timeout dauerhaft RECONCILE_REQUIRED.");
  } finally {
    for (const id of created.reverse()) {
      await db.query(
        "DELETE FROM alo_now_draft_operations WHERE request_id=$1",
        [id]
      );
      await db.query(
        "DELETE FROM alo_now_checkout_intents WHERE request_id=$1",
        [id]
      );
      await db.query(
        "DELETE FROM alo_now_payment_states WHERE request_id=$1",
        [id]
      );
      await db.query(
        "DELETE FROM alo_now_order_requests WHERE id=$1",
        [id]
      );
    }
    await db.end();
  }
});
