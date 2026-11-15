// ALO_NOW_V1657_CLIENT_BOUND_PAYMENT
// Connector for V1653 paymentForClient.
// Payment and workflow must come from trusted server readers.
// Classification only succeeds for the exact checked snapshot.
// No HTTP route, database write or Shopify mutation.

import {
  bindTrustedReadersV1656,
  type ReaderClientV1656,
  type TrustedShopifyReadersV1656,
} from "./aloNowTrustedReaders.v1656.js";

import type {
  PaymentDependenciesV1652,
} from "./aloNowCombinedPaymentPrecheck.v1652.js";

export function createClientBoundPaymentV1657(
  client: ReaderClientV1656,
  shopify: TrustedShopifyReadersV1656
): Omit<PaymentDependenciesV1652, "db"> {
  const readers = bindTrustedReadersV1656(
    client,
    shopify
  );

  let checkedOrder: object | null = null;

  return {
    readWorkflow: readers.readWorkflow,

    async readShopifyPayment(orderId: string) {
      // Fail closed if a previous invocation failed.
      checkedOrder = null;

      const verified =
        await readers.readPaymentAndChannel(orderId);

      checkedOrder = verified.payment;
      return verified.payment;
    },

    classifyFulfillment(order) {
      // V1649 must classify exactly the object that passed
      // the strict V1656 full-order channel validation.
      return (
        checkedOrder !== null &&
        checkedOrder === order
      )
        ? "ALO_NOW"
        : "UNKNOWN";
    },
  };
}
