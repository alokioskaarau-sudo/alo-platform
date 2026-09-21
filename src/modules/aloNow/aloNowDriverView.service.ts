import type {
  AloNowDelivery,
} from "../../database/aloNowDeliveries.js";
import {
  getShopifyOrderById,
} from "../../integrations/shopify/orders.js";

export type AloNowAvailableDeliveryView = {
  id: string;
  orderId: string;
  orderName: string;
  workspace: AloNowDelivery["fulfillment_workspace"];
  status: AloNowDelivery["delivery_status"];
  requiresAgeCheck: boolean;
  temperatureClass: AloNowDelivery["temperature_class"];
  servicePriority: number;
  promisedDeliveryAt: Date | null;
  estimatedDeliveryAt: Date | null;
  createdAt: Date;
};

export type AloNowDriverDeliveryItemView = {
  name: string;
  quantity: number;
  sku: string | null;
  imageUrl: string | null;
};

export type AloNowDriverAddressView = {
  firstName: string | null;
  lastName: string | null;
  address1: string | null;
  address2: string | null;
  zip: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
};

export type AloNowAssignedDeliveryView =
  AloNowAvailableDeliveryView & {
    detailsAvailable: boolean;
    recipient: AloNowDriverAddressView | null;
    items: AloNowDriverDeliveryItemView[];
    navigationAddress: string | null;
  };

export function toAloNowAvailableDeliveryView(
  delivery: AloNowDelivery
): AloNowAvailableDeliveryView {
  return {
    id: delivery.id,
    orderId: delivery.shopify_order_id,
    orderName: delivery.shopify_order_name,
    workspace: delivery.fulfillment_workspace,
    status: delivery.delivery_status,
    requiresAgeCheck: delivery.requires_age_check,
    temperatureClass: delivery.temperature_class,
    servicePriority: delivery.service_priority,
    promisedDeliveryAt: delivery.promised_delivery_at,
    estimatedDeliveryAt: delivery.estimated_delivery_at,
    createdAt: delivery.created_at,
  };
}

function cleanString(
  value: unknown
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned.length > 0
    ? cleaned
    : null;
}

export async function toAloNowAssignedDeliveryView(
  delivery: AloNowDelivery,
  staffUserId: string
): Promise<AloNowAssignedDeliveryView> {
  if (
    !delivery.assigned_driver_user_id ||
    delivery.assigned_driver_user_id !== staffUserId
  ) {
    throw new Error(
      "ALO_NOW_DRIVER_DELIVERY_ACCESS_DENIED"
    );
  }

  const base =
    toAloNowAvailableDeliveryView(delivery);

  try {
    const order =
      await getShopifyOrderById(
        delivery.shopify_order_id
      );

    if (!order) {
      return {
        ...base,
        detailsAvailable: false,
        recipient: null,
        items: [],
        navigationAddress: null,
      };
    }

    const address =
      order.shippingAddress ?? null;

    const recipient: AloNowDriverAddressView | null =
      address
        ? {
            firstName: cleanString(
              address.firstName
            ),
            lastName: cleanString(
              address.lastName
            ),
            address1: cleanString(
              address.address1
            ),
            address2: cleanString(
              address.address2
            ),
            zip: cleanString(address.zip),
            city: cleanString(address.city),
            country: cleanString(
              address.country
            ),
            phone:
              cleanString(address.phone) ??
              cleanString(order.phone),
          }
        : null;

    const navigationAddress = address
      ? [
          cleanString(address.address1),
          cleanString(address.address2),
          [
            cleanString(address.zip),
            cleanString(address.city),
          ]
            .filter(Boolean)
            .join(" "),
          cleanString(address.country),
        ]
          .filter(Boolean)
          .join(", ")
      : null;

    const items: AloNowDriverDeliveryItemView[] =
      (order.lineItems?.nodes ?? []).map(
        (lineItem: any) => ({
          name:
            cleanString(lineItem.name) ??
            "Artikel",
          quantity:
            typeof lineItem.quantity ===
            "number"
              ? lineItem.quantity
              : 0,
          sku: cleanString(lineItem.sku),
          imageUrl:
            cleanString(
              lineItem.variant?.image?.url
            ) ??
            cleanString(
              lineItem.variant?.product
                ?.featuredImage?.url
            ),
        })
      );

    return {
      ...base,
      detailsAvailable: true,
      recipient,
      items,
      navigationAddress:
        navigationAddress || null,
    };
  } catch (error) {
    console.error(
      "[ALO NOW] Driver delivery details failed",
      {
        orderId: delivery.shopify_order_id,
        error,
      }
    );

    return {
      ...base,
      detailsAvailable: false,
      recipient: null,
      items: [],
      navigationAddress: null,
    };
  }
}
