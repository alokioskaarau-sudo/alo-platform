import { db } from "../../database/db.js";
import {
  getAloLiveMetrics,
} from "./aloNowLiveMetrics.js";

export type AloOperationsSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  drivers: Awaited<ReturnType<typeof getAloLiveMetrics>>["drivers"];
  deliveries: Awaited<ReturnType<typeof getAloLiveMetrics>>["deliveries"];
  warehouse: {
    packingNew: number;
    packingActive: number;
    packed: number;
    readyToShip: number;
    completedToday: number;
    aloNowPackedWaitingForPickup: number;
  };
  analytics: {
    activeWebsiteVisitors: null;
    status: "NOT_CONNECTED";
  };
};

export async function getAloOperationsSnapshot():
  Promise<AloOperationsSnapshot> {

  const [live, warehouse] = await Promise.all([
    getAloLiveMetrics(),
    db.query<{
      packing_new: number;
      packing_active: number;
      packed: number;
      ready_to_ship: number;
      completed_today: number;
      alo_now_packed_waiting: number;
    }>(`
      SELECT
        COUNT(*) FILTER (
          WHERE w.pack_status = 'NEW'
        )::int AS packing_new,

        COUNT(*) FILTER (
          WHERE w.pack_status = 'PACKING'
        )::int AS packing_active,

        COUNT(*) FILTER (
          WHERE w.pack_status = 'PACKED'
        )::int AS packed,

        COUNT(*) FILTER (
          WHERE w.pack_status = 'READY_TO_SHIP'
        )::int AS ready_to_ship,

        COUNT(*) FILTER (
          WHERE w.pack_status = 'COMPLETED'
          AND w.completed_at >=
            DATE_TRUNC(
              'day',
              NOW() AT TIME ZONE 'Europe/Zurich'
            ) AT TIME ZONE 'Europe/Zurich'
        )::int AS completed_today,

        COUNT(*) FILTER (
          WHERE w.pack_status = 'PACKED'
          AND EXISTS (
            SELECT 1
            FROM alo_now_deliveries d
            WHERE d.shopify_order_id = w.shopify_order_id
              AND d.delivery_status IN (
                'DRIVER_ASSIGNED',
                'READY_FOR_PICKUP'
              )
          )
        )::int AS alo_now_packed_waiting

      FROM order_fulfillment_workflow w
    `),
  ]);

  const row = warehouse.rows[0];

  if (!row) {
    throw new Error("ALO_WAREHOUSE_SNAPSHOT_UNAVAILABLE");
  }

  return {
    schemaVersion: 1,
    generatedAt: live.generatedAt,
    drivers: live.drivers,
    deliveries: live.deliveries,
    warehouse: {
      packingNew: row.packing_new,
      packingActive: row.packing_active,
      packed: row.packed,
      readyToShip: row.ready_to_ship,
      completedToday: row.completed_today,
      aloNowPackedWaitingForPickup:
        row.alo_now_packed_waiting,
    },
    analytics: {
      activeWebsiteVisitors: null,
      status: "NOT_CONNECTED",
    },
  };
}
