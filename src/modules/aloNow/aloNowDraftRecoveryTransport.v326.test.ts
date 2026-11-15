import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readAloNowDraftRecoveryV326} from
  "./aloNowDraftRecoveryTransport.v326.js";

const identity={
  requestId:randomUUID(),
  checkoutReference:randomUUID(),
  expectedTotalCHF:"14.40"
};

let tokenReads=0;
let requests=0;

const deps={
  shop:"alo-test.myshopify.com",
  getAccessToken:async()=>{
    tokenReads++;
    return "offline-token-only-12345";
  },
  post:async(
    url:string,
    init:{
      method:"POST";
      headers:Record<string,string>;
      body:string;
      signal:AbortSignal;
    }
  )=>{
    requests++;
    assert.equal(
      url,
      "https://alo-test.myshopify.com/admin/api/2026-07/graphql.json"
    );
    assert.equal(init.method,"POST");
    assert.equal(
      init.headers["X-Shopify-Access-Token"],
      "offline-token-only-12345"
    );
    const body=JSON.parse(init.body);
    assert.match(body.query,/query AloNowDraftRecovery/);
    assert.doesNotMatch(body.query,/\bmutation\b/i);
    assert.equal(body.variables.after,null);

    return {
      ok:true,
      status:200,
      json:async()=>({
        data:{
          draftOrders:{
            nodes:[{
              id:"gid://shopify/DraftOrder/326001",
              customAttributes:[
                {key:"alo_now_request_id",value:identity.requestId},
                {key:"alo_now_checkout_reference",
                 value:identity.checkoutReference}
              ],
              totalPriceSet:{
                shopMoney:{amount:"14.40",currencyCode:"CHF"},
                presentmentMoney:{amount:"14.40",currencyCode:"CHF"}
              }
            }],
            pageInfo:{hasNextPage:false,endCursor:null}
          }
        }
      })
    };
  }
};

assert.deepEqual(
  await readAloNowDraftRecoveryV326(identity,deps),
  {status:"FOUND",draftOrderId:"gid://shopify/DraftOrder/326001"}
);
assert.equal(requests,1);
assert.equal(tokenReads,1);
console.log("OK: Authentifizierter Read-only-GraphQL-Vertrag.");

const invalid=await readAloNowDraftRecoveryV326(identity,{
  ...deps,
  shop:"evil.example.com"
});
assert.deepEqual(invalid,{
  status:"INCONCLUSIVE",reason:"INVALID_SHOP"
});
assert.equal(requests,1);
console.log("OK: Fremde Domain ohne HTTP blockiert.");

const auth=await readAloNowDraftRecoveryV326(identity,{
  ...deps,
  getAccessToken:async()=>{throw new Error("AUTH_FAIL");}
});
assert.deepEqual(auth,{
  status:"INCONCLUSIVE",reason:"AUTH_UNAVAILABLE"
});
assert.equal(requests,1);
console.log("OK: Fehlende Authentifizierung blockiert.");

const timeout=await readAloNowDraftRecoveryV326(identity,{
  ...deps,
  post:async()=>{throw new Error("TIMEOUT");}
});
assert.deepEqual(timeout,{
  status:"INCONCLUSIVE",reason:"READ_FAILED"
});
console.log("OK: Timeout bleibt unbestätigt.");

const absent=await readAloNowDraftRecoveryV326(identity,{
  ...deps,
  post:async()=>({
    ok:true,
    status:200,
    json:async()=>({
      data:{draftOrders:{
        nodes:[],
        pageInfo:{hasNextPage:false,endCursor:null}
      }}
    })
  })
});
assert.deepEqual(absent,{status:"NOT_FOUND_UNCONFIRMED"});
console.log("OK: Leere Suche erlaubt keinen Retry.");

console.log("===== V326 – ALLE TESTS BESTANDEN =====");
