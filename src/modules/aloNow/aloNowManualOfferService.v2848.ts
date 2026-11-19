// ALO_NOW_V2848_MANUAL_OFFER_SERVICE
// Requires the separately reviewed V2848 migration.
// No route registered. No payment or Shopify mutation.

import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import {
  calculateAloNowManualOfferV2847
} from "./aloNowManualOffer.v2847.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// ALO_NOW_V2860_VERIFIED_EXACT_MONEY
// PostgreSQL NUMERIC can return 28.5 instead of 28.50.
// Normalize as text; never round verified prices via float.
function exactVerifiedSubtotalV2860(value: string): string {
  const match =
    /^(0|[1-9][0-9]{0,7})(?:\\.([0-9]{1,2}))?$/.exec(value);

  if (!match) {
    throw new Error("INVALID_VERIFIED_SUBTOTAL");
  }

  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

export async function createAloNowManualOfferV2848(input: {
  requestId: string;
  staffUserId: string;
  allowedWorkspaces: string[];
  deliveryFeeCHF: string;
  extraFeeCHF: string;
  extraReason?: string | null;
}) {
  if (!UUID.test(input.requestId) ||
      !/^[1-9][0-9]*$/.test(input.staffUserId)) {
    throw new Error("INVALID_OFFER_IDENTITY");
  }

  const workspaces = input.allowedWorkspaces
    .map(x => x.toUpperCase())
    .filter(x => x === "AARAU" || x === "OLTEN");

  if (workspaces.length === 0) {
    throw new Error("WORKSPACE_NOT_ALLOWED");
  }

  const client = await db.connect();
  let transaction = false;

  try {
    await client.query("BEGIN");
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '12s'");

    const request = await client.query<{
      status: string;
      quote_status: string;
      verified_subtotal_chf: string | null;
      cart_verified: boolean;
    }>(`
      SELECT status, quote_status,
             verified_subtotal_chf::text,
             (verified_at IS NOT NULL) AS cart_verified
      FROM alo_now_order_requests
      WHERE id = $1 AND workspace = ANY($2::text[])
      FOR UPDATE
    `, [input.requestId, workspaces]);

    const row = request.rows[0];
    if (!row) throw new Error("REQUEST_NOT_FOUND");

    if (!["PENDING_REVIEW", "CONTACTED"].includes(row.status) ||
        row.quote_status !== "MANUAL_APPROVAL" ||
        row.verified_subtotal_chf === null ||
        row.cart_verified !== true) {
      throw new Error("REQUEST_NOT_ELIGIBLE");
    }

    // ALO_NOW_V2849_EXPIRE_OLD_OFFERS
    await client.query(`
      UPDATE alo_now_manual_offers
      SET status = 'EXPIRED'
      WHERE request_id = $1
        AND status = 'OFFERED'
        AND expires_at <= clock_timestamp()
    `, [input.requestId]);

    const existing = await client.query<{ id: string }>(`
      SELECT id
      FROM alo_now_manual_offers
      WHERE request_id = $1
        AND status IN ('OFFERED', 'ACCEPTED')
      LIMIT 1
    `, [input.requestId]);

    if (existing.rows.length > 0) {
      throw new Error("ACTIVE_OFFER_ALREADY_EXISTS");
    }

    const offer = calculateAloNowManualOfferV2847({
      verifiedSubtotalCHF: exactVerifiedSubtotalV2860(
        row.verified_subtotal_chf
      ),
      deliveryFeeCHF: input.deliveryFeeCHF,
      extraFeeCHF: input.extraFeeCHF,
      extraReason: input.extraReason
    });

    const versionResult = await client.query<{
      next_version: number;
    }>(`
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM alo_now_manual_offers
      WHERE request_id = $1
    `, [input.requestId]);

    const version = Number(versionResult.rows[0]?.next_version);

    const result = await client.query<{
      id: string;
      version: number;
      expires_at: Date;
    }>(`
      INSERT INTO alo_now_manual_offers (
        id, request_id, version, status,
        subtotal_chf, delivery_fee_chf,
        extra_fee_chf, extra_reason, total_chf,
        created_by_staff_user_id, expires_at
      ) VALUES (
        $1, $2, $3, 'OFFERED',
        $4, $5, $6, $7, $8,
        $9, NOW() + INTERVAL '15 minutes'
      )
      RETURNING id, version, expires_at
    `, [
      randomUUID(), input.requestId, version,
      offer.verifiedSubtotalCHF,
      offer.deliveryFeeCHF,
      offer.extraFeeCHF,
      offer.extraReason,
      offer.totalCHF,
      input.staffUserId
    ]);

    await client.query(`
      UPDATE alo_now_order_requests
      SET status = 'CONTACTED'
      WHERE id = $1 AND status = 'PENDING_REVIEW'
    `, [input.requestId]);

    await client.query("COMMIT");
    transaction = false;

    return {
      ok: true as const,
      offerId: result.rows[0].id,
      requestId: input.requestId,
      version: result.rows[0].version,
      expiresAt: result.rows[0].expires_at,
      offer,
      checkoutAllowed: false as const
    };
  } catch (error) {
    if (transaction) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
