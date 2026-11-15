
import type {
  OrderRecoveryDetailV396
} from "./orderRecoveryDetail.v396.js";

export type RecoveryAssessmentV397 = {
  orderId: string;
  channel: "ALO_NOW" | "PICKUP" | "SHIPPING" | "UNKNOWN";
  status:
    | "MANUAL_REVIEW_REQUIRED"
    | "INCOMPLETE_ARTIFACTS"
    | "EVIDENCE_PRESENT_REVIEW_REQUIRED";
  missing: string[];
  warnings: string[];
  automaticRetryAllowed: false;
};

export function assessOrderRecoveryV397(
  detail: OrderRecoveryDetailV396
): RecoveryAssessmentV397 {
  const snapshot = detail.snapshot;
  const missing: string[] = [];
  const warnings: string[] = [];

  const rawChannel = snapshot?.order_channel;
  const channel =
    rawChannel === "ALO_NOW" ||
    rawChannel === "PICKUP" ||
    rawChannel === "SHIPPING"
      ? rawChannel
      : "UNKNOWN";

  if (!snapshot) {
    missing.push("PAID_WEBHOOK_EVIDENCE");
  } else {
    if (snapshot.error_count > 0) {
      warnings.push("WEBHOOK_ERROR_OR_REVIEW");
    }
    if (snapshot.processing_count > 0) {
      warnings.push("WEBHOOK_PROCESSING_UNRESOLVED");
    }
    if (snapshot.pending_count > 0) {
      warnings.push("WEBHOOK_PENDING_UNRESOLVED");
    }
    if (snapshot.completed_count === 0) {
      missing.push("COMPLETED_PAID_WEBHOOK");
    }
    if (snapshot.webhook_count > 1) {
      warnings.push("MULTIPLE_PAID_WEBHOOK_EVENTS");
    }
  }

  if (channel === "UNKNOWN") {
    warnings.push("ORDER_CHANNEL_NOT_VERIFIED");
  }

  const matchingMode =
    channel === "PICKUP" ? "PICKUP" :
    channel === "SHIPPING" ? "LIVE" : null;

  if (matchingMode) {
    const expectedLabels = detail.labels.filter(
      label => label.label_mode === matchingMode
    );

    const unexpectedLabels = detail.labels.filter(
      label => label.label_mode !== matchingMode
    );

    if (unexpectedLabels.length > 0) {
      warnings.push("UNEXPECTED_LABEL_MODE");
    }

    if (expectedLabels.length !== 1) {
      missing.push("EXPECTED_LABEL_MODE");
    } else {
      const label = expectedLabels[0];

      if (label.label_count !== 1) {
        warnings.push("MULTIPLE_LABEL_RECORDS");
      }
      if (label.complete_labels !== 1) {
        missing.push("COMPLETED_LABEL_PDF");
      }
      if (label.total_jobs === 0) {
        missing.push("LABEL_PRINT_JOB");
      }
      if (label.total_jobs > 1) {
        warnings.push("MULTIPLE_LABEL_PRINT_JOBS");
      }
      if (label.failed_jobs > 0) {
        warnings.push("FAILED_LABEL_PRINT_JOB");
      }
      if (label.printing_jobs > 0) {
        warnings.push("LABEL_PRINT_IN_PROGRESS");
      }
      if (label.queued_jobs > 0) {
        warnings.push("LABEL_PRINT_QUEUED");
      }
      if (label.printed_jobs > 0) {
        warnings.push("LABEL_PRINT_RECORDED_NOT_PHYSICALLY_VERIFIED");
      }
    }
  }

  if (channel === "ALO_NOW" || channel === "SHIPPING") {
    if (!snapshot || snapshot.complete_packing_slips !== 1) {
      missing.push("COMPLETED_PACKING_SLIP");
    }
    if (!snapshot || snapshot.complete_invoices !== 1) {
      missing.push("COMPLETED_INVOICE");
    }
    if (!snapshot?.fulfillment_exists) {
      missing.push("FULFILLMENT_WORKFLOW");
    }
    if (!snapshot || snapshot.packing_print_jobs === 0) {
      missing.push("PACKING_SLIP_PRINT_JOB");
    }
    if (snapshot && snapshot.packing_print_jobs > 1) {
      warnings.push("MULTIPLE_PACKING_SLIP_PRINT_JOBS");
    }
  }

  if (channel === "ALO_NOW") {
    if (!snapshot?.delivery_exists) {
      missing.push("ALO_NOW_DELIVERY");
    }
    if (detail.labels.length > 0) {
      warnings.push("UNEXPECTED_ALO_NOW_SHIPPING_LABEL");
    }
    warnings.push("ALO_NOW_PRINT_AND_DELIVERY_STATE_REVIEW");
  }

  if (channel === "SHIPPING") {
    // Bisher nicht in V396 vorhanden:
    // Rechnungsdruck und Tracking-/Fulfillment-Abgleich.
    warnings.push("INVOICE_PRINT_STATUS_NOT_YET_VERIFIED");
    warnings.push("SHIPPING_TRACKING_NOT_YET_VERIFIED");
  }

  if (channel === "PICKUP") {
    warnings.push("PICKUP_HANDOVER_NOT_YET_VERIFIED");
  }

  const status =
    missing.length > 0
      ? "INCOMPLETE_ARTIFACTS"
      : warnings.some(w =>
          w === "WEBHOOK_ERROR_OR_REVIEW" ||
          w === "WEBHOOK_PROCESSING_UNRESOLVED" ||
          w === "ORDER_CHANNEL_NOT_VERIFIED" ||
          w === "MULTIPLE_PAID_WEBHOOK_EVENTS" ||
          w === "UNEXPECTED_LABEL_MODE" ||
          w === "MULTIPLE_LABEL_RECORDS" ||
          w === "MULTIPLE_LABEL_PRINT_JOBS" ||
          w === "MULTIPLE_PACKING_SLIP_PRINT_JOBS" ||
          w === "FAILED_LABEL_PRINT_JOB"
        )
        ? "MANUAL_REVIEW_REQUIRED"
        : "EVIDENCE_PRESENT_REVIEW_REQUIRED";

  return {
    orderId: detail.orderId,
    channel,
    status,
    missing,
    warnings,
    automaticRetryAllowed: false
  };
}
