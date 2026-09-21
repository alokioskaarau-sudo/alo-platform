import { db } from "./db.js";

export type AloDriverAvailabilityStatus =
  | "OFFLINE"
  | "ONLINE";

export type AloDriverTransportType =
  | "CAR"
  | "SCOOTER"
  | "BIKE"
  | "OTHER";

export type AloDriverProfile = {
  staff_user_id: string;
  approved: boolean;
  availability_status: AloDriverAvailabilityStatus;
  home_workspace: "AARAU" | "OLTEN" | "ONLINE";
  transport_type: AloDriverTransportType | null;
  approved_for_age_restricted: boolean;
  max_active_deliveries: number;
  online_since: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function getAloDriverProfile(
  staffUserId: string
): Promise<AloDriverProfile | null> {
  const result =
    await db.query<AloDriverProfile>(
      `
        SELECT
          staff_user_id,
          approved,
          availability_status,
          home_workspace,
          transport_type,
          approved_for_age_restricted,
          max_active_deliveries,
          online_since,
          last_seen_at,
          created_at,
          updated_at
        FROM alo_driver_profiles
        WHERE staff_user_id = $1
        LIMIT 1
      `,
      [staffUserId]
    );

  return result.rows[0] ?? null;
}

export async function isAloDriverAvailable(
  staffUserId: string,
  requiresAgeCheck = false
): Promise<boolean> {
  const result =
    await db.query(
      `
        SELECT 1
        FROM alo_driver_profiles driver
        WHERE
          driver.staff_user_id = $1
          AND driver.approved = TRUE
          AND driver.availability_status =
            'ONLINE'
          AND (
            $2 = FALSE
            OR driver.approved_for_age_restricted =
              TRUE
          )
          AND (
            SELECT COUNT(*)::INTEGER
            FROM alo_now_deliveries delivery
            WHERE
              delivery.assigned_driver_user_id =
                driver.staff_user_id
              AND delivery.delivery_status IN (
                'DRIVER_ASSIGNED',
                'READY_FOR_PICKUP',
                'PICKED_UP',
                'ON_THE_WAY'
              )
          ) < driver.max_active_deliveries
        LIMIT 1
      `,
      [
        staffUserId,
        requiresAgeCheck,
      ]
    );

  return Boolean(result.rows[0]);
}

export type SetDriverAvailabilityResult =
  | {
      ok: true;
      profile: AloDriverProfile;
    }
  | {
      ok: false;
      reason:
        | "DRIVER_NOT_FOUND"
        | "DRIVER_NOT_APPROVED"
        | "ACTIVE_DELIVERY";
      profile: AloDriverProfile | null;
    };

export async function setAloDriverAvailability(
  staffUserId: string,
  status: "ONLINE" | "OFFLINE"
): Promise<SetDriverAvailabilityResult> {
  const client =
    await db.connect();

  try {
    await client.query("BEGIN");

    const existingResult =
      await client.query<AloDriverProfile>(
        `
          SELECT
            staff_user_id,
            approved,
            availability_status,
            home_workspace,
            transport_type,
            approved_for_age_restricted,
            max_active_deliveries,
            online_since,
            last_seen_at,
            created_at,
            updated_at
          FROM alo_driver_profiles
          WHERE staff_user_id = $1
          FOR UPDATE
        `,
        [staffUserId]
      );

    const existing =
      existingResult.rows[0];

    if (!existing) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "DRIVER_NOT_FOUND",
        profile: null,
      };
    }

    if (!existing.approved) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "DRIVER_NOT_APPROVED",
        profile: existing,
      };
    }

    if (status === "OFFLINE") {
      const activeDelivery =
        await client.query(
          `
            SELECT 1
            FROM alo_now_deliveries
            WHERE
              assigned_driver_user_id = $1
              AND delivery_status IN (
                'DRIVER_ASSIGNED',
                'READY_FOR_PICKUP',
                'PICKED_UP',
                'ON_THE_WAY'
              )
            LIMIT 1
          `,
          [staffUserId]
        );

      if (activeDelivery.rows[0]) {
        await client.query("ROLLBACK");

        return {
          ok: false,
          reason: "ACTIVE_DELIVERY",
          profile: existing,
        };
      }
    }

    const result =
      await client.query<AloDriverProfile>(
        `
          UPDATE alo_driver_profiles
          SET
            availability_status = $2,
            online_since =
              CASE
                WHEN $2 = 'ONLINE'
                  AND availability_status <> 'ONLINE'
                  THEN NOW()
                WHEN $2 = 'OFFLINE'
                  THEN NULL
                ELSE online_since
              END,
            last_seen_at = NOW(),
            updated_at = NOW()
          WHERE
            staff_user_id = $1
            AND approved = TRUE
          RETURNING
            staff_user_id,
            approved,
            availability_status,
            home_workspace,
            transport_type,
            approved_for_age_restricted,
            max_active_deliveries,
            online_since,
            last_seen_at,
            created_at,
            updated_at
        `,
        [
          staffUserId,
          status,
        ]
      );

    const updated =
      result.rows[0];

    if (!updated) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "DRIVER_NOT_APPROVED",
        profile: existing,
      };
    }

    await client.query("COMMIT");

    return {
      ok: true,
      profile: updated,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }

    throw error;
  } finally {
    client.release();
  }
}
