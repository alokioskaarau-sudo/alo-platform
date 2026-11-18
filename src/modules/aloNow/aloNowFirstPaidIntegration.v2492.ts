import {
  resolveFirstPaidBindingV2489
} from "./aloNowFirstPaidBinding.v2489.js";

import {
  readFirstPaidCheckoutV2490
} from "./aloNowFirstPaidDb.v2490.js";

import type {
  FirstPaidQueryV2490
} from "./aloNowFirstPaidDb.v2490.js";

import type {
  PaidProvenanceV2491
} from "../../integrations/shopify/aloNowPaidProvenance.v2491.js";

/**
 * V2492: Connect trusted Shopify provenance with PostgreSQL.
 * Read-only. No binding, payment, printing or delivery writes.
 */
export function createFirstPaidIntegrationV2492(
  readProvenance: (
    orderId: string
  ) => Promise<PaidProvenanceV2491 | null>,
  database: FirstPaidQueryV2490
) {
  return (orderId: string) =>
    resolveFirstPaidBindingV2489(orderId, {
      readShopifyProvenance: readProvenance,
      readCheckoutRecord: (requestId, reference) =>
        readFirstPaidCheckoutV2490(
          requestId,
          reference,
          database
        )
    });
}
