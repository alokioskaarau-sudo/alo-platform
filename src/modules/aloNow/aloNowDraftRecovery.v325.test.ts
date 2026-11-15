import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {
  isAloNowRecoveryUuid,
  locateAloNowDraftV325,
  ALO_NOW_DRAFT_RECOVERY_QUERY
} from "./aloNowDraftRecovery.v325.js";

const requestId = randomUUID();
const checkoutReference = randomUUID();

assert.equal(isAloNowRecoveryUuid(requestId),true);
assert.equal(isAloNowRecoveryUuid(checkoutReference),true);
assert.equal(isAloNowRecoveryUuid("not-a-uuid"),false);
assert.equal(
  isAloNowRecoveryUuid("aaaaaaaa-bbbb-cccc-dddddddddddd"),
  false
);
console.log("OK: Korrekte UUID-Validierung (8-4-4-4-12).");

const identity = {
  requestId,
  checkoutReference,
  expectedTotalCHF:"14.40"
};

function draft(id:string, amount="14.40") {
  return {
    id:`gid://shopify/DraftOrder/${id}`,
    customAttributes:[
      {key:"alo_now_request_id",value:requestId},
      {key:"alo_now_checkout_reference",value:checkoutReference}
    ],
    totalPriceSet:{
      shopMoney:{amount,currencyCode:"CHF"},
      presentmentMoney:{amount,currencyCode:"CHF"}
    }
  };
}

function page(
  nodes:unknown[],
  more=false,
  cursor:string|null=null
) {
  return {
    data:{
      draftOrders:{
        nodes,
        pageInfo:{
          hasNextPage:more,
          endCursor:cursor
        }
      }
    }
  };
}

assert.match(ALO_NOW_DRAFT_RECOVERY_QUERY,/tag:ALO_NOW/);
assert.doesNotMatch(ALO_NOW_DRAFT_RECOVERY_QUERY,/mutation/i);

const found = await locateAloNowDraftV325(
  identity, async()=>page([draft("325001")])
);

assert.deepEqual(found,{
  status:"FOUND",
  draftOrderId:"gid://shopify/DraftOrder/325001"
});
console.log("OK: Eindeutigen Draft erkannt.");

assert.deepEqual(
  await locateAloNowDraftV325(identity,async()=>page([])),
  {status:"NOT_FOUND_UNCONFIRMED"}
);
console.log("OK: Kein Treffer bleibt unbestätigt.");

assert.deepEqual(
  await locateAloNowDraftV325(
    identity,
    async()=>page([draft("325001"),draft("325002")])
  ),
  {status:"AMBIGUOUS"}
);
console.log("OK: Mehrere passende Drafts blockiert.");

assert.deepEqual(
  await locateAloNowDraftV325(
    identity,
    async()=>page([draft("325001","15.40")])
  ),
  {
    status:"INCONCLUSIVE",
    reason:"MATCHED_TOTAL_MISMATCH"
  }
);
console.log("OK: Betragabweichung blockiert.");

let reads=0;

const paginated = await locateAloNowDraftV325(
  identity,
  async after=>{
    reads++;
    return after===null
      ? page([{...draft("325000"),customAttributes:[]}],true,"next")
      : page([draft("325001")]);
  }
);

assert.equal(paginated.status,"FOUND");
assert.equal(reads,2);
console.log("OK: Pagination funktioniert.");

assert.deepEqual(
  await locateAloNowDraftV325(
    identity,
    async()=>{throw new Error("SIMULATED_FAILURE");}
  ),
  {status:"INCONCLUSIVE",reason:"READ_FAILED"}
);
console.log("OK: Lesefehler blockiert.");

assert.deepEqual(
  await locateAloNowDraftV325(
    identity,async()=>({data:null})
  ),
  {status:"INCONCLUSIVE",reason:"BAD_RESPONSE"}
);
console.log("OK: Ungültige API-Antwort blockiert.");

console.log("===== V325B – ALLE TESTS BESTANDEN =====");
