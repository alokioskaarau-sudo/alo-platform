/**
 * ALO NOW V1810B
 * Trusted server-only live sources.
 * Read only. Not connected to an HTTP route.
 */
import { db } from "../../database/db.js";
import {
  getShopifyOrderById
} from "../../integrations/shopify/orders.js";

import {
  checkOnlinePaymentEvidenceV1810
} from "./aloNowOnlinePaymentEvidence.v1810.js";

import type {
  OnlineEvidenceV1810,
  PaymentSnapshotV1810,
  PaymentStateV1810
} from "./aloNowOnlinePaymentEvidence.v1810.js";

export async function checkLiveOnlinePaymentV1810(
  orderId: string
): Promise<OnlineEvidenceV1810> {
  return checkOnlinePaymentEvidenceV1810(orderId, {
    shopify: async id => {
      const order = await getShopifyOrderById(id);
      return order as PaymentSnapshotV1810 | null;
    },
    paymentStates: async id => {
      const result = await db.query<PaymentStateV1810>(
        `SELECT phase, payment_method
         FROM alo_now_payment_states
         WHERE shopify_order_id::text IN ($1, $2)
         LIMIT 2`,
        [id, id.replace("gid://shopify/Order/", "")]
      );
      return result.rows;
    }
  });
}
