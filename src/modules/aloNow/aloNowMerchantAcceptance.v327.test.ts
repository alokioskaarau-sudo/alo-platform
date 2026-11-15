import assert from "node:assert/strict";
import {
  decideAloNowRequestIntake,
  decideAloNowPaymentReadiness,
  publicAloNowRequestView
} from "./aloNowMerchantAcceptance.v327.js";

const base = {
  insideDeliveryArea:true,
  shopAcceptingRequests:true,
  quoteStatus:"STANDARD" as const,
  cartVerified:true,
  driversOnline:0
};

assert.deepEqual(
  decideAloNowRequestIntake(base),
  {ok:true,stage:"REQUEST_RECEIVED"}
);
console.log("OK: Bestellung anfragen bei 0 Fahrern möglich.");

assert.deepEqual(
  decideAloNowRequestIntake({...base,driversOnline:8}),
  decideAloNowRequestIntake(base)
);
console.log("OK: Online-Fahrerzahl beeinflusst Intake nicht.");

assert.equal(
  decideAloNowRequestIntake({
    ...base,
    quoteStatus:"MANUAL_REVIEW"
  }).ok,
  true
);
console.log("OK: Manuelle Lieferprüfung erlaubt Anfrage.");

assert.deepEqual(
  decideAloNowRequestIntake({
    ...base,
    insideDeliveryArea:false
  }),
  {ok:false,reason:"OUTSIDE_DELIVERY_AREA"}
);

assert.deepEqual(
  decideAloNowRequestIntake({
    ...base,
    shopAcceptingRequests:false
  }),
  {ok:false,reason:"SHOP_NOT_ACCEPTING_REQUESTS"}
);
console.log("OK: Liefergebiet und Geschäftsbetrieb geprüft.");

const payment = {
  requestAcceptedByMerchant:true,
  fulfillment:"INTERNAL_DELIVERY" as const,
  deliveryCapacityConfirmed:true,
  quoteStatus:"STANDARD" as const,
  finalTotalVerified:true,
  deliveryAddressVerified:true
};

assert.deepEqual(
  decideAloNowPaymentReadiness(payment),
  {
    ok:true,
    stage:"READY_FOR_PAYMENT_PREPARATION"
  }
);
console.log("OK: Eigene Lieferung ohne externen Fahrer möglich.");

assert.deepEqual(
  decideAloNowPaymentReadiness({
    ...payment,
    requestAcceptedByMerchant:false
  }),
  {ok:false,reason:"MERCHANT_ACCEPTANCE_REQUIRED"}
);

assert.deepEqual(
  decideAloNowPaymentReadiness({
    ...payment,
    deliveryCapacityConfirmed:false
  }),
  {ok:false,reason:"DELIVERY_CAPACITY_REQUIRED"}
);

assert.equal(
  decideAloNowPaymentReadiness({
    ...payment,
    fulfillment:"NOT_CONFIRMED"
  }).ok,
  false
);

assert.equal(
  decideAloNowPaymentReadiness({
    ...payment,
    quoteStatus:"MANUAL_REVIEW"
  }).ok,
  false
);

assert.equal(
  decideAloNowPaymentReadiness({
    ...payment,
    deliveryAddressVerified:false
  }).ok,
  false
);

assert.equal(
  decideAloNowPaymentReadiness({
    ...payment,
    finalTotalVerified:false
  }).ok,
  false
);

console.log("OK: Keine Zahlung ohne bestätigte Lieferfähigkeit.");
console.log("OK: Preis- und Adressprüfung bleiben notwendig.");

const publicView = publicAloNowRequestView({
  requestId:"offline-test",
  status:"PENDING_REVIEW"
});

assert.equal(publicView.checkoutAllowed,false);
assert.equal("driversOnline" in publicView,false);
assert.equal("driverCount" in publicView,false);
assert.equal("driverId" in publicView,false);

console.log("OK: Keine Fahrerzahlen in öffentlicher Ansicht.");
console.log("OK: Checkout weiterhin gesperrt.");
console.log("===== V327 – ALLE TESTS BESTANDEN =====");
