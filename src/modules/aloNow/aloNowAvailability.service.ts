import { db } from "../../database/db.js";
import type {
  AloNowWorkspace,
} from "../../database/aloNowDeliveries.js";

export type AloNowAvailabilityStatus =
  | "AVAILABLE"
  | "NO_DRIVER_CAPACITY";

export type AloNowAvailabilityResult = {
  available: boolean;
  status: AloNowAvailabilityStatus;
  workspace: AloNowWorkspace;
  estimatedMinutes: number | null;
  capacity: "AVAILABLE" | "UNAVAILABLE";
};

type AvailableDriverRow = {
  staff_user_id: string;
  max_active_deliveries: number;
  active_deliveries: number;
};

export async function getAloNowAvailability(
  workspace: AloNowWorkspace,
  _requiresAgeCheck = false
): Promise<AloNowAvailabilityResult> {
  const result =
    await db.query<AvailableDriverRow>(
      `
        SELECT
          driver.staff_user_id,
          driver.max_active_deliveries,
          COUNT(delivery.id)::INTEGER
            AS active_deliveries
        FROM alo_driver_profiles driver
        LEFT JOIN alo_now_deliveries delivery
          ON
            delivery.assigned_driver_user_id =
              driver.staff_user_id
            AND delivery.delivery_status IN (
              'DRIVER_ASSIGNED',
              'READY_FOR_PICKUP',
              'PICKED_UP',
              'ON_THE_WAY'
            )
        WHERE
          driver.approved = TRUE
          AND driver.availability_status =
            'ONLINE'
          AND (
            driver.home_workspace = 'ONLINE'
            OR driver.home_workspace = $1
          )
        GROUP BY
          driver.staff_user_id,
          driver.max_active_deliveries
        HAVING
          COUNT(delivery.id) <
            driver.max_active_deliveries
        ORDER BY
          COUNT(delivery.id) ASC,
          driver.staff_user_id ASC
        LIMIT 1
      `,
      [
        workspace,
      ]
    );

  const available =
    Boolean(result.rows[0]);

  return {
    available,
    status: available
      ? "AVAILABLE"
      : "NO_DRIVER_CAPACITY",
    workspace,
    estimatedMinutes: available
      ? 35
      : null,
    capacity: available
      ? "AVAILABLE"
      : "UNAVAILABLE",
  };
}
