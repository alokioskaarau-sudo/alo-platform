
import type { PoolClient } from "pg";
import {
  getOrderRecoveryDetailV396,
  type OrderRecoveryDetailV396
} from "./orderRecoveryDetail.v396.js";
import {
  assessOrderRecoveryV397,
  type RecoveryAssessmentV397
} from "./orderRecoveryAssessment.v397.js";

export type AssessedOrderRecoveryV398 = {
  detail: OrderRecoveryDetailV396;
  assessment: RecoveryAssessmentV397;
};

/**
 * Zentrale lesende Recovery-Diagnose.
 *
 * Keine Wiederaufnahme, keine Druckaktion,
 * kein Shopify-Fulfillment und keine Freigabe.
 */
export async function getAssessedOrderRecoveryV398(
  orderId: string,
  client?: PoolClient
): Promise<AssessedOrderRecoveryV398> {
  const detail = await getOrderRecoveryDetailV396(
    orderId,
    client
  );

  const assessment = assessOrderRecoveryV397(detail);

  if (assessment.orderId !== detail.orderId) {
    throw new Error("RECOVERY_ORDER_ID_MISMATCH");
  }

  if (assessment.automaticRetryAllowed !== false) {
    throw new Error("RECOVERY_AUTOMATIC_RETRY_FORBIDDEN");
  }

  return { detail, assessment };
}
