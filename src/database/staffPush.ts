import {
  db,
} from "./db.js";

export type StaffPushPlatform =
  | "ios"
  | "android";

export async function registerStaffPushToken(
  input: {
    staffUserId: string;
    staffSessionId: string;
    expoPushToken: string;
    platform: StaffPushPlatform;
    deviceName?: string | null;
  }
) {
  const token =
    input.expoPushToken.trim();

  if (
    !token.startsWith("ExponentPushToken[") &&
    !token.startsWith("ExpoPushToken[")
  ) {
    throw new Error(
      "Ungültiger Expo Push Token."
    );
  }

  const result =
    await db.query(
      `
        INSERT INTO staff_push_tokens (
          staff_user_id,
          staff_session_id,
          expo_push_token,
          platform,
          device_name,
          active,
          last_registered_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          TRUE,
          NOW()
        )
        ON CONFLICT (expo_push_token)
        DO UPDATE SET
          staff_user_id =
            EXCLUDED.staff_user_id,
          staff_session_id =
            EXCLUDED.staff_session_id,
          platform =
            EXCLUDED.platform,
          device_name =
            EXCLUDED.device_name,
          active = TRUE,
          last_registered_at = NOW(),
          disabled_at = NULL,
          updated_at = NOW()
        RETURNING *
      `,
      [
        input.staffUserId,
        input.staffSessionId,
        token,
        input.platform,
        input.deviceName ?? null,
      ]
    );

  return result.rows[0];
}

export async function deactivateStaffPushToken(
  input: {
    staffUserId: string;
    expoPushToken: string;
  }
) {
  await db.query(
    `
      UPDATE staff_push_tokens
      SET
        active = FALSE,
        disabled_at = NOW(),
        updated_at = NOW()
      WHERE
        staff_user_id = $1
        AND expo_push_token = $2
    `,
    [
      input.staffUserId,
      input.expoPushToken.trim(),
    ]
  );
}

export async function deactivatePushTokensForSession(
  staffSessionId: string
) {
  await db.query(
    `
      UPDATE staff_push_tokens
      SET
        active = FALSE,
        disabled_at = NOW(),
        updated_at = NOW()
      WHERE
        staff_session_id = $1
        AND active = TRUE
    `,
    [staffSessionId]
  );
}

export async function getActiveStaffPushTokens() {
  const result =
    await db.query(
      `
        SELECT
          id,
          staff_user_id,
          staff_session_id,
          expo_push_token,
          platform,
          device_name
        FROM staff_push_tokens
        WHERE active = TRUE
        ORDER BY id ASC
      `
    );

  return result.rows;
}

export async function claimStaffPushEvent(
  eventKey: string,
  eventType: string,
  shopifyOrderId: string | null
): Promise<boolean> {
  const result =
    await db.query(
      `
        INSERT INTO staff_push_events (
          event_key,
          event_type,
          shopify_order_id,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          'PENDING'
        )
        ON CONFLICT (event_key)
        DO UPDATE SET
          status = 'PENDING',
          error_message = NULL,
          updated_at = NOW()
        WHERE
          staff_push_events.status = 'FAILED'
          AND staff_push_events.error_message =
            'NO_ACTIVE_PUSH_TOKENS'
        RETURNING id
      `,
      [
        eventKey,
        eventType,
        shopifyOrderId,
      ]
    );

  return result.rowCount === 1;
}

export async function markStaffPushEventSent(
  eventKey: string
) {
  await db.query(
    `
      UPDATE staff_push_events
      SET
        status = 'SENT',
        sent_at = NOW(),
        error_message = NULL,
        updated_at = NOW()
      WHERE event_key = $1
    `,
    [eventKey]
  );
}

export async function markStaffPushEventFailed(
  eventKey: string,
  errorMessage: string
) {
  await db.query(
    `
      UPDATE staff_push_events
      SET
        status = 'FAILED',
        error_message = $2,
        updated_at = NOW()
      WHERE event_key = $1
    `,
    [
      eventKey,
      errorMessage.slice(0, 2000),
    ]
  );
}


// ALO_NOW_ELIGIBLE_PUSH_V1
export async function getEligibleAloNowPushTokens(
  shopifyOrderId: string
) {
  const result = await db.query(
    `
      SELECT DISTINCT
        token.expo_push_token
      FROM staff_push_tokens token
      INNER JOIN alo_driver_profiles driver
        ON driver.staff_user_id = token.staff_user_id
      INNER JOIN alo_now_deliveries delivery
        ON delivery.shopify_order_id = $1
      WHERE
        token.active = TRUE
        AND driver.approved = TRUE
        AND driver.availability_status = 'ONLINE'
        AND driver.last_seen_at >=
          NOW() - INTERVAL '30 minutes'
        AND delivery.delivery_status =
          'WAITING_FOR_DRIVER'
        AND delivery.assigned_driver_user_id IS NULL
        AND (
          driver.home_workspace = 'ONLINE'
          OR driver.home_workspace =
            delivery.fulfillment_workspace
        )
        AND (
          SELECT COUNT(*)::INTEGER
          FROM alo_now_deliveries active_delivery
          WHERE
            active_delivery.assigned_driver_user_id =
              driver.staff_user_id
            AND active_delivery.delivery_status IN (
              'DRIVER_ASSIGNED',
              'READY_FOR_PICKUP',
              'PICKED_UP',
              'ON_THE_WAY'
            )
        ) < driver.max_active_deliveries
      ORDER BY token.expo_push_token
    `,
    [shopifyOrderId]
  );

  return result.rows;
}
