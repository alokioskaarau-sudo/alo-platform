import assert from "node:assert/strict";
import {buildAloNowDraftOrderPayload}
  from "./aloNowDraftOrderPayload.js";
import {
  buildAloNowDraftGraphqlRequest,
  parseAloNowDraftCreateResponse
} from "./aloNowDraftOrderAdapter.js";

const item = {
  variantId:"gid://shopify/ProductVariant/123",
  quantity:2,
  unitPriceCHF:4.95,
  title:"ALO Test"
};

const built=buildAloNowDraftOrderPayload({
  requestId:"123e4567-e89b-42d3-a456-426614174000",
  checkoutReference:"123e4567-e89b-42d3-a456-426614174001",
  storedItems:[item],
  freshCart:{items:[item],subtotalCHF:9.90,currency:"CHF"},
  verifiedSubtotalCHF:"9.90",
  deliveryFeeCHF:"4.50"
});

const req=buildAloNowDraftGraphqlRequest(built.draftInput);
assert.equal(
  req.variables.input.shippingLine.priceWithCurrency.amount,"4.50"
);
assert.equal(req.variables.input.acceptAutomaticDiscounts,false);
assert.equal(req.variables.input.allowDiscountCodesInCheckout,false);
assert.equal(built.expectedTotalCHF,"14.40");
console.log("OK: Payload, CHF und Discount-Sperren.");

const response={
  data:{
    draftOrderCreate:{
      draftOrder:{
        id:"gid://shopify/DraftOrder/456",
        invoiceUrl:"https://example.myshopify.com/invoice/456",
        totalPriceSet:{
          shopMoney:{amount:"14.40",currencyCode:"CHF"}
        }
      },
      userErrors:[]
    }
  }
};
assert.equal(parseAloNowDraftCreateResponse(
  response,"14.40").ok,true);
console.log("OK: Shopify-Erfolgsantwort.");

const invalid:Array<[string,unknown,string]>=[
  ["Falscher Betrag",response,"15.40"],
  ["GraphQL-Fehler",{errors:[{message:"fail"}]},"14.40"],
  ["UserError",{data:{draftOrderCreate:{
    draftOrder:null,userErrors:[{message:"Invalid"}]
  }}},"14.40"],
  ["Falsche ID",{data:{draftOrderCreate:{
    draftOrder:{
      ...response.data.draftOrderCreate.draftOrder,
      id:"gid://shopify/Order/456"
    },
    userErrors:[]
  }}},"14.40"],
  ["Falsche Währung",{data:{draftOrderCreate:{
    draftOrder:{
      ...response.data.draftOrderCreate.draftOrder,
      totalPriceSet:{
        shopMoney:{amount:"14.40",currencyCode:"EUR"}
      }
    },
    userErrors:[]
  }}},"14.40"]
];

for(const [name,value,expected] of invalid){
  assert.equal(
    parseAloNowDraftCreateResponse(value,expected).ok,
    false,name
  );
  console.log("OK: Blockiert –",name);
}

console.log("===== V317B – ALLE 7 TESTS BESTANDEN =====");
