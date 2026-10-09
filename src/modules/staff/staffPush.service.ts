import {
  claimStaffPushEvent,
  getActiveStaffPushTokens,
  markStaffPushEventFailed,
  markStaffPushEventSent,
} from "../../database/staffPush.js";

// ALO_CHANNEL_PUSH_V1
type StaffPushChannel =
  | "SHIPPING"
  | "ALO_NOW"
  | "PICKUP";

type NewOrderPushInput = {
  channel?: StaffPushChannel;
  orderId: string;
  orderName: string;
  totalAmount?: string | null;
  currency?: string | null;
};

function moneyText(
  amount?: string | null,
  currency?: string | null
) {
  if (!amount) {
    return "";
  }

  const cleanCurrency =
    String(currency ?? "CHF")
      .trim()
      .toUpperCase();

  return ` · ${cleanCurrency} ${amount}`;
}

export async function sendNewOrderStaffPush(
  input: NewOrderPushInput
) {
  const eventKey =
    `NEW_PAID_ORDER:${input.orderId}`;

  const claimed =
    await claimStaffPushEvent(
      eventKey,
      "NEW_PAID_ORDER",
      input.orderId
    );

  if (!claimed) {
    return {
      sent: false,
      duplicate: true,
      recipients: 0,
    };
  }

  try {
    const tokens =
      await getActiveStaffPushTokens();

    if (tokens.length === 0) {
      await markStaffPushEventFailed(
        eventKey,
        "NO_ACTIVE_PUSH_TOKENS"
      );

      return {
        sent: false,
        duplicate: false,
        recipients: 0,
      };
    }

    const channel = input.channel ?? "SHIPPING";

    const title =
      channel === "ALO_NOW"
        ? "Neue ALO NOW Lieferung"
        : channel === "PICKUP"
          ? "Neue Abholung"
          : "Neue Onlinebestellung";

    const messages =
      tokens.map((token: any) => ({
        to: token.expo_push_token,
        sound: "default",
        // ALO_NOW_PUSH_CATEGORY_V1
        ...(channel === "ALO_NOW"
          ? { categoryId: "ALO_NOW_DELIVERY" }
          : {}),
        title,
        body:
          `${input.orderName}` +
          moneyText(
            input.totalAmount,
            input.currency
          ),
        data: {
          type: "NEW_ORDER",
          channel,
          orderId: input.orderId,
          orderName: input.orderName,
          screen:
            channel === "ALO_NOW"
              ? "alo-now"
              : "order",
        },
        priority: "high",
        channelId: "orders",
      }));

    const response =
      await fetch(
        "https://exp.host/--/api/v2/push/send",
        {
          method: "POST",
          headers: {
            Accept:
              "application/json",
            "Accept-Encoding":
              "gzip, deflate",
            "Content-Type":
              "application/json",
          },
          body:
            JSON.stringify(messages),
        }
      );

    const responseText =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `Expo Push ${response.status}: ${responseText}`
      );
    }

    let payload: any = null;

    try {
      payload =
        JSON.parse(responseText);
    } catch {
      throw new Error(
        "Expo Push Antwort ist kein JSON."
      );
    }


    // ALO_PUSH_TICKET_STATUS_V1
    const tickets: any[] = Array.isArray(payload?.data)
      ? payload.data : [];

    const accepted = tickets.filter(
      (t: any) => t?.status === "ok" && typeof t?.id === "string"
    ).length;

    const errors = tickets.filter(
      (t: any) => t?.status === "error"
    );

    if (tickets.length !== messages.length ||
        accepted !== messages.length) {
      const reason = `EXPO_PUSH_PARTIAL_FAILURE: ${accepted}/${messages.length} accepted`;
      console.error(reason, errors);
      await markStaffPushEventFailed(eventKey, reason);
      return {
        sent: false,
        duplicate: false,
        recipients: messages.length,
        accepted,
        ticketErrors: errors.length,
      };
    }

    await markStaffPushEventSent(eventKey);
    return {
      sent: true,
      duplicate: false,
      recipients: messages.length,
      accepted,
      ticketErrors: 0,
    };
  } catch (error: any) {
    await markStaffPushEventFailed(
      eventKey,
      error?.message ??
        String(error)
    );

    throw error;
  }
}
