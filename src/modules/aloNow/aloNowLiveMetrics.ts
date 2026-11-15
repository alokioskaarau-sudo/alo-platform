import { db } from "../../database/db.js";

/**
 * ALO LIVE – Aggregierte Betriebskennzahlen.
 *
 * Read-only. Keine Kundendaten, Fahreridentitäten,
 * Standortkoordinaten oder externen API-Aufrufe.
 *
 * Online = freigegeben + ONLINE + frischer Heartbeat.
 * Ein Fahrer mit aktivem Auftrag ist nicht automatisch verfügbar.
 */

export type AloLiveMetrics = {
  generatedAt: string;
  driverHeartbeatWindowSeconds: number;
  drivers: {
    online: number;
    available: number;
    busy: number;
    byWorkspace: {
      AARAU: number;
      OLTEN: number;
      ONLINE: number;
    };
  };
  deliveries: {
    waiting: number;
    assigned: number;
    readyForPickup: number;
    pickedUp: number;
    onTheWay: number;
    deliveredToday: number;
  };
};

export async function getAloLiveMetrics():
  Promise<AloLiveMetrics> {

  const result = await db.query<{
    online: number;
    available: number;
    busy: number;
    aarau: number;
    olten: number;
    online_workspace: number;
    waiting: number;
    assigned: number;
    ready: number;
    picked: number;
    driving: number;
    delivered_today: number;
  }>(`
    WITH
    driver_states AS (
      SELECT
        p.staff_user_id,
        p.home_workspace,
        COALESCE((
          SELECT COUNT(*)::int
          FROM alo_now_deliveries d
          WHERE d.assigned_driver_user_id =
            p.staff_user_id
            AND d.delivery_status IN (
              'DRIVER_ASSIGNED',
              'READY_FOR_PICKUP',
              'PICKED_UP',
              'ON_THE_WAY'
            )
        ), 0) AS active_deliveries,
        (
          p.approved = TRUE
          AND p.availability_status = 'ONLINE'
          AND p.last_seen_at >=
            NOW() - INTERVAL '90 seconds'
          AND p.last_seen_at <=
            NOW() + INTERVAL '10 seconds'
        ) AS is_online,
        p.max_active_deliveries
      FROM alo_driver_profiles p
    ),
    drivers AS (
      SELECT
        COUNT(*) FILTER (
          WHERE is_online
        )::int AS online,

        COUNT(*) FILTER (
          WHERE is_online
          AND active_deliveries < max_active_deliveries
        )::int AS available,

        COUNT(*) FILTER (
          WHERE is_online
          AND active_deliveries >= max_active_deliveries
        )::int AS busy,

        COUNT(*) FILTER (
          WHERE is_online AND home_workspace = 'AARAU'
        )::int AS aarau,

        COUNT(*) FILTER (
          WHERE is_online AND home_workspace = 'OLTEN'
        )::int AS olten,

        COUNT(*) FILTER (
          WHERE is_online AND home_workspace = 'ONLINE'
        )::int AS online_workspace
      FROM driver_states
    ),
    deliveries AS (
      SELECT
        COUNT(*) FILTER (
          WHERE delivery_status = 'WAITING_FOR_DRIVER'
        )::int AS waiting,

        COUNT(*) FILTER (
          WHERE delivery_status = 'DRIVER_ASSIGNED'
        )::int AS assigned,

        COUNT(*) FILTER (
          WHERE delivery_status = 'READY_FOR_PICKUP'
        )::int AS ready,

        COUNT(*) FILTER (
          WHERE delivery_status = 'PICKED_UP'
        )::int AS picked,

        COUNT(*) FILTER (
          WHERE delivery_status = 'ON_THE_WAY'
        )::int AS driving,

        COUNT(*) FILTER (
          WHERE delivery_status = 'DELIVERED'
          AND delivered_at >=
            DATE_TRUNC('day', NOW() AT TIME ZONE 'Europe/Zurich')
              AT TIME ZONE 'Europe/Zurich'
        )::int AS delivered_today
      FROM alo_now_deliveries
    )
    SELECT *
    FROM drivers CROSS JOIN deliveries
  `);

  const row = result.rows[0];

  if (!row) {
    throw new Error("ALO_LIVE_METRICS_UNAVAILABLE");
  }

  return {
    generatedAt: new Date().toISOString(),
    driverHeartbeatWindowSeconds: 90,
    drivers: {
      online: row.online,
      available: row.available,
      busy: row.busy,
      byWorkspace: {
        AARAU: row.aarau,
        OLTEN: row.olten,
        ONLINE: row.online_workspace,
      },
    },
    deliveries: {
      waiting: row.waiting,
      assigned: row.assigned,
      readyForPickup: row.ready,
      pickedUp: row.picked,
      onTheWay: row.driving,
      deliveredToday: row.delivered_today,
    },
  };
}
