// V3500_INTERNAL_DELIVERY_CHECKOUT
/**
 * ALO NOW V2965 – Persistente Checkout-Versuche.
 *
 * No Shopify API calls. No HTTP routes. No migrations executed.
 *
 * The caller must:
 * - authenticate and authorize access;
 * - lock and validate the request and payment state;
 * - verify cart, address, quote and valid driver reservation;
 * - use this service within an existing DB transaction;
 * - never automatically retry an uncertain Shopify create.
 *
 * A successful reservation only authorizes one external
 * attempt after the caller commits the transaction.
 */

import type { PoolClient } from "pg";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DRAFT =
  /^gid:\/\/shopify\/DraftOrder\/[1-9][0-9]*$/;

const CHF =
  /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;

export type AloNowCheckoutRecord = {
  request_id: string;
  checkout_reference: string;
  status: "CREATING" | "READY" | "RECONCILE";
  expected_total_chf: string;
  draft_order_id: string | null;
  invoice_url: string | null;
};

function validateIdentity(
  requestId: string,
  reference: string,
  amount: string
): void {
  if (!UUID.test(requestId) || !UUID.test(reference)) {
    throw new Error("INVALID_CHECKOUT_IDENTITY");
  }

  if (!CHF.test(amount) || Number(amount) <= 0) {
    throw new Error("INVALID_CHECKOUT_TOTAL");
  }
}

/**
 * Reserve an attempt. Duplicate requests never acquire
 * permission for a second external create.
 *
 * The caller must commit this reservation BEFORE calling
 * Shopify. A crash after commit leaves CREATING, which is
 * intentionally NOT eligible for an automatic second create.
 */
export async function reserveAloNowCheckoutAttempt(
  client: PoolClient,
  requestId: string,
  reference: string,
  expectedTotalCHF: string
): Promise<boolean> {
  validateIdentity(requestId, reference, expectedTotalCHF);

  const result = await client.query(
    `INSERT INTO public.alo_now_checkout_attempts
      (request_id, checkout_reference, status,
       expected_total_chf)
     SELECT r.id, $2, 'CREATING', $3::numeric
     FROM public.alo_now_order_requests r
     JOIN public.alo_now_payment_states pay
       ON pay.request_id = r.id
     WHERE r.id = $1
       AND r.workspace = 'AARAU'
       AND (
         (
           r.status = 'DRIVER_ACCEPTED'
           AND r.driver_user_id IS NOT NULL
           AND r.reservation_expires_at > clock_timestamp()
         )
         OR (
           r.status IN ('PENDING_REVIEW', 'CONTACTED')
           AND
                 EXISTS (
                   SELECT 1
                   FROM public.alo_now_merchant_acceptances m
                   WHERE m.request_id = r.id
                     AND m.fulfillment_method = 'INTERNAL_DELIVERY'
                     AND m.capacity_confirmed_at <= clock_timestamp()
                     AND m.capacity_confirmed_until > clock_timestamp()
                     AND btrim(m.accepted_by) <> ''
                     AND m.assigned_driver_id IS NULL
                 )

           AND (
             r.quote_status = 'STANDARD'
             OR (
               r.quote_status = 'MANUAL_APPROVAL'
               AND EXISTS (
                 SELECT 1
                 FROM public.alo_now_manual_offers mo
                 WHERE mo.request_id = r.id
                   AND mo.status = 'ACCEPTED'
                AND mo.version = (
                  SELECT MAX(newest.version)
                  FROM public.alo_now_manual_offers newest
                  WHERE newest.request_id = r.id
                )
               )
             )
           )
         )
       )
       -- ALO_NOW_V3078_PERSISTED_MANUAL_TOTAL
       AND (
         (
           r.quote_status = 'STANDARD'
           AND r.quoted_delivery_fee_chf::numeric = 12.90
           AND (
             r.verified_subtotal_chf::numeric
             + r.quoted_delivery_fee_chf::numeric
           ) = $3::numeric
         )
         OR (
           r.quote_status = 'MANUAL_APPROVAL'
           AND EXISTS (
             SELECT 1
             FROM public.alo_now_manual_offers mo
             WHERE mo.request_id = r.id
               AND mo.status = 'ACCEPTED'
                AND mo.version = (
                  SELECT MAX(newest.version)
                  FROM public.alo_now_manual_offers newest
                  WHERE newest.request_id = r.id
                )
               AND mo.subtotal_chf = r.verified_subtotal_chf
               AND mo.delivery_fee_chf = 12.90
               AND mo.total_chf =
                   mo.subtotal_chf
                   + mo.delivery_fee_chf
                   + mo.extra_fee_chf
               AND mo.total_chf = $3::numeric
           )
         )
       )
       AND r.verified_at IS NOT NULL
       AND r.verified_subtotal_chf IS NOT NULL
       AND r.verified_subtotal_chf::numeric > 0
       AND pay.phase = 'AWAITING_PAYMENT'
       AND pay.payment_method = 'ONLINE'
     FOR UPDATE OF r, pay
     ON CONFLICT DO NOTHING
     RETURNING request_id`,
    [requestId, reference, expectedTotalCHF]
  );

  return result.rowCount === 1;
}

/**
 * Persist a previously validated Shopify Draft response.
 * This does not confirm customer payment.
 *
 * The caller must independently validate the Shopify
 * response and use the exact original expected CHF total.
 */
export async function markAloNowCheckoutReady(
  client: PoolClient,
  requestId: string,
  reference: string,
  draftOrderId: string,
  invoiceUrl: string,
  expectedTotalCHF: string
): Promise<boolean> {
  validateIdentity(requestId, reference, expectedTotalCHF);

  if (!DRAFT.test(draftOrderId)) {
    throw new Error("INVALID_SHOPIFY_DRAFT_ID");
  }

  let url: URL;

  try {
    url = new URL(invoiceUrl);
  } catch {
    throw new Error("INVALID_CHECKOUT_URL");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    invoiceUrl.length > 2048
  ) {
    throw new Error("INVALID_CHECKOUT_URL");
  }

  const result = await client.query(
    `UPDATE public.alo_now_checkout_attempts
     SET status = 'READY',
         draft_order_id = $3,
         invoice_url = $4,
         updated_at = NOW()
     WHERE request_id = $1
       AND checkout_reference = $2
       AND status = 'CREATING'
       AND expected_total_chf = $5::numeric
       AND EXISTS (
         SELECT 1
         FROM public.alo_now_order_requests r
         JOIN public.alo_now_payment_states pay
           ON pay.request_id = r.id
         WHERE r.id = $1
           AND r.workspace = 'AARAU'
           AND (
             (
               r.status = 'DRIVER_ACCEPTED'
               AND r.driver_user_id IS NOT NULL
               AND r.reservation_expires_at > clock_timestamp()
             )
             OR (
               r.status IN ('PENDING_REVIEW', 'CONTACTED')
               AND
                     EXISTS (
                       SELECT 1
                       FROM public.alo_now_merchant_acceptances m
                       WHERE m.request_id = r.id
                         AND m.fulfillment_method = 'INTERNAL_DELIVERY'
                         AND m.capacity_confirmed_at <= clock_timestamp()
                         AND m.capacity_confirmed_until > clock_timestamp()
                         AND btrim(m.accepted_by) <> ''
                         AND m.assigned_driver_id IS NULL
                     )

               AND (
                 r.quote_status = 'STANDARD'
                 OR (
                   r.quote_status = 'MANUAL_APPROVAL'
                   AND EXISTS (
                     SELECT 1
                     FROM public.alo_now_manual_offers mo
                     WHERE mo.request_id = r.id
                       AND mo.status = 'ACCEPTED'
                AND mo.version = (
                  SELECT MAX(newest.version)
                  FROM public.alo_now_manual_offers newest
                  WHERE newest.request_id = r.id
                )
                   )
                 )
               )
             )
           )
           AND pay.phase = 'AWAITING_PAYMENT'
           AND pay.payment_method = 'ONLINE'
       )
     RETURNING request_id`,
    [
      requestId,
      reference,
      draftOrderId,
      invoiceUrl,
      expectedTotalCHF
    ]
  );

  return result.rowCount === 1;
}

/**
 * Unknown Shopify result: block automatic re-creation.
 * Recovery requires a separately verified Shopify lookup.
 */
export async function markAloNowCheckoutUncertain(
  client: PoolClient,
  requestId: string,
  reference: string
): Promise<boolean> {
  if (!UUID.test(requestId) || !UUID.test(reference)) {
    throw new Error("INVALID_CHECKOUT_IDENTITY");
  }

  const result = await client.query(
    `UPDATE public.alo_now_checkout_attempts
     SET status = 'RECONCILE',
         updated_at = NOW()
     WHERE request_id = $1
       AND checkout_reference = $2
       AND status = 'CREATING'
     RETURNING request_id`,
    [requestId, reference]
  );

  return result.rowCount === 1;
}

/**
 * Read only. Never return invoice_url to an unauthenticated
 * or unverified caller: the URL grants checkout access.
 */
export async function findAloNowCheckoutAttempt(
  client: PoolClient,
  requestId: string
): Promise<AloNowCheckoutRecord | null> {
  if (!UUID.test(requestId)) {
    throw new Error("INVALID_REQUEST_ID");
  }

  const result = await client.query<AloNowCheckoutRecord>(
    `SELECT request_id,
            checkout_reference,
            status,
            expected_total_chf::text,
            draft_order_id,
            invoice_url
     FROM public.alo_now_checkout_attempts
     WHERE request_id = $1`,
    [requestId]
  );

  return result.rows[0] ?? null;
}
