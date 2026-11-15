/** V1862: read-only display of a preprepared server commission offer. Never books money. */
import { db } from "../../database/db.js";
import { ALO_DRIVER_TARIFF_V1861, quoteDriverCommissionV1861 } from "./aloNowDriverTariff.v1861.js";

type DeliveryOfferScopeV1862 = { orderId: string; workspace: string };
export type AvailableDriverCommissionV1862 = {
  status: "PREPARED";
  commissionRappen: number;
  distanceMetres: number;
  tariffVersion: string;
};

export async function readAvailableDriverCommissionsV1862(
  available: readonly DeliveryOfferScopeV1862[]
): Promise<Map<string, AvailableDriverCommissionV1862>> {
  const result = new Map<string, AvailableDriverCommissionV1862>();
  if (!available.length) return result;
  const scopes = new Map(available.filter(x =>
    /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(x.orderId) &&
    (x.workspace === "AARAU" || x.workspace === "OLTEN")
  ).map(x => [x.orderId, x.workspace]));
  if (!scopes.size) return result;

  const table = await db.query<{ present: boolean }>(
    "SELECT to_regclass('public.alo_now_driver_commission_quotes_v1860') IS NOT NULL AS present"
  );
  if (!table.rows[0]?.present) return result;

  const offers = await db.query<{
    order_id: string; workspace: string; status: string;
    driver_user_id: string | null; tariff_version: string;
    distance_metres: number; base_rappen: number;
    rappen_per_km: number; cap_rappen: number;
    quoted_commission_rappen: number; currency: string;
  }>(`SELECT order_id, workspace, status, driver_user_id, tariff_version,
           distance_metres, base_rappen, rappen_per_km, cap_rappen,
           quoted_commission_rappen, currency
      FROM alo_now_driver_commission_quotes_v1860
     WHERE order_id = ANY($1::text[])
       AND status = 'PREPARED' AND driver_user_id IS NULL
       AND valid_until > NOW()`, [Array.from(scopes.keys())]);

  const tariff = ALO_DRIVER_TARIFF_V1861;
  for (const row of offers.rows) {
    if (scopes.get(row.order_id) !== row.workspace ||
        row.tariff_version !== tariff.version || row.currency !== "CHF" ||
        Number(row.base_rappen) !== tariff.baseRappen ||
        Number(row.rappen_per_km) !== tariff.rappenPerKm ||
        Number(row.cap_rappen) !== tariff.capRappen) continue;
    const metres = Number(row.distance_metres);
    const stored = Number(row.quoted_commission_rappen);
    try {
      const check = quoteDriverCommissionV1861(metres);
      if (check.quotedCommissionRappen !== stored) continue;
      result.set(row.order_id, {
        status: "PREPARED", commissionRappen: stored,
        distanceMetres: metres, tariffVersion: tariff.version
      });
    } catch { /* Never present an invalid quote to a driver. */ }
  }
  return result;
}
