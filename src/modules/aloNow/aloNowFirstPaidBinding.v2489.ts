/**
 * V2489: Resolve an initially unbound ALO NOW order.
 * Read-only: never binds, confirms, prints or dispatches.
 *
 * Provenance must be obtained from trusted Shopify Admin API,
 * not from webhook payload fields or customer input.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

type Provenance = {
  id: string;
  aloNowRequestId: string;
  aloNowCheckoutReference: string;
};

type Record = {
  request_id: string;
  checkout_reference: string;
  payment_order_id: string | null;
  intent_order_id: string | null;
  workspace: string;
  phase: string;
  payment_method: string;
};

type Dependencies = {
  readShopifyProvenance: (
    orderId: string
  ) => Promise<Provenance | null>;
  readCheckoutRecord: (
    requestId: string,
    checkoutReference: string
  ) => Promise<Record[]>;
};

export async function resolveFirstPaidBindingV2489(
  orderId: string,
  deps: Dependencies
): Promise<
  | { ok: true; requestId: string; orderId: string }
  | { ok: false; reason: string }
> {
  if (!ORDER.test(orderId))
    return { ok: false, reason: "INVALID_ORDER_ID" };

  let evidence: Provenance | null;

  try {
    evidence = await deps.readShopifyProvenance(orderId);
  } catch {
    return { ok: false, reason: "PROVENANCE_UNAVAILABLE" };
  }

  if (
    !evidence ||
    evidence.id !== orderId ||
    !UUID.test(evidence.aloNowRequestId) ||
    !UUID.test(evidence.aloNowCheckoutReference)
  ) {
    return { ok: false, reason: "PROVENANCE_INVALID" };
  }

  let rows: Record[];

  try {
    rows = await deps.readCheckoutRecord(
      evidence.aloNowRequestId,
      evidence.aloNowCheckoutReference
    );
  } catch {
    return { ok: false, reason: "CHECKOUT_LOOKUP_FAILED" };
  }

  if (!Array.isArray(rows) || rows.length !== 1)
    return { ok: false, reason: "CHECKOUT_NOT_UNIQUE" };

  const record = rows[0];

  if (
    record.request_id !== evidence.aloNowRequestId ||
    record.checkout_reference !==
      evidence.aloNowCheckoutReference
  ) {
    return { ok: false, reason: "CHECKOUT_IDENTITY_MISMATCH" };
  }

  if (record.workspace !== "AARAU")
    return { ok: false, reason: "WORKSPACE_NOT_RELEASED" };

  if (
    record.phase !== "AWAITING_PAYMENT" ||
    record.payment_method !== "ONLINE"
  ) {
    return { ok: false, reason: "PAYMENT_STATE_NOT_READY" };
  }

  if (
    (record.payment_order_id !== null &&
      record.payment_order_id !== orderId) ||
    (record.intent_order_id !== null &&
      record.intent_order_id !== orderId)
  ) {
    return { ok: false, reason: "EXISTING_BINDING_CONFLICT" };
  }

  return {
    ok: true,
    requestId: evidence.aloNowRequestId,
    orderId
  };
}
