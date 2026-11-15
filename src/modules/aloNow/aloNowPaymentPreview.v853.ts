// ALO NOW V853 – trusted Shopify amount preview.
// Read-only, never confirms cash or pays commission.

import { getAloNowDelivery } from "../../database/aloNowDeliveries.js";
import { getShopifyOrderById } from "../../integrations/shopify/orders.js";
import { readAloNowLiveShopifyPayment } from "./aloNowLiveShopifyPaymentReader.js";
import { getOrderFulfillmentType } from "../orders/orderFulfillmentType.js";

// ALO_NOW_V856B_CHECKOUT_EVIDENCE
// Nur lesend. Barvereinbarung ist KEIN Kasseneingang.
import { db } from "../../database/db.js";

type PaymentMethodV856B =
  "ONLINE" | "CASH" | "UNVERIFIED";

async function readCheckoutEvidenceV856B(
  orderId:string,
  financialStatus:string
):Promise<{
  verifiedPaymentMethod:PaymentMethodV856B;
  paymentEvidence:
    "ONLINE_PAYMENT_VERIFIED" |
    "CASH_AGREEMENT_ONLY" |
    "NOT_VERIFIED";
}> {
  const unknown={
    verifiedPaymentMethod:"UNVERIFIED" as const,
    paymentEvidence:"NOT_VERIFIED" as const
  };

  const gid="gid://shopify/Order/"+orderId;

  const found=await db.query<{
    phase:string;
    payment_method:string|null;
  }>(
    `SELECT phase,payment_method
     FROM alo_now_payment_states
     WHERE shopify_order_id::text IN ($1,$2)
     LIMIT 2`,
    [orderId,gid]
  );

  // Fehlende oder doppelte Zuordnung: keine Freigabe.
  if(found.rows.length!==1)return unknown;

  const payment=found.rows[0];
  const financial=financialStatus.trim().toUpperCase();

  if(
    payment.phase==="PAYMENT_CONFIRMED" &&
    payment.payment_method==="ONLINE" &&
    financial==="PAID"
  ){
    return {
      verifiedPaymentMethod:"ONLINE",
      paymentEvidence:"ONLINE_PAYMENT_VERIFIED"
    };
  }

  // Nur bestehende Barvereinbarung, nicht kassiertes Geld.
  // Unbekannte Shopify-Zahlungsstatus bleiben gesperrt.
  if(
    payment.phase==="CASH_CONFIRMED" &&
    payment.payment_method==="CASH" &&
    financial==="PENDING"
  ){
    return {
      verifiedPaymentMethod:"CASH",
      paymentEvidence:"CASH_AGREEMENT_ONLY"
    };
  }

  return unknown;
}

export class PaymentPreviewErrorV853 extends Error {
  constructor(
    public readonly statusCode:number,
    message:string
  ){
    super(message);
  }
}

export function shopifyChfToRappenV853(
  amount:unknown
):number {
  if(
    typeof amount!=="string" &&
    typeof amount!=="number"
  ) throw new Error("INVALID_SHOPIFY_AMOUNT");

  const value=String(amount);
  if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(value))
    throw new Error("INVALID_SHOPIFY_AMOUNT");

  const [francs,decimal=""]=value.split(".");
  const rappen=
    Number(francs)*100+
    Number(decimal.padEnd(2,"0"));

  if(!Number.isSafeInteger(rappen)||rappen<=0)
    throw new Error("INVALID_SHOPIFY_AMOUNT");

  return rappen;
}

export async function readDriverPaymentPreviewV853(
  orderId:string,
  staffUserId:string
){
  // ALO_NOW_V859B_CANONICAL_SHOPIFY_ID
  // Akzeptiert numerische Shopify-ID oder vollständige GID.
  const numericOrderId=orderId.startsWith(
    "gid://shopify/Order/"
  )
    ? orderId.slice("gid://shopify/Order/".length)
    : orderId;

  if(
    !/^[1-9][0-9]{0,18}$/.test(numericOrderId) ||
    !staffUserId?.trim()
  ) throw new PaymentPreviewErrorV853(
    400,"INVALID_ORDER_ID"
  );

  const canonicalOrderId=
    "gid://shopify/Order/"+numericOrderId;

  const delivery=await getAloNowDelivery(canonicalOrderId);

  if(
    !delivery ||
    delivery.assigned_driver_user_id!==staffUserId
  ){
    throw new PaymentPreviewErrorV853(
      404,"DELIVERY_NOT_FOUND"
    );
  }

  if(![
    "DRIVER_ASSIGNED",
    "READY_FOR_PICKUP",
    "PICKED_UP",
    "ON_THE_WAY"
  ].includes(delivery.delivery_status)){
    throw new PaymentPreviewErrorV853(
      409,"DELIVERY_NOT_ACTIVE"
    );
  }

  const order=await getShopifyOrderById(canonicalOrderId);
  if(!order){
    throw new PaymentPreviewErrorV853(
      409,"SHOPIFY_ORDER_UNAVAILABLE"
    );
  }

  if(
    order.cancelledAt ||
    getOrderFulfillmentType(order)!=="ALO_NOW"
  ){
    throw new PaymentPreviewErrorV853(
      409,"SHOPIFY_ORDER_NOT_ELIGIBLE"
    );
  }

  const shopMoney=order.totalPriceSet?.shopMoney;
  if(shopMoney?.currencyCode!=="CHF"){
    throw new PaymentPreviewErrorV853(
      409,"SHOPIFY_CURRENCY_NOT_CHF"
    );
  }

  let dueRappen:number;
  try{
    dueRappen=shopifyChfToRappenV853(
      shopMoney.amount
    );
  }catch{
    throw new PaymentPreviewErrorV853(
      409,"SHOPIFY_AMOUNT_INVALID"
    );
  }

  // ALO_NOW_V870B_VERIFIED_OUTSTANDING
  // Read-only Shopify evidence, never permission to collect cash.
  const snapshot=await readAloNowLiveShopifyPayment(
    canonicalOrderId
  );

  if(
    !snapshot ||
    snapshot.id!==canonicalOrderId ||
    snapshot.cancelledAt!==null ||
    snapshot.displayFinancialStatus!==
      order.displayFinancialStatus ||
    snapshot.totalPriceSet?.shopMoney?.currencyCode!=="CHF" ||
    snapshot.totalOutstandingSet?.shopMoney?.currencyCode!=="CHF"
  ){
    throw new PaymentPreviewErrorV853(
      409,"SHOPIFY_PAYMENT_EVIDENCE_MISMATCH"
    );
  }

  function exactRappenV870B(value:unknown):number {
    if(typeof value!=="string"){
      throw new Error("INVALID_CHF");
    }

    const match=
      /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/
      .exec(value);

    if(!match) throw new Error("INVALID_CHF");

    const rappen=
      Number(match[1])*100+
      Number((match[2]??"").padEnd(2,"0"));

    if(!Number.isSafeInteger(rappen)||rappen<0){
      throw new Error("INVALID_CHF");
    }

    return rappen;
  }

  let outstandingRappen:number;

  try{
    const evidenceTotal=exactRappenV870B(
      snapshot.totalPriceSet.shopMoney.amount
    );

    outstandingRappen=exactRappenV870B(
      snapshot.totalOutstandingSet.shopMoney.amount
    );

    if(
      evidenceTotal!==dueRappen ||
      outstandingRappen>dueRappen
    ){
      throw new Error("AMOUNT_MISMATCH");
    }
  }catch{
    throw new PaymentPreviewErrorV853(
      409,"SHOPIFY_PAYMENT_AMOUNT_MISMATCH"
    );
  }

  const checkout=await readCheckoutEvidenceV856B(
    numericOrderId,
    String(order.displayFinancialStatus??"UNKNOWN")
  );

  return {
    ok:true as const,
    orderId:canonicalOrderId,
    orderName:delivery.shopify_order_name,
    workspace:delivery.fulfillment_workspace,
    currency:"CHF" as const,
    // ALO_NOW_V863B_AMOUNT_SAFETY
    // Gesamtbetrag ist NICHT automatisch der offene Betrag.
    orderTotalRappen:dueRappen,
    dueRappen,
    outstandingRappen,
    collectRappen:null,
    shopifyFinancialStatus:
      String(order.displayFinancialStatus??"UNKNOWN"),
    paymentMethod:"UNVERIFIED" as const,
    verifiedPaymentMethod:checkout.verifiedPaymentMethod,
    paymentEvidence:checkout.paymentEvidence,
    cashCollectionAllowed:false as const,
    canConfirmPayment:false as const,
    message:
      "Shopify-Gesamtbetrag und offener Betrag abgeglichen. Nur Information – Bargeldkassierung nicht freigegeben."
  };
}
