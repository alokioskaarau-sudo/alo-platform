// ALO_NOW_V1658_TRUSTED_LOCKED_PREFLIGHT
// Fixed composition of V1653 and V1657.
// No legacy payment dependency is exposed.
// This is a precheck, NOT dispatch authorization.
// No HTTP route, payment write or Shopify mutation.

import {
  inspectLockedPreflightV1653,
} from "./aloNowLockedPreflight.v1653.js";

import {
  createClientBoundPaymentV1657,
} from "./aloNowClientBoundPayment.v1657.js";

import type {
  TrustedShopifyReadersV1656,
} from "./aloNowTrustedReaders.v1656.js";

type Request = Parameters<
  typeof inspectLockedPreflightV1653
>[0];

type Pool = Parameters<
  typeof inspectLockedPreflightV1653
>[1]["pool"];

export type TrustedPreflightDependenciesV1658 = {
  pool: Pool;
  shopify: TrustedShopifyReadersV1656;
};

export async function inspectTrustedLockedPreflightV1658(
  request: Request,
  dependencies: TrustedPreflightDependenciesV1658
) {
  if (
    typeof dependencies?.pool?.connect !== "function" ||
    typeof dependencies?.shopify?.readPayment !==
      "function" ||
    typeof dependencies?.shopify?.readFullOrder !==
      "function"
  ) {
    throw new Error("INVALID_TRUSTED_PREFLIGHT_DEPENDENCIES");
  }

  return inspectLockedPreflightV1653(
    request,
    {
      pool: dependencies.pool,

      // This callback receives the exact client that
      // owns the order-wide PostgreSQL advisory lock.
      paymentForClient(client) {
        return createClientBoundPaymentV1657(
          client,
          dependencies.shopify
        );
      },
    }
  );
}
