
import test from "node:test";
import assert from "node:assert/strict";
import type {
  OrderRecoveryDetailV396
} from "./orderRecoveryDetail.v396.js";
import {
  assessOrderRecoveryV397
} from "./orderRecoveryAssessment.v397.js";

const id = "gid://shopify/Order/987654321";

function make(
  channel: string | null
): OrderRecoveryDetailV396 {
  return {
    orderId: id,
    diagnosticStatus: "MANUAL_RECONCILIATION_REQUIRED",
    snapshot: {
      order_id: id,
      order_channel: channel,
      webhook_count: 1,
      pending_count: 0,
      processing_count: 0,
      completed_count: 1,
      error_count: 0,
      packing_slips: 1,
      complete_packing_slips: 1,
      invoices: 1,
      complete_invoices: 1,
      packing_print_jobs: 1,
      fulfillment_exists: true,
      delivery_exists: true,
      push_events: 1,
      recovery_status: "COMPLETED_EVIDENCE_REVIEW"
    },
    labels: []
  };
}

test("V397 ALO NOW complete evidence is not retry approval", () => {
  const result = assessOrderRecoveryV397(make("ALO_NOW"));
  assert.equal(result.channel, "ALO_NOW");
  assert.equal(result.status, "EVIDENCE_PRESENT_REVIEW_REQUIRED");
  assert.deepEqual(result.missing, []);
  assert.equal(result.automaticRetryAllowed, false);
});

test("V397 ALO NOW missing delivery is detected", () => {
  const input = make("ALO_NOW");
  input.snapshot!.delivery_exists = false;
  const result = assessOrderRecoveryV397(input);
  assert.equal(result.status, "INCOMPLETE_ARTIFACTS");
  assert.ok(result.missing.includes("ALO_NOW_DELIVERY"));
});

test("V397 pickup does not require invoice or packing slip", () => {
  const input = make("PICKUP");
  input.snapshot!.complete_invoices = 0;
  input.snapshot!.complete_packing_slips = 0;
  input.snapshot!.fulfillment_exists = false;
  input.labels = [{
    label_mode: "PICKUP",
    label_count: 1,
    complete_labels: 1,
    queued_jobs: 0,
    printing_jobs: 0,
    printed_jobs: 1,
    failed_jobs: 0,
    total_jobs: 1,
    recovery_status: "PRINT_RECORDED"
  }];

  const result = assessOrderRecoveryV397(input);
  assert.deepEqual(result.missing, []);
  assert.equal(result.channel, "PICKUP");
  assert.equal(result.automaticRetryAllowed, false);
});

test("V397 shipping incomplete invoice and queued print", () => {
  const input = make("SHIPPING");
  input.snapshot!.complete_invoices = 0;
  input.labels = [{
    label_mode: "LIVE",
    label_count: 1,
    complete_labels: 1,
    queued_jobs: 1,
    printing_jobs: 0,
    printed_jobs: 0,
    failed_jobs: 0,
    total_jobs: 1,
    recovery_status: "PRINT_QUEUED"
  }];

  const result = assessOrderRecoveryV397(input);
  assert.ok(result.missing.includes("COMPLETED_INVOICE"));
  assert.ok(result.warnings.includes("LABEL_PRINT_QUEUED"));
  assert.equal(result.status, "INCOMPLETE_ARTIFACTS");
});

test("V397 unknown channel requires review", () => {
  const result = assessOrderRecoveryV397(make(null));
  assert.equal(result.channel, "UNKNOWN");
  assert.equal(result.status, "MANUAL_REVIEW_REQUIRED");
});

test("V397 duplicate label print jobs require review", () => {
  const input = make("PICKUP");
  input.labels = [{
    label_mode: "PICKUP",
    label_count: 1,
    complete_labels: 1,
    queued_jobs: 1,
    printing_jobs: 0,
    printed_jobs: 1,
    failed_jobs: 0,
    total_jobs: 2,
    recovery_status: "MULTIPLE_PRINT_JOBS_REVIEW"
  }];
  const result = assessOrderRecoveryV397(input);
  assert.equal(result.status, "MANUAL_REVIEW_REQUIRED");
  assert.ok(result.warnings.includes("MULTIPLE_LABEL_PRINT_JOBS"));
});

test("V397 no webhook evidence never authorizes retry", () => {
  const input: OrderRecoveryDetailV396 = {
    orderId: id,
    snapshot: null,
    labels: [],
    diagnosticStatus: "NO_PAID_WEBHOOK_EVIDENCE"
  };

  const result = assessOrderRecoveryV397(input);
  assert.ok(result.missing.includes("PAID_WEBHOOK_EVIDENCE"));
  assert.equal(result.automaticRetryAllowed, false);
});
