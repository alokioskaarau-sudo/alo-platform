import crypto from "node:crypto";

import {
  completeOrderDiscountCode,
  failOrderDiscountCode,
  markOrderDiscountCodeCreating,
  reserveOrderDiscountCode,
  type OrderDiscountCodeRecord,
} from "../../database/orderDiscountCodes.js";

import {
  createShopifyPackingSlipDiscount,
} from "../../integrations/shopify/discounts.js";

/* =========================================================
   CONSTANTS
========================================================= */

const DISCOUNT_PERCENTAGE = 0.15;

const CODE_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* =========================================================
   TYPES
========================================================= */

type ShopifyOrderForDiscount = {
  id: string;
  name: string;
};

export type PackingSlipDiscountResult = {
  id: string;

  code: string;

  percentage: number;

  shopifyDiscountId: string;

  status: string;

  created: boolean;

  reused: boolean;
};

/* =========================================================
   GENERATE SECURE CODE
========================================================= */

function generateDiscountCode(): string {
  const bytes =
    crypto.randomBytes(8);

  let suffix = "";

  for (
    let index = 0;
    index < 8;
    index++
  ) {
    suffix +=
      CODE_ALPHABET[
        bytes[index] %
          CODE_ALPHABET.length
      ];
  }

  return `ALO15-${suffix}`;
}

/* =========================================================
   ACTIVE RESULT
========================================================= */

function activeResult(
  record: OrderDiscountCodeRecord,
  reused: boolean
): PackingSlipDiscountResult {
  if (!record.shopify_discount_id) {
    throw new Error(
      `Rabatt ${record.code} ist ACTIVE, aber Shopify Discount ID fehlt.`
    );
  }

  return {
    id:
      record.id,

    code:
      record.code,

    percentage:
      Number(record.percentage),

    shopifyDiscountId:
      record.shopify_discount_id,

    status:
      record.status,

    created:
      !reused,

    reused,
  };
}

/* =========================================================
   GET OR CREATE PACKING SLIP DISCOUNT
========================================================= */

export async function getOrCreatePackingSlipDiscount(
  order: ShopifyOrderForDiscount
): Promise<PackingSlipDiscountResult> {
  if (!order?.id) {
    throw new Error(
      "Shopify Bestellung hat keine Order ID."
    );
  }

  if (!order?.name) {
    throw new Error(
      "Shopify Bestellung hat keinen Bestellnamen."
    );
  }

  /*
   * Zuerst wird lokal ein Code reserviert.
   *
   * UNIQUE(shopify_order_id) garantiert:
   * dieselbe Bestellung kann nicht mehrere DB-Codes
   * bekommen.
   */

  const reservation =
    await reserveOrderDiscountCode({
      shopifyOrderId:
        order.id,

      shopifyOrderName:
        order.name,

      code:
        generateDiscountCode(),

      percentage:
        DISCOUNT_PERCENTAGE,
    });

  const record =
    reservation.record;

  /*
   * Bereits vollständig erstellt:
   * sofort denselben Code wiederverwenden.
   */

  if (
    record.status === "ACTIVE" &&
    record.shopify_discount_id
  ) {
    console.log(
      `Rabattcode wiederverwendet: ${order.name} -> ${record.code}`
    );

    return activeResult(
      record,
      true
    );
  }

  /*
   * PENDING / FAILED / CREATING:
   *
   * Wir verwenden bewusst den bereits reservierten
   * DB-Code weiter.
   *
   * createShopifyPackingSlipDiscount() prüft zuerst,
   * ob genau dieser Code schon bei Shopify existiert.
   */

  await markOrderDiscountCodeCreating(
    record.id
  );

  try {
    const shopifyDiscount =
      await createShopifyPackingSlipDiscount({
        code:
          record.code,

        orderName:
          order.name,

        percentage:
          DISCOUNT_PERCENTAGE,
      });

    /*
     * Zusätzliche Integritätsprüfung:
     * Shopify muss exakt unseren reservierten Code
     * zurückgeben.
     */

    if (
      shopifyDiscount.code !==
      record.code
    ) {
      throw new Error(
        `Shopify Rabattcode stimmt nicht überein. Erwartet: ${record.code}, erhalten: ${shopifyDiscount.code}`
      );
    }

    const completed =
      await completeOrderDiscountCode(
        record.id,
        shopifyDiscount.id
      );

    console.log(
      reservation.created
        ? `Neuer Lieferschein-Rabatt erstellt: ${order.name} -> ${completed.code}`
        : `Lieferschein-Rabatt recovered: ${order.name} -> ${completed.code}`
    );

    return activeResult(
      completed,
      !reservation.created
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    /*
     * DB-Status FAILED ermöglicht einen späteren Retry.
     * Der reservierte Code bleibt unverändert.
     */

    await failOrderDiscountCode(
      record.id,
      message
    );

    throw new Error(
      `15%-Lieferschein-Rabatt für ${order.name} konnte nicht erstellt werden: ${message}`
    );
  }
}
