// ALO_DOOR_V1589_PUSH_SERVICE
// Separate channel. Existing order and ALO NOW push remain unchanged.
import { db } from "../../database/db.js";

type DoorLocation = "AARAU" | "OLTEN";

export async function sendAloDoorRingPushV1589(
  location: DoorLocation,
  eventId: string
): Promise<{ recipients: number; accepted: number }> {
  if (
    !/^[1-9]\d*$/.test(eventId) ||
    (location !== "AARAU" && location !== "OLTEN")
  ) {
    throw new Error("ALO_DOOR_INVALID_PUSH_EVENT");
  }

  // Only employees authorised for this location.
  // Active, unrevoked, unexpired sessions are mandatory.
  const result = await db.query<{
    expo_push_token: string;
  }>(
    `
      SELECT DISTINCT token.expo_push_token
      FROM staff_push_tokens token
      JOIN staff_sessions session
        ON session.id = token.staff_session_id
       AND session.staff_user_id = token.staff_user_id
      JOIN staff_users staff
        ON staff.id = token.staff_user_id
      WHERE token.active = TRUE
        AND session.revoked_at IS NULL
        AND session.expires_at > NOW()
        AND staff.active = TRUE
        AND (
          staff.role = 'ADMIN'
          OR (
            jsonb_typeof(staff.allowed_workspaces) = 'array'
            AND staff.allowed_workspaces @> jsonb_build_array($1::text)
          )
        )
      ORDER BY token.expo_push_token
    `,
    [location]
  );

  const tokens = result.rows
    .map(row => row.expo_push_token)
    .filter(
      token =>
        token.startsWith("ExpoPushToken[") ||
        token.startsWith("ExponentPushToken[")
    );

  if (tokens.length === 0) {
    console.warn("ALO DOOR: No eligible push devices", {
      location,
      eventId
    });

    return { recipients: 0, accepted: 0 };
  }

  const label = location === "AARAU" ? "Aarau" : "Olten";

  const messages = tokens.map(to => ({
    to,
    sound: "default",
    title: `🔔 ALO DOOR · ${label}`,
    body: "Jemand klingelt am Kiosk-Eingang. Jetzt reagieren.",
    priority: "high",
    channelId: "orders",
    data: {
      type: "ALO_DOOR_RING",
      screen: "alo-door",
      location,
      eventId
    }
  }));

  // Bounded delivery attempt: do not block the QR customer indefinitely.
  const response = await fetch(
    "https://exp.host/--/api/v2/push/send",
    {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(5000)
    }
  );

  if (!response.ok) {
    throw new Error(`ALO_DOOR_EXPO_HTTP_${response.status}`);
  }

  const payload: unknown = await response.json();
  const tickets = (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    Array.isArray(payload.data)
  ) ? payload.data : [];

  const accepted = tickets.filter(
    (ticket: any) =>
      ticket?.status === "ok" &&
      typeof ticket?.id === "string"
  ).length;

  if (
    tickets.length !== messages.length ||
    accepted !== messages.length
  ) {
    console.warn("ALO DOOR: Expo partial acceptance", {
      location,
      eventId,
      accepted,
      recipients: messages.length
    });
  }

  return {
    recipients: messages.length,
    accepted
  };
}
