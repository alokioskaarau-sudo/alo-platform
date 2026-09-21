import {
  claimStaffPushEvent,
  getActiveStaffPushTokens,
  markStaffPushEventFailed,
  markStaffPushEventSent,
} from "../../database/staffPush.js";

type NewOrderPushInput = {
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

    const messages =
      tokens.map((token: any) => ({
        to: token.expo_push_token,
        sound: "default",
        title: "Neue Bestellung",
        body:
          `${input.orderName}` +
          moneyText(
            input.totalAmount,
            input.currency
          ),
        data: {
          type: "NEW_ORDER",
          orderId: input.orderId,
          orderName: input.orderName,
          screen: "order",
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

    const tickets =
      Array.isArray(payload?.data)
        ? payload.data
        : [];

    const ticketErrors =
      tickets.filter(
        (ticket: any) =>
          ticket?.status === "error"
      );

    if (ticketErrors.length > 0) {
      console.error(
        "EXPO PUSH TICKET ERRORS",
        ticketErrors
      );
    }

    await markStaffPushEventSent(
      eventKey
    );

    return {
      sent: true,
      duplicate: false,
      recipients:
        messages.length,
      ticketErrors:
        ticketErrors.length,
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
