/** ALO NOW V1863: prepare a commission snapshot using trusted Shopify address
 * and verified road route. Admin-only caller; no customer money or payout.
 */
import { createHash } from "node:crypto";
import { db } from "../../database/db.js";
import { getAloNowDelivery } from "../../database/aloNowDeliveries.js";
import { getShopifyOrderById } from "../../integrations/shopify/orders.js";
import { getVerifiedAloNowQuote } from "./aloNowVerifiedRouting.service.js";
import { ALO_DRIVER_TARIFF_V1861, quoteDriverCommissionV1861 } from "./aloNowDriverTariff.v1861.js";

const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
export type PreparationResultV1863 =
  | { ok: true; status: "PREPARED"; commissionRappen: number; distanceMetres: number; tariffVersion: string }
  | { ok: false; reason: string };

export async function prepareDriverCommissionV1863(orderId: string): Promise<PreparationResultV1863> {
  if (!ORDER.test(orderId)) return { ok: false, reason: "INVALID_ORDER_ID" };
  // Never call the route provider if the corresponding finance table is absent.
  const table = await db.query<{ present: boolean }>(
    "SELECT to_regclass('public.alo_now_driver_commission_quotes_v1860') IS NOT NULL AS present"
  );
  if (!table.rows[0]?.present) return { ok: false, reason: "COMMISSION_MIGRATION_REQUIRED" };

  const delivery = await getAloNowDelivery(orderId);
  if (!delivery || delivery.delivery_status !== "WAITING_FOR_DRIVER" ||
      delivery.assigned_driver_user_id !== null ||
      (delivery.fulfillment_workspace !== "AARAU" && delivery.fulfillment_workspace !== "OLTEN")) {
    return { ok: false, reason: "DELIVERY_NOT_AVAILABLE" };
  }
  const workspace = delivery.fulfillment_workspace;

  // V1882: webhook recovery may run for an order already holding a valid
  // PREPARED quote. Reuse the immutable promise rather than fetching another
  // provider route or attempting to overwrite a non-expired offer.
  async function readExistingPreparedV1882(): Promise<PreparationResultV1863 | null> {
    const result = await db.query<{
      workspace: string;
      status: string;
      driver_user_id: string | null;
      tariff_version: string;
      currency: string;
      route_source_reference: string;
      distance_metres: number;
      base_rappen: number;
      rappen_per_km: number;
      cap_rappen: number;
      quoted_commission_rappen: number;
    }>(`SELECT workspace, status, driver_user_id, tariff_version, currency,
              route_source_reference, distance_metres, base_rappen,
              rappen_per_km, cap_rappen, quoted_commission_rappen
         FROM alo_now_driver_commission_quotes_v1860
        WHERE order_id=$1 AND status='PREPARED'
          AND driver_user_id IS NULL AND valid_until > NOW()`, [orderId]);
    const row = result.rows[0];
    if (!row) return null;
    const tariff = ALO_DRIVER_TARIFF_V1861;
    try {
      const metres = Number(row.distance_metres);
      const quote = quoteDriverCommissionV1861(metres);
      const valid = row.workspace === workspace &&
        row.tariff_version === tariff.version && row.currency === "CHF" &&
        row.route_source_reference.startsWith("ORS_DERIVED_V2:") &&
        Number(row.base_rappen) === tariff.baseRappen &&
        Number(row.rappen_per_km) === tariff.rappenPerKm &&
        Number(row.cap_rappen) === tariff.capRappen &&
        quote.quotedCommissionRappen === Number(row.quoted_commission_rappen);
      if (!valid) return { ok: false, reason: "EXISTING_COMMISSION_QUOTE_INVALID" };
      return { ok: true, status: "PREPARED", commissionRappen: quote.quotedCommissionRappen,
        distanceMetres: metres, tariffVersion: tariff.version };
    } catch {
      return { ok: false, reason: "EXISTING_COMMISSION_QUOTE_INVALID" };
    }
  }

  const existingPrepared = await readExistingPreparedV1882();
  if (existingPrepared) return existingPrepared;

  const order = await getShopifyOrderById(orderId);
  const address = order?.shippingAddress;
  if (!address || !address.address1 || !address.zip || !address.city) {
    return { ok: false, reason: "SHOPIFY_SHIPPING_ADDRESS_MISSING" };
  }
  // Shopify is the address authority; client-submitted distances are never accepted.
  const fullAddress = [address.address1, address.address2,
    `${address.zip} ${address.city}`, address.country ?? "Schweiz"]
    .filter(Boolean).join(", ");
  const road = await getVerifiedAloNowQuote(fullAddress, workspace);
  if (road.status !== "STANDARD" || typeof road.roadDistanceKm !== "number") {
    return { ok: false, reason: "SERVER_ROUTE_UNVERIFIED_OR_OUT_OF_ZONE" };
  }
  // Provider response from V2 is rounded to 0.01 km (= 10 m).
  const metres = Math.round(road.roadDistanceKm * 1000);
  if (!Number.isSafeInteger(metres) || metres <= 0) {
    return { ok: false, reason: "INVALID_ROAD_DISTANCE" };
  }
  const quote = quoteDriverCommissionV1861(metres);
  const tariff = ALO_DRIVER_TARIFF_V1861;
  // Audit identifier is a local derived fingerprint, NOT a provider receipt.
  const routeReference = "ORS_DERIVED_V2:" + createHash("sha256")
    .update(JSON.stringify({ orderId, workspace, fullAddress, metres }))
    .digest("hex");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ delivery_status: string; assigned_driver_user_id: string | null; fulfillment_workspace: string }>(
      `SELECT delivery_status, assigned_driver_user_id, fulfillment_workspace
         FROM alo_now_deliveries WHERE shopify_order_id=$1 FOR UPDATE`, [orderId]
    );
    if (current.rows[0]?.delivery_status !== "WAITING_FOR_DRIVER" ||
        current.rows[0]?.assigned_driver_user_id != null ||
        current.rows[0]?.fulfillment_workspace !== workspace) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "DELIVERY_CHANGED_DURING_VERIFICATION" };
    }
    const saved = await client.query<{ order_id: string }>(
      `INSERT INTO alo_now_driver_commission_quotes_v1860
        (order_id, workspace, tariff_version, route_source_reference,
         distance_metres, base_rappen, rappen_per_km, cap_rappen,
         quoted_commission_rappen, currency, valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CHF',NOW() + INTERVAL '30 minutes')
       ON CONFLICT (order_id) DO UPDATE SET
         workspace = EXCLUDED.workspace,
         tariff_version = EXCLUDED.tariff_version,
         route_source_reference = EXCLUDED.route_source_reference,
         distance_metres = EXCLUDED.distance_metres,
         base_rappen = EXCLUDED.base_rappen,
         rappen_per_km = EXCLUDED.rappen_per_km,
         cap_rappen = EXCLUDED.cap_rappen,
         quoted_commission_rappen = EXCLUDED.quoted_commission_rappen,
         currency = EXCLUDED.currency,
         prepared_at = NOW(),
         valid_until = EXCLUDED.valid_until
       WHERE alo_now_driver_commission_quotes_v1860.status = 'PREPARED'
         AND alo_now_driver_commission_quotes_v1860.driver_user_id IS NULL
         AND alo_now_driver_commission_quotes_v1860.valid_until <= NOW()
       RETURNING order_id`,
      [orderId, workspace, tariff.version, routeReference, metres,
       tariff.baseRappen, tariff.rappenPerKm, tariff.capRappen, quote.quotedCommissionRappen]
    );
    if (saved.rowCount !== 1) {
      await client.query("ROLLBACK");
      // Another invocation might have prepared the same order in parallel.
      // Return the existing valid offer, but never silently accept an invalid one.
      const concurrentlyPrepared = await readExistingPreparedV1882();
      return concurrentlyPrepared ?? { ok: false, reason: "COMMISSION_QUOTE_ALREADY_EXISTS" };
    }
    await client.query("COMMIT");
    return { ok: true, status: "PREPARED", commissionRappen: quote.quotedCommissionRappen,
      distanceMetres: metres, tariffVersion: quote.tariffVersion };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}
