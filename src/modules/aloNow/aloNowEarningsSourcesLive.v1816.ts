/**
 * ALO NOW V1816 - server-side source aggregation.
 *
 * READ ONLY.
 * The caller must authenticate the driver and derive
 * the driverUserId and workspace from trusted server context.
 * Never expose this function directly to an unauthenticated route.
 */

import {
  checkLiveOnlinePaymentV1810
} from "./aloNowOnlinePaymentLive.v1810b.js";

import {
  readLiveEarningsLedgerV1815
} from "./aloNowEarningsLedgerLive.v1815.js";

import {
  combineEarningsSourcesV1816
} from "./aloNowEarningsSources.v1816.js";

import type {
  LedgerScopeV1815
} from "./aloNowEarningsLedger.v1815.js";

import type {
  EarningsSourceStatusV1816
} from "./aloNowEarningsSources.v1816.js";

const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const DRIVER = /^[1-9][0-9]{0,18}$/;

function blocked(): EarningsSourceStatusV1816 {
  return {
    status: "BLOCKED",
    paymentMatched: false,
    bookingPresent: false,
    sourceVerified: false,
    earningsAuthorized: false,
    payoutEnabled: false,
    commissionRappen: null,
    tipRappen: null
  };
}

export async function readLiveEarningsSourcesV1816(
  scope: LedgerScopeV1815
): Promise<EarningsSourceStatusV1816> {
  if (
    !scope ||
    !ORDER.test(scope.orderId) ||
    !DRIVER.test(scope.driverUserId) ||
    !["AARAU", "OLTEN"].includes(scope.workspace)
  ) {
    return blocked();
  }

  try {
    const [payment, ledger] = await Promise.all([
      checkLiveOnlinePaymentV1810(scope.orderId),
      readLiveEarningsLedgerV1815(scope)
    ]);

    return combineEarningsSourcesV1816(payment, ledger);
  } catch {
    return blocked();
  }
}
