
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateDocumentsV401
} from "./orderRecoveryAudit.v401.js";
import type {
  RecoveryAssessmentV397
} from "./orderRecoveryAssessment.v397.js";
import type {
  OrderDocumentEvidenceV399
} from "./orderDocumentEvidence.v399.js";

function base(
  channel: RecoveryAssessmentV397["channel"]
): RecoveryAssessmentV397 {
  return {
    orderId: "gid://shopify/Order/401",
    channel,
    status: "EVIDENCE_PRESENT_REVIEW_REQUIRED",
    missing: [],
    warnings: [],
    automaticRetryAllowed: false
  };
}

function doc(
  type: string,
  mode: string | null,
  jobs = 1,
  printed = 0
): OrderDocumentEvidenceV399 {
  return {
    document_type: type,
    label_mode: mode,
    document_count: 1,
    complete_documents: 1,
    total_jobs: jobs,
    queued_jobs: jobs - printed,
    printing_jobs: 0,
    printed_jobs: printed,
    failed_jobs: 0,
    other_jobs: 0
  };
}

test("V401 PICKUP", () => {
  const result = evaluateDocumentsV401(
    base("PICKUP"),
    [doc("SHIPPING_LABEL", "PICKUP", 1, 1)]
  );
  assert.deepEqual(result.missing, []);
  assert.equal(result.automaticRetryAllowed, false);
});

test("V401 SHIPPING missing artifacts", () => {
  const result = evaluateDocumentsV401(
    base("SHIPPING"),
    [doc("SHIPPING_LABEL", "LIVE")]
  );
  assert.ok(result.missing.some(
    x => x.includes("PACKING_SLIP")
  ));
  assert.ok(result.missing.some(
    x => x.includes("INVOICE")
  ));
});

test("V401 ALO NOW no invoice print requirement", () => {
  const result = evaluateDocumentsV401(
    base("ALO_NOW"),
    [
      doc("PACKING_SLIP", null),
      doc("INVOICE", null, 0)
    ]
  );
  assert.deepEqual(result.missing, []);
});

test("V401 duplicate jobs", () => {
  const result = evaluateDocumentsV401(
    base("PICKUP"),
    [doc("SHIPPING_LABEL", "PICKUP", 2, 1)]
  );
  assert.equal(result.status, "MANUAL_REVIEW_REQUIRED");
});

test("V401 incomplete PDF", () => {
  const invoice = doc("INVOICE", null);
  invoice.complete_documents = 0;

  const result = evaluateDocumentsV401(
    base("SHIPPING"),
    [
      doc("SHIPPING_LABEL", "LIVE"),
      doc("PACKING_SLIP", null),
      invoice
    ]
  );

  assert.ok(
    result.missing.includes("INVOICE_PDF_INCOMPLETE")
  );
});

test("V401 UNKNOWN cannot retry", () => {
  const result = evaluateDocumentsV401(
    base("UNKNOWN"), []
  );
  assert.equal(result.automaticRetryAllowed, false);
});
