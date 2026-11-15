
import type { PoolClient } from "pg";
import {
  getAssessedOrderRecoveryV398
} from "./orderRecoveryAssessed.v398.js";
import type {
  RecoveryAssessmentV397
} from "./orderRecoveryAssessment.v397.js";
import {
  getOrderDocumentEvidenceV399,
  type OrderDocumentEvidenceV399
} from "./orderDocumentEvidence.v399.js";

type Channel = RecoveryAssessmentV397["channel"];

function requirements(channel: Channel) {
  if (channel === "PICKUP") {
    return [
      ["SHIPPING_LABEL", "PICKUP", true]
    ] as const;
  }

  if (channel === "ALO_NOW") {
    return [
      ["PACKING_SLIP", null, true],
      ["INVOICE", null, false]
    ] as const;
  }

  if (channel === "SHIPPING") {
    return [
      ["SHIPPING_LABEL", "LIVE", true],
      ["PACKING_SLIP", null, true],
      ["INVOICE", null, true]
    ] as const;
  }

  return [] as const;
}

export function evaluateDocumentsV401(
  assessment: RecoveryAssessmentV397,
  evidence: OrderDocumentEvidenceV399[]
) {
  const missing = [...assessment.missing];
  const warnings = [...assessment.warnings];

  const add = (array: string[], code: string) => {
    if (!array.includes(code)) array.push(code);
  };

  const expected = requirements(assessment.channel);

  for (const [type, mode, printRequired] of expected) {
    const prefix = type + (mode ? "_" + mode : "");

    const rows = evidence.filter(
      row =>
        row.document_type === type &&
        row.label_mode === mode
    );

    if (rows.length !== 1) {
      add(missing, prefix + "_MISSING_OR_AMBIGUOUS");
      continue;
    }

    const row = rows[0];

    if (row.document_count !== 1) {
      add(missing, prefix + "_COUNT_INVALID");
    }

    if (row.complete_documents !== 1) {
      add(missing, prefix + "_PDF_INCOMPLETE");
    }

    if (printRequired && row.total_jobs === 0) {
      add(missing, prefix + "_PRINT_JOB_MISSING");
    }

    if (row.total_jobs > 1) {
      add(warnings, prefix + "_MULTIPLE_PRINT_JOBS");
    }

    if (row.failed_jobs > 0 || row.other_jobs > 0) {
      add(warnings, prefix + "_PRINT_REVIEW");
    }

    if (row.queued_jobs > 0) {
      add(warnings, prefix + "_PRINT_QUEUED");
    }

    if (row.printing_jobs > 0) {
      add(warnings, prefix + "_PRINTING");
    }

    if (row.printed_jobs > 0) {
      add(warnings, prefix + "_PRINT_RECORDED");
    }
  }

  for (const row of evidence) {
    const valid = expected.some(
      ([type, mode]) =>
        row.document_type === type &&
        row.label_mode === mode
    );

    if (!valid) {
      add(warnings, "UNEXPECTED_DOCUMENT_ARTIFACTS");
    }
  }

  const critical =
    assessment.status === "MANUAL_REVIEW_REQUIRED" ||
    warnings.some(w =>
      w.includes("MULTIPLE") ||
      w.includes("UNEXPECTED") ||
      w.includes("PRINT_REVIEW")
    );

  const status: RecoveryAssessmentV397["status"] =
    missing.length > 0
      ? "INCOMPLETE_ARTIFACTS"
      : critical
        ? "MANUAL_REVIEW_REQUIRED"
        : "EVIDENCE_PRESENT_REVIEW_REQUIRED";

  return {
    ...assessment,
    status,
    missing,
    warnings,
    documentEvidence: evidence,
    automaticRetryAllowed: false as const
  };
}

/**
 * Nur Diagnose. Keine Druck- oder Retry-Aktion.
 */
export async function getOrderRecoveryAuditV401(
  orderId: string,
  client?: PoolClient
) {
  const assessed = await getAssessedOrderRecoveryV398(
    orderId, client
  );

  const evidence = await getOrderDocumentEvidenceV399(
    orderId, client
  );

  return {
    orderId,
    detail: assessed.detail,
    assessment: evaluateDocumentsV401(
      assessed.assessment,
      evidence
    ),
    automaticRetryAllowed: false as const
  };
}
