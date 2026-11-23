/**
 * ALO NOW V2973
 *
 * Read-only validation of a persisted order request.
 *
 * No checkout creation, payment confirmation, HTTP route
 * or Shopify mutation.
 *
 * This snapshot does NOT independently authorize checkout.
 * A later orchestrator must lock and revalidate request
 * and payment state atomically before reserving a draft.
 */

import type { PoolClient } from "pg";
import {
  validateAloNowDeliveryContact,
  formatAloNowDeliveryAddress
} from "./aloNowDeliveryContact.js";
import type {
  AloNowDeliveryContact
} from "./aloNowDeliveryContact.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VARIANT =
  /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;

type StoredRow = {
  id: string;
  workspace: string;
  status: string;
  delivery_address: string | null;
  delivery_contact: unknown;
  items: unknown;
  quote_status: string | null;
  road_distance_km: string | null;
  delivery_fee_chf: string | null;
  verified_subtotal_chf: string | null;
  verified_at: Date | string | null;
  driver_user_id: string | null;
  reservation_valid: boolean;
  payment_phase: string | null;
  payment_method: string | null;
};

export type AloNowStoredCheckoutSnapshot = {
  requestId: string;
  workspace: "AARAU";
  deliveryAddress: string;
  deliveryContact: AloNowDeliveryContact;
  roadDistanceKm: number;
  deliveryFeeCHF: string;
  subtotalCHF: string;
  expectedTotalCHF: string;
  lineItems: Array<{
    variantId: string;
    quantity: number;
  }>;
};

export class AloNowSnapshotError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AloNowSnapshotError";
  }
}

function reject(code: string): never {
  throw new AloNowSnapshotError(code);
}

function moneyCents(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(value)
  ) reject("INVALID_STORED_MONEY");

  const [whole, decimal] = value.split(".");
  return BigInt(whole) * 100n + BigInt(decimal);
}

function numberPriceCents(value: unknown): bigint {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0
  ) reject("INVALID_STORED_ITEM_PRICE");

  const raw = value * 100;
  const rounded = Math.round(raw);

  if (
    !Number.isSafeInteger(rounded) ||
    Math.abs(raw - rounded) > 0.000001
  ) reject("INVALID_STORED_ITEM_PRICE");

  return BigInt(rounded);
}

function asCHF(cents: bigint): string {
  if (cents < 0n) reject("INVALID_STORED_MONEY");
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export function validateAloNowStoredCheckoutRow(
  row: StoredRow
): AloNowStoredCheckoutSnapshot {
  if (!row || !UUID.test(row.id))
    reject("INVALID_STORED_REQUEST");

  if (row.workspace !== "AARAU")
    reject("WORKSPACE_NOT_ALLOWED");

  // V3500_INTERNAL_DELIVERY_CHECKOUT
  const internal = row as typeof row & {
    merchant_capacity_active?: boolean;
  };

  const driverValid =
    row.status === "DRIVER_ACCEPTED" &&
    !!row.driver_user_id &&
    row.reservation_valid === true;

  const internalValid =
    ["PENDING_REVIEW", "CONTACTED"].includes(row.status) &&
    internal.merchant_capacity_active === true;

  if (!driverValid && !internalValid)
    reject("DELIVERY_CAPACITY_REQUIRED");

  if (
    row.payment_phase !== "AWAITING_PAYMENT" ||
    row.payment_method !== "ONLINE"
  ) reject("ONLINE_PAYMENT_REQUIRED");

  if (
    (row.quote_status !== "STANDARD" &&
     row.quote_status !== "MANUAL_APPROVAL") ||
    !row.verified_at
  ) reject("VERIFIED_QUOTE_REQUIRED");

  if (
    row.road_distance_km === null ||
    typeof row.road_distance_km !== "string"
  ) reject("ROAD_DISTANCE_UNVERIFIED");

  const distance = Number(row.road_distance_km);

  if (
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(
      row.road_distance_km
    ) ||
    !Number.isFinite(distance) ||
    distance < 0 ||
    (row.quote_status === "STANDARD" && distance > 12)
  ) reject("OUTSIDE_STANDARD_DELIVERY_ZONE");

  const address = row.delivery_address?.trim();

  if (
    !address ||
    address.length < 8 ||
    address.length > 180 ||
    !/\b[1-9][0-9]{3}\b/.test(address)
  ) reject("STORED_ADDRESS_INCOMPLETE");

  // No legacy order may create a new Shopify draft
  // without complete, server-persisted delivery data.
  let deliveryContact: AloNowDeliveryContact;

  try {
    deliveryContact = validateAloNowDeliveryContact(
      row.delivery_contact
    );
  } catch {
    reject("STORED_DELIVERY_CONTACT_INVALID");
  }

  if (
    formatAloNowDeliveryAddress(deliveryContact)
      !== address
  ) reject("STORED_DELIVERY_ADDRESS_MISMATCH");

  const fee = moneyCents(row.delivery_fee_chf);
  if (fee !== 1290n)
    reject("INVALID_DELIVERY_FEE");

  // ALO_NOW_V3078_MANUAL_PRICE_PROOF
  // Never use browser-provided manual prices.
  const manual = row as typeof row & {
    manual_subtotal_chf: string | null;
    manual_delivery_fee_chf: string | null;
    manual_extra_fee_chf: string | null;
    manual_total_chf: string | null;
  };

  let combinedDeliveryFee = fee;
  let manualExpectedTotal: bigint | null = null;

  if (row.quote_status === "MANUAL_APPROVAL") {
    if (
      !manual.manual_subtotal_chf ||
      !manual.manual_delivery_fee_chf ||
      !manual.manual_extra_fee_chf ||
      !manual.manual_total_chf
    ) reject("ACCEPTED_MANUAL_OFFER_REQUIRED");

    const manualSubtotal = moneyCents(manual.manual_subtotal_chf);
    const manualBase = moneyCents(manual.manual_delivery_fee_chf);
    const manualExtra = moneyCents(manual.manual_extra_fee_chf);
    const manualTotal = moneyCents(manual.manual_total_chf);

    if (
      manualBase !== 1290n ||
      manualSubtotal !== moneyCents(row.verified_subtotal_chf) ||
      manualSubtotal + manualBase + manualExtra !== manualTotal
    ) reject("MANUAL_OFFER_TOTAL_MISMATCH");

    combinedDeliveryFee = manualBase + manualExtra;
    manualExpectedTotal = manualTotal;
  }

  const storedSubtotal =
    moneyCents(row.verified_subtotal_chf);

  if (
    storedSubtotal <= 0n ||
    !Array.isArray(row.items) ||
    row.items.length < 1 ||
    row.items.length > 15
  ) reject("INVALID_STORED_CART");

  const used = new Set<string>();
  let calculatedSubtotal = 0n;

  const lineItems = row.items.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" ||
        Array.isArray(raw))
      reject("INVALID_STORED_CART_ITEM");

    const item = raw as Record<string, unknown>;

    if (
      typeof item.variantId !== "string" ||
      !VARIANT.test(item.variantId) ||
      !Number.isInteger(item.quantity) ||
      Number(item.quantity) < 1 ||
      Number(item.quantity) > 30 ||
      used.has(item.variantId)
    ) reject("INVALID_STORED_CART_ITEM");

    if (
      typeof item.title !== "string" ||
      item.title.length > 180 ||
      !item.title.trim()
    ) reject("INVALID_STORED_CART_ITEM");

    const unitCents =
      numberPriceCents(item.unitPriceCHF);

    used.add(item.variantId);

    calculatedSubtotal +=
      unitCents * BigInt(item.quantity as number);

    return {
      variantId: item.variantId,
      quantity: item.quantity as number
    };
  });

  if (
    calculatedSubtotal !== storedSubtotal ||
    calculatedSubtotal > 100000000n
  ) reject("STORED_CART_TOTAL_MISMATCH");

  return {
    requestId: row.id,
    workspace: "AARAU",
    deliveryAddress: address,
    deliveryContact,
    roadDistanceKm: distance,
    deliveryFeeCHF: asCHF(combinedDeliveryFee),
    subtotalCHF: asCHF(storedSubtotal),
    expectedTotalCHF: asCHF(
      manualExpectedTotal ?? (storedSubtotal + fee)
    ),
    lineItems
  };
}

/**
 * Reads only server-persisted values.
 * The SQL evaluates reservation validity using DB time.
 *
 * Not a substitute for the later atomic checkout
 * reservation and fresh Shopify verification.
 */
export async function loadAloNowStoredCheckoutSnapshot(
  client: PoolClient,
  requestId: string
): Promise<AloNowStoredCheckoutSnapshot> {
  if (!UUID.test(requestId))
    reject("INVALID_REQUEST_ID");

  const result = await client.query<StoredRow>(
    `SELECT
       r.id,
       r.workspace,
       r.status,
       r.delivery_address,
       r.delivery_contact,
       r.items,
       r.quote_status,
       r.road_distance_km::text,
       r.quoted_delivery_fee_chf::text
         AS delivery_fee_chf,
       r.verified_subtotal_chf::text,
       r.verified_at,
       r.driver_user_id::text,
       COALESCE(
         r.reservation_expires_at > clock_timestamp(),
         FALSE
       ) AS reservation_valid,
       p.phase AS payment_phase,
       p.payment_method,
       -- V3500_INTERNAL_DELIVERY_CHECKOUT
       EXISTS (
            SELECT 1
            FROM public.alo_now_merchant_acceptances m
            WHERE m.request_id = r.id
              AND m.fulfillment_method = 'INTERNAL_DELIVERY'
              AND m.capacity_confirmed_at <= clock_timestamp()
              AND m.capacity_confirmed_until > clock_timestamp()
              AND btrim(m.accepted_by) <> ''
              AND m.assigned_driver_id IS NULL
          ) AS merchant_capacity_active,

       manual.subtotal_chf::numeric(12,2)::text AS manual_subtotal_chf,
       manual.delivery_fee_chf::numeric(12,2)::text AS manual_delivery_fee_chf,
       manual.extra_fee_chf::numeric(12,2)::text AS manual_extra_fee_chf,
       manual.total_chf::numeric(12,2)::text AS manual_total_chf
     FROM public.alo_now_order_requests r
     LEFT JOIN public.alo_now_payment_states p
       ON p.request_id = r.id
     LEFT JOIN LATERAL (
       SELECT subtotal_chf, delivery_fee_chf,
              extra_fee_chf, total_chf
       FROM public.alo_now_manual_offers
       WHERE request_id = r.id
         AND status = 'ACCEPTED'
          AND version = (
            SELECT MAX(newest.version)
            FROM public.alo_now_manual_offers newest
            WHERE newest.request_id = r.id
          )
       ORDER BY version DESC
       LIMIT 1
     ) manual ON TRUE
     WHERE r.id = $1`,
    [requestId]
  );

  if (result.rows.length !== 1)
    reject("STORED_REQUEST_NOT_FOUND");

  return validateAloNowStoredCheckoutRow(
    result.rows[0]
  );
}
