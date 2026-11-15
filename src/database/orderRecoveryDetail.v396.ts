
import type { PoolClient } from "pg";
import {
  getOrderRecoverySnapshotV390,
  type OrderRecoverySnapshotV388
} from "./orderRecovery.v388.js";
import {
  getOrderPrintEvidenceV395,
  type OrderPrintEvidenceV395
} from "./orderPrintEvidence.v395.js";

export type OrderRecoveryDetailV396 = {
  orderId: string;
  snapshot: OrderRecoverySnapshotV388 | null;
  labels: OrderPrintEvidenceV395[];
  diagnosticStatus:
    | "NO_PAID_WEBHOOK_EVIDENCE"
    | "MANUAL_RECONCILIATION_REQUIRED";
};

/**
 * Diagnose ausschliesslich auf Basis vorhandener Datensaetze.
 * Keine Wiederaufnahme, keine Druckfreigabe.
 */
export async function getOrderRecoveryDetailV396(
  orderId: string,
  client?: PoolClient
): Promise<OrderRecoveryDetailV396> {
  if (!/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(orderId)) {
    throw new Error("INVALID_SHOPIFY_ORDER_ID");
  }

  const [snapshot, labels] = await Promise.all([
    getOrderRecoverySnapshotV390(orderId, client),
    getOrderPrintEvidenceV395(orderId, client)
  ]);

  return {
    orderId,
    snapshot,
    labels,
    diagnosticStatus: snapshot
      ? "MANUAL_RECONCILIATION_REQUIRED"
      : "NO_PAID_WEBHOOK_EVIDENCE"
  };
}
