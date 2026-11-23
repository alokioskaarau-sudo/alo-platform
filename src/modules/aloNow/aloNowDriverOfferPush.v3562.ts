
// V3562_DRIVER_PUSH
// Only eligible, recently online drivers receive this notification.
// No customer address, status token or payment information in payload.

import {db} from "../../database/db.js";

export async function sendAloNowDriverOfferPushV3562(
  requestId: string,
  workspace: string
): Promise<{recipients:number; accepted:number; errors:number}> {
  const result = await db.query<{expo_push_token:string}>(`
    SELECT DISTINCT p.expo_push_token
    FROM public.staff_push_tokens p
    JOIN public.alo_driver_profiles d
      ON d.staff_user_id::text = p.staff_user_id::text
    WHERE p.active = TRUE
      AND d.approved = TRUE
      AND d.availability_status = 'ONLINE'
      AND d.last_seen_at > NOW() - INTERVAL '3 minutes'
      AND (d.home_workspace = 'ONLINE' OR d.home_workspace = $1)
      AND EXISTS (
        SELECT 1 FROM public.alo_now_order_requests r
        WHERE r.id = $2
          AND r.workspace = $1
          AND r.status = 'DRIVER_OFFERED'
          AND r.quote_status = 'MANUAL_APPROVAL'
      )
  `, [workspace, requestId]);

  const tokens = result.rows
    .map(r => r.expo_push_token)
    .filter(t => /^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(t));

  let accepted = 0;
  let errors = 0;

  for (let i = 0; i < tokens.length; i += 100) {
    const messages = tokens.slice(i, i + 100).map(to => ({
      to,
      title: "ALO NOW · Neuer Lieferauftrag",
      body: "Ein neuer Auftrag ist verfügbar. Jetzt in ALO NOW ansehen.",
      sound: "default",
      priority: "high",
      channelId: "orders",
      data: {
        type: "ALO_NOW_DRIVER_OFFER",
        screen: "alo-now",
        requestId
      }
    }));

    const response = await fetch(
      "https://exp.host/--/api/v2/push/send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!response.ok) {
      throw new Error("EXPO_DRIVER_PUSH_HTTP_" + response.status);
    }

    const payload = await response.json() as {
      data?: Array<{status?:string}>;
    };

    const tickets = Array.isArray(payload.data)
      ? payload.data
      : [];

    accepted += tickets.filter(x => x.status === "ok").length;
    errors += messages.length -
      tickets.filter(x => x.status === "ok").length;
  }

  return {
    recipients: tokens.length,
    accepted,
    errors
  };
}
