import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {
  buildAloNowDraftOrderPayload
} from "./aloNowDraftOrderPayload.js";
import {
  buildAloNowDraftGraphqlRequest
} from "./aloNowDraftOrderAdapter.js";
import {
  simulateAloNowDraftHttpV324,
  createAloNowShopifyDraftV324
} from "./aloNowShopifyDraftTransport.v324.js";

const id=randomUUID();
const ref=randomUUID();

const item={
  variantId:"gid://shopify/ProductVariant/123",
  quantity:2,
  unitPriceCHF:4.95,
  title:"ALO V324 TEST"
};

const built=buildAloNowDraftOrderPayload({
  requestId:id,
  checkoutReference:ref,
  storedItems:[item],
  freshCart:{
    items:[item],
    subtotalCHF:9.90,
    currency:"CHF"
  },
  verifiedSubtotalCHF:"9.90",
  deliveryFeeCHF:"4.50"
});

const req=buildAloNowDraftGraphqlRequest(
  built.draftInput
);

const draftId="gid://shopify/DraftOrder/324001";
const reply={
  data:{
    draftOrderCreate:{
      draftOrder:{
        id:draftId,
        invoiceUrl:
          "https://example.myshopify.com/invoice/324001",
        totalPriceSet:{
          shopMoney:{
            amount:"14.40",
            currencyCode:"CHF"
          }
        }
      },
      userErrors:[]
    }
  }
};

const oldMode=process.env.ALO_RUNTIME_MODE;
const oldNode=process.env.NODE_ENV;
const oldFlag=process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED;

try {
  process.env.NODE_ENV="test";
  process.env.ALO_RUNTIME_MODE="local_test";
  process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED="true";

  let calls=0;
  const mockPost=async (
    url:string,
    init:{
      method:"POST";
      headers:Record<string,string>;
      body:string;
      signal:AbortSignal;
    }
  )=>{
    calls++;
    assert.equal(
      url,
      "https://alo-test.myshopify.com/admin/api/2026-07/graphql.json"
    );
    assert.equal(init.method,"POST");
    assert.equal(
      init.headers["X-Shopify-Access-Token"],
      "test-token-123456789"
    );

    const parsed=JSON.parse(init.body);
    assert.equal(
      parsed.variables.input.shippingLine
        .priceWithCurrency.amount,
      "4.50"
    );
    assert.equal(
      parsed.variables.input.allowDiscountCodesInCheckout,
      false
    );

    return {
      ok:true,
      status:200,
      json:async()=>reply
    };
  };

  const options={
    domain:"alo-test.myshopify.com",
    accessToken:"test-token-123456789",
    post:mockPost
  };

  const successful=await simulateAloNowDraftHttpV324(
    req,"14.40",options
  );

  assert.deepEqual(successful,{
    ok:true,
    draftOrderId:draftId,
    totalCHF:"14.40"
  });
  assert.equal(calls,1);
  console.log("OK: Authentifizierter HTTP-Vertrag simuliert.");

  const badDomain=await simulateAloNowDraftHttpV324(
    req,"14.40",{
      ...options,
      domain:"evil.example.com"
    }
  );

  assert.deepEqual(badDomain,{
    ok:false,
    reason:"SHOPIFY_REQUEST_REJECTED"
  });
  assert.equal(calls,1);
  console.log("OK: Fremde Domain blockiert.");

  const badTotal=await simulateAloNowDraftHttpV324(
    req,"15.40",options
  );

  assert.equal(badTotal.ok,false);
  console.log("OK: Falscher Betrag abgelehnt.");

  const timeout=await simulateAloNowDraftHttpV324(
    req,"14.40",{
      ...options,
      post:async()=>{
        throw new Error("SIMULATED_TIMEOUT");
      }
    }
  );

  assert.deepEqual(timeout,{
    ok:false,
    reason:"SHOPIFY_TRANSPORT_UNCONFIRMED"
  });
  console.log("OK: Timeout nicht als Erfolg gewertet.");

  const denied=await createAloNowShopifyDraftV324(
    req,"14.40"
  );

  assert.deepEqual(denied,{
    ok:false,
    reason:"SHOPIFY_DRAFT_WRITES_DISABLED"
  });
  console.log("OK: Echte Shopify-Erstellung hart gesperrt.");

  process.env.ALO_RUNTIME_MODE="production";

  const production=await simulateAloNowDraftHttpV324(
    req,"14.40",options
  );

  assert.deepEqual(production,{
    ok:false,
    reason:"HTTP_SIMULATION_DISABLED"
  });
  console.log("OK: HTTP-Simulation in Produktion gesperrt.");

  console.log("===== V324 – ALLE TESTS BESTANDEN =====");
} finally {
  if(oldMode===undefined)
    delete process.env.ALO_RUNTIME_MODE;
  else process.env.ALO_RUNTIME_MODE=oldMode;

  if(oldNode===undefined)
    delete process.env.NODE_ENV;
  else process.env.NODE_ENV=oldNode;

  if(oldFlag===undefined)
    delete process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED;
  else process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED=oldFlag;
}
