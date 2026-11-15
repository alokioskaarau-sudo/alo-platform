import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {
  runAloNowDraftSimulation
} from "./aloNowDraftSimulation.v322.js";
import type {
  AloNowDraftClaimResult
} from "./aloNowDraftClaimService.js";

const originalMode=process.env.ALO_RUNTIME_MODE;
const originalFlag=process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED;

const requestId=randomUUID();
const attemptId=randomUUID();
const checkoutReference=randomUUID();
const draftOrderId="gid://shopify/DraftOrder/322001";

const claim:Extract<AloNowDraftClaimResult,{ok:true}>={
  ok:true,
  attemptId,
  requestId,
  checkoutReference,
  expectedTotalCHF:"14.40",
  graphql:{
    query:"mutation AloNowCreateDraftOrder { mock }",
    variables:{
      input:{
        presentmentCurrencyCode:"CHF",
        lineItems:[{
          variantId:"gid://shopify/ProductVariant/123",
          quantity:2
        }],
        shippingLine:{
          title:"ALO NOW Lieferung",
          priceWithCurrency:{
            amount:"4.50",
            currencyCode:"CHF"
          }
        },
        customAttributes:[
          {key:"alo_now_request_id",value:requestId},
          {key:"alo_now_checkout_reference",
           value:checkoutReference}
        ],
        tags:["ALO_NOW"],
        acceptAutomaticDiscounts:false,
        allowDiscountCodesInCheckout:false
      }
    }
  }
};

const response={
  data:{
    draftOrderCreate:{
      draftOrder:{
        id:draftOrderId,
        invoiceUrl:"https://example.myshopify.com/invoice/322001",
        totalPriceSet:{
          shopMoney:{amount:"14.40",currencyCode:"CHF"}
        }
      },
      userErrors:[]
    }
  }
};

let sent=0;
let recorded=0;
let received:unknown;

const dependencies={
  claim:async(_:string):Promise<AloNowDraftClaimResult>=>claim,
  simulatedSender:async(_:typeof claim.graphql)=>{
    sent++;
    return response;
  },
  recordOutcome:async(
    id:string,attempt:string,data:unknown
  )=>{
    assert.equal(id,requestId);
    assert.equal(attempt,attemptId);
    recorded++;
    received=data;
    return {
      ok:true as const,
      status:"CREATED" as const,
      draftOrderId
    };
  }
};

try{
  process.env.ALO_RUNTIME_MODE="production";
  process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED="true";

  const denied=await runAloNowDraftSimulation(
    requestId,dependencies
  );
  assert.deepEqual(denied,{
    ok:false,reason:"SIMULATION_DISABLED"
  });
  assert.equal(sent,0);
  console.log("OK: Produktionsmodus blockiert.");

  process.env.ALO_RUNTIME_MODE="local_test";
  process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED="false";

  assert.deepEqual(
    await runAloNowDraftSimulation(requestId,dependencies),
    {ok:false,reason:"SIMULATION_DISABLED"}
  );
  console.log("OK: Fehlende Simulationsfreigabe blockiert.");

  process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED="true";

  const good=await runAloNowDraftSimulation(
    requestId,dependencies
  );

  assert.deepEqual(good,{
    ok:true,status:"CREATED",draftOrderId
  });
  assert.equal(sent,1);
  assert.equal(recorded,1);
  assert.deepEqual(received,response);
  console.log("OK: Claim -> Simulation -> Outcome.");

  const failure=await runAloNowDraftSimulation(
    requestId,{
      ...dependencies,
      simulatedSender:async()=>{
        throw new Error("NETWORK_TIMEOUT_SIMULATED");
      },
      recordOutcome:async(_id,_attempt,data)=>{
        assert.equal(data,null);
        return {
          ok:true as const,
          status:"RECONCILE_REQUIRED" as const
        };
      }
    }
  );

  assert.deepEqual(failure,{
    ok:true,status:"RECONCILE_REQUIRED"
  });
  console.log("OK: Netzwerkfehler -> RECONCILE_REQUIRED.");

  const noClaim=await runAloNowDraftSimulation(
    requestId,{
      ...dependencies,
      claim:async()=>({
        ok:false as const,
        reason:"DRAFT_ALREADY_CLAIMED"
      }),
      simulatedSender:async()=>{
        throw new Error("SENDER_MUST_NOT_RUN");
      }
    }
  );
  assert.deepEqual(noClaim,{
    ok:false,reason:"DRAFT_ALREADY_CLAIMED"
  });
  console.log("OK: Kein Versand ohne erfolgreichen Claim.");

  const persistFailure=await runAloNowDraftSimulation(
    requestId,{
      ...dependencies,
      recordOutcome:async()=>{
        throw new Error("DB_UNAVAILABLE_SIMULATED");
      }
    }
  );
  assert.deepEqual(persistFailure,{
    ok:false,reason:"OUTCOME_PERSISTENCE_UNCONFIRMED"
  });
  console.log("OK: Nicht gespeichertes Ergebnis nicht bestätigt.");

  console.log("===== V322 – ALLE TESTS BESTANDEN =====");
}finally{
  if(originalMode===undefined)
    delete process.env.ALO_RUNTIME_MODE;
  else process.env.ALO_RUNTIME_MODE=originalMode;

  if(originalFlag===undefined)
    delete process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED;
  else process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED=originalFlag;
}
