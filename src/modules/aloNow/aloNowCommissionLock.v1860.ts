/** V1860 - transactional lock of an independently prepared server commission quote.
 * No tariff calculation, client-supplied amount, payout or ledger booking.
 * Called ONLY after successful driver assignment and BEFORE COMMIT.
 */
import type { PoolClient } from "pg";
import { ALO_DRIVER_TARIFF_V1861, quoteDriverCommissionV1861 } from "./aloNowDriverTariff.v1861.js";

export async function lockPreparedCommissionV1860(
  client: PoolClient,
  shopifyOrderId: string,
  staffUserId: string
): Promise<"LOCKED" | "NOT_CONFIGURED"> {
  if (!/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(shopifyOrderId) ||
      !/^[1-9][0-9]{0,18}$/.test(staffUserId)) {
    throw new Error("V1860_INVALID_SCOPE");
  }
  // A read-only existence check allows a code rollout before the migration.
  const table = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.alo_now_driver_commission_quotes_v1860') IS NOT NULL AS exists"
  );
  if (!table.rows[0]?.exists) return "NOT_CONFIGURED";

  // The immutable amount was prepared from a trusted route + versioned tariff
  // by a separate server-only source (not yet wired). Never recalculate here.
  // Match the same validated tariff and workspace that the driver sees.
  // FOR UPDATE serializes with quote renewal and other claim attempts.
  const available = await client.query<{
    workspace: string;
    tariff_version: string;
    currency: string;
    distance_metres: number;
    base_rappen: number;
    rappen_per_km: number;
    cap_rappen: number;
    quoted_commission_rappen: number;
  }>(`
    SELECT workspace, tariff_version, currency, distance_metres,
           base_rappen, rappen_per_km, cap_rappen, quoted_commission_rappen
    FROM alo_now_driver_commission_quotes_v1860
    WHERE order_id=$1 AND status='PREPARED'
      AND driver_user_id IS NULL AND valid_until > NOW()
    FOR UPDATE
  `, [shopifyOrderId]);
  const row = available.rows[0];
  const tariff = ALO_DRIVER_TARIFF_V1861;
  if (row) {
    let valid = false;
    try {
      valid = (row.workspace === "AARAU" || row.workspace === "OLTEN") &&
        row.tariff_version === tariff.version && row.currency === "CHF" &&
        Number(row.base_rappen) === tariff.baseRappen &&
        Number(row.rappen_per_km) === tariff.rappenPerKm &&
        Number(row.cap_rappen) === tariff.capRappen &&
        quoteDriverCommissionV1861(Number(row.distance_metres))
          .quotedCommissionRappen === Number(row.quoted_commission_rappen);
    } catch { valid = false; }
    if (!valid) throw new Error("V1880_COMMISSION_TARIFF_MISMATCH");

    const locked = await client.query<{ order_id: string }>(`
      UPDATE alo_now_driver_commission_quotes_v1860
      SET driver_user_id=$2, status='LOCKED', accepted_at=NOW()
      WHERE order_id=$1 AND status='PREPARED'
        AND driver_user_id IS NULL AND valid_until > NOW()
      RETURNING order_id
    `, [shopifyOrderId, staffUserId]);
    if (locked.rowCount === 1) return "LOCKED";
  }

  const existing = await client.query<{
    status: string;
    driver_user_id: string | null;
  }>(`
    SELECT status, driver_user_id
    FROM alo_now_driver_commission_quotes_v1860
    WHERE order_id=$1 FOR UPDATE
  `, [shopifyOrderId]);
  if (existing.rows.length === 0) return "NOT_CONFIGURED";
  // Existing but unusable quote means a misconfigured commercial promise:
  // abort BOTH the driver claim and quote lock atomically.
  throw new Error("V1860_COMMISSION_QUOTE_INVALID_OR_EXPIRED");
}
