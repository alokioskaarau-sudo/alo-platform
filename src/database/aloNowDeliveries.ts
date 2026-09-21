import { db } from "./db.js";

export type AloNowDeliveryStatus =
  | "WAITING_FOR_DRIVER"
  | "DRIVER_ASSIGNED"
  | "READY_FOR_PICKUP"
  | "PICKED_UP"
  | "ON_THE_WAY"
  | "DELIVERED"
  | "CANCELLED";

export type AloNowWorkspace =
  | "AARAU"
  | "OLTEN"
  | "ONLINE";

export type AloNowDelivery = {
  id: string;
  shopify_order_id: string;
  shopify_order_name: string;
  fulfillment_workspace: AloNowWorkspace;
  delivery_status: AloNowDeliveryStatus;
  assigned_driver_user_id: string | null;
  requires_age_check: boolean;
  temperature_class:
    | "AMBIENT"
    | "CHILLED"
    | "FROZEN";
  service_priority: number;
  promised_delivery_at: Date | null;
  estimated_delivery_at: Date | null;
  assigned_at: Date | null;
  ready_for_pickup_at: Date | null;
  picked_up_at: Date | null;
  on_the_way_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

export async function getAloNowDelivery(
  shopifyOrderId: string
): Promise<AloNowDelivery | null> {
  const result =
    await db.query<AloNowDelivery>(
      `
        SELECT
          id,
          shopify_order_id,
          shopify_order_name,
          fulfillment_workspace,
          delivery_status,
          assigned_driver_user_id,
          requires_age_check,
          temperature_class,
          service_priority,
          promised_delivery_at,
          estimated_delivery_at,
          assigned_at,
          ready_for_pickup_at,
          picked_up_at,
          on_the_way_at,
          delivered_at,
          cancelled_at,
          version,
          created_at,
          updated_at
        FROM alo_now_deliveries
        WHERE shopify_order_id = $1
        LIMIT 1
      `,
      [shopifyOrderId]
    );

  return result.rows[0] ?? null;
}

export async function ensureAloNowDelivery(
  shopifyOrderId: string,
  shopifyOrderName: string,
  fulfillmentWorkspace: AloNowWorkspace = "ONLINE",
  requiresAgeCheck = false
): Promise<AloNowDelivery> {
  const result =
    await db.query<AloNowDelivery>(
      `
        INSERT INTO alo_now_deliveries (
          shopify_order_id,
          shopify_order_name,
          fulfillment_workspace,
          requires_age_check
        )
        VALUES (
          $1,
          $2,
          $3,
          $4
        )
        ON CONFLICT (shopify_order_id)
        DO UPDATE SET
          shopify_order_name =
            EXCLUDED.shopify_order_name,
          fulfillment_workspace =
            EXCLUDED.fulfillment_workspace,
          requires_age_check =
            alo_now_deliveries.requires_age_check
            OR EXCLUDED.requires_age_check,
          updated_at = NOW()
        RETURNING
          id,
          shopify_order_id,
          shopify_order_name,
          fulfillment_workspace,
          delivery_status,
          assigned_driver_user_id,
          requires_age_check,
          temperature_class,
          service_priority,
          promised_delivery_at,
          estimated_delivery_at,
          assigned_at,
          ready_for_pickup_at,
          picked_up_at,
          on_the_way_at,
          delivered_at,
          cancelled_at,
          version,
          created_at,
          updated_at
      `,
      [
        shopifyOrderId,
        shopifyOrderName,
        fulfillmentWorkspace,
        requiresAgeCheck,
      ]
    );

  return result.rows[0];
}

export type ClaimAloNowDeliveryResult =
  | {
      ok: true;
      delivery: AloNowDelivery;
      alreadyAssignedToMe: boolean;
    }
  | {
      ok: false;
      reason:
        | "ALREADY_ASSIGNED"
        | "DRIVER_NOT_AVAILABLE"
        | "NOT_AVAILABLE";
      delivery: AloNowDelivery | null;
    };

export async function claimAloNowDelivery(
  shopifyOrderId: string,
  staffUserId: string
): Promise<ClaimAloNowDeliveryResult> {
  const client =
    await db.connect();

  try {
    await client.query("BEGIN");

    const driverResult =
      await client.query<{
        staff_user_id: string;
        approved: boolean;
        availability_status:
          | "OFFLINE"
          | "ONLINE";
        approved_for_age_restricted: boolean;
        max_active_deliveries: number;
      }>(
        `
          SELECT
            staff_user_id,
            approved,
            availability_status,
            approved_for_age_restricted,
            max_active_deliveries
          FROM alo_driver_profiles
          WHERE staff_user_id = $1
          FOR UPDATE
        `,
        [staffUserId]
      );

    const driver =
      driverResult.rows[0];

    const deliveryResult =
      await client.query<AloNowDelivery>(
        `
          SELECT
            id,
            shopify_order_id,
            shopify_order_name,
            fulfillment_workspace,
            delivery_status,
            assigned_driver_user_id,
            requires_age_check,
            temperature_class,
            service_priority,
            promised_delivery_at,
            estimated_delivery_at,
            assigned_at,
            ready_for_pickup_at,
            picked_up_at,
            on_the_way_at,
            delivered_at,
            cancelled_at,
            version,
            created_at,
            updated_at
          FROM alo_now_deliveries
          WHERE shopify_order_id = $1
          FOR UPDATE
        `,
        [shopifyOrderId]
      );

    const delivery =
      deliveryResult.rows[0];

    if (!delivery) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "NOT_AVAILABLE",
        delivery: null,
      };
    }

    if (
      delivery.assigned_driver_user_id ===
        staffUserId &&
      (
        delivery.delivery_status ===
          "DRIVER_ASSIGNED" ||
        delivery.delivery_status ===
          "READY_FOR_PICKUP" ||
        delivery.delivery_status ===
          "PICKED_UP" ||
        delivery.delivery_status ===
          "ON_THE_WAY"
      )
    ) {
      await client.query("COMMIT");

      return {
        ok: true,
        delivery,
        alreadyAssignedToMe: true,
      };
    }

    if (
      !driver ||
      !driver.approved ||
      driver.availability_status !==
        "ONLINE" ||
      (
        delivery.requires_age_check &&
        !driver.approved_for_age_restricted
      )
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason:
          "DRIVER_NOT_AVAILABLE",
        delivery,
      };
    }

    if (
      delivery.delivery_status !==
        "WAITING_FOR_DRIVER" ||
      delivery.assigned_driver_user_id !==
        null
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "ALREADY_ASSIGNED",
        delivery,
      };
    }

    const activeResult =
      await client.query<{
        active_count: number;
      }>(
        `
          SELECT
            COUNT(*)::INTEGER AS active_count
          FROM alo_now_deliveries
          WHERE
            assigned_driver_user_id = $1
            AND delivery_status IN (
              'DRIVER_ASSIGNED',
              'READY_FOR_PICKUP',
              'PICKED_UP',
              'ON_THE_WAY'
            )
        `,
        [staffUserId]
      );

    const activeCount =
      Number(
        activeResult.rows[0]
          ?.active_count ?? 0
      );

    if (
      activeCount >=
      driver.max_active_deliveries
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason:
          "DRIVER_NOT_AVAILABLE",
        delivery,
      };
    }

    const claimResult =
      await client.query<AloNowDelivery>(
        `
          UPDATE alo_now_deliveries
          SET
            assigned_driver_user_id = $2,
            delivery_status =
              'DRIVER_ASSIGNED',
            assigned_at =
              COALESCE(
                assigned_at,
                NOW()
              ),
            version = version + 1,
            updated_at = NOW()
          WHERE
            shopify_order_id = $1
            AND delivery_status =
              'WAITING_FOR_DRIVER'
            AND assigned_driver_user_id
              IS NULL
          RETURNING
            id,
            shopify_order_id,
            shopify_order_name,
            fulfillment_workspace,
            delivery_status,
            assigned_driver_user_id,
            requires_age_check,
            temperature_class,
            service_priority,
            promised_delivery_at,
            estimated_delivery_at,
            assigned_at,
            ready_for_pickup_at,
            picked_up_at,
            on_the_way_at,
            delivered_at,
            cancelled_at,
            version,
            created_at,
            updated_at
        `,
        [
          shopifyOrderId,
          staffUserId,
        ]
      );

    const claimed =
      claimResult.rows[0];

    if (!claimed) {
      throw new Error(
        "ALO_NOW_CLAIM_FAILED_AFTER_LOCK"
      );
    }

    await client.query(
      `
        UPDATE alo_driver_profiles
        SET
          last_seen_at = NOW(),
          updated_at = NOW()
        WHERE staff_user_id = $1
      `,
      [staffUserId]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      delivery: claimed,
      alreadyAssignedToMe: false,
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

export type CompleteAloNowDeliveryResult =
  | {
      ok: true;
      delivery: AloNowDelivery;
      alreadyDelivered: boolean;
    }
  | {
      ok: false;
      reason:
        | "NOT_FOUND"
        | "NOT_ASSIGNED_TO_DRIVER"
        | "INVALID_STATUS";
      delivery: AloNowDelivery | null;
    };

export async function completeAloNowDelivery(
  shopifyOrderId: string,
  staffUserId: string
): Promise<CompleteAloNowDeliveryResult> {
  const client =
    await db.connect();

  try {
    await client.query("BEGIN");

    const deliveryResult =
      await client.query<AloNowDelivery>(
        `
          SELECT
            id,
            shopify_order_id,
            shopify_order_name,
            fulfillment_workspace,
            delivery_status,
            assigned_driver_user_id,
            requires_age_check,
            temperature_class,
            service_priority,
            promised_delivery_at,
            estimated_delivery_at,
            assigned_at,
            ready_for_pickup_at,
            picked_up_at,
            on_the_way_at,
            delivered_at,
            cancelled_at,
            version,
            created_at,
            updated_at
          FROM alo_now_deliveries
          WHERE shopify_order_id = $1
          FOR UPDATE
        `,
        [shopifyOrderId]
      );

    const delivery =
      deliveryResult.rows[0];

    if (!delivery) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "NOT_FOUND",
        delivery: null,
      };
    }

    if (
      delivery.assigned_driver_user_id !==
      staffUserId
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason:
          "NOT_ASSIGNED_TO_DRIVER",
        delivery,
      };
    }

    if (
      delivery.delivery_status ===
      "DELIVERED"
    ) {
      await client.query("COMMIT");

      return {
        ok: true,
        delivery,
        alreadyDelivered: true,
      };
    }

    if (
      delivery.delivery_status !==
      "ON_THE_WAY"
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "INVALID_STATUS",
        delivery,
      };
    }

    const completedResult =
      await client.query<AloNowDelivery>(
        `
          UPDATE alo_now_deliveries
          SET
            delivery_status =
              'DELIVERED',
            delivered_at =
              COALESCE(
                delivered_at,
                NOW()
              ),
            version = version + 1,
            updated_at = NOW()
          WHERE
            shopify_order_id = $1
            AND assigned_driver_user_id = $2
            AND delivery_status =
              'ON_THE_WAY'
          RETURNING
            id,
            shopify_order_id,
            shopify_order_name,
            fulfillment_workspace,
            delivery_status,
            assigned_driver_user_id,
            requires_age_check,
            temperature_class,
            service_priority,
            promised_delivery_at,
            estimated_delivery_at,
            assigned_at,
            ready_for_pickup_at,
            picked_up_at,
            on_the_way_at,
            delivered_at,
            cancelled_at,
            version,
            created_at,
            updated_at
        `,
        [
          shopifyOrderId,
          staffUserId,
        ]
      );

    const completed =
      completedResult.rows[0];

    if (!completed) {
      throw new Error(
        "ALO_NOW_COMPLETE_FAILED_AFTER_LOCK"
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      delivery: completed,
      alreadyDelivered: false,
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

export type DriverDeliveryTransitionStatus =
  | "PICKED_UP"
  | "ON_THE_WAY";

export type DriverDeliveryTransitionResult =
  | {
      ok: true;
      delivery: AloNowDelivery;
      alreadyApplied: boolean;
    }
  | {
      ok: false;
      reason:
        | "NOT_FOUND"
        | "NOT_ASSIGNED_TO_DRIVER"
        | "INVALID_STATUS";
      delivery: AloNowDelivery | null;
    };

export async function setAloNowDriverDeliveryStatus(
  shopifyOrderId: string,
  staffUserId: string,
  targetStatus: DriverDeliveryTransitionStatus
): Promise<DriverDeliveryTransitionResult> {
  const expectedCurrentStatus =
    targetStatus === "PICKED_UP"
      ? "READY_FOR_PICKUP"
      : "PICKED_UP";

  const timestampColumn =
    targetStatus === "PICKED_UP"
      ? "picked_up_at"
      : "on_the_way_at";

  const client =
    await db.connect();

  try {
    await client.query("BEGIN");

    const deliveryResult =
      await client.query<AloNowDelivery>(
        `
          SELECT
            id,
            shopify_order_id,
            shopify_order_name,
            fulfillment_workspace,
            delivery_status,
            assigned_driver_user_id,
            requires_age_check,
            temperature_class,
            service_priority,
            promised_delivery_at,
            estimated_delivery_at,
            assigned_at,
            ready_for_pickup_at,
            picked_up_at,
            on_the_way_at,
            delivered_at,
            cancelled_at,
            version,
            created_at,
            updated_at
          FROM alo_now_deliveries
          WHERE shopify_order_id = $1
          FOR UPDATE
        `,
        [shopifyOrderId]
      );

    const delivery =
      deliveryResult.rows[0];

    if (!delivery) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "NOT_FOUND",
        delivery: null,
      };
    }

    if (
      delivery.assigned_driver_user_id !==
      staffUserId
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason:
          "NOT_ASSIGNED_TO_DRIVER",
        delivery,
      };
    }

    if (
      delivery.delivery_status ===
      targetStatus
    ) {
      await client.query("COMMIT");

      return {
        ok: true,
        delivery,
        alreadyApplied: true,
      };
    }

    if (
      delivery.delivery_status !==
      expectedCurrentStatus
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "INVALID_STATUS",
        delivery,
      };
    }

    const result =
      await client.query<AloNowDelivery>(
        `
          UPDATE alo_now_deliveries
          SET
            delivery_status = $3,
            ${timestampColumn} =
              COALESCE(
                ${timestampColumn},
                NOW()
              ),
            version = version + 1,
            updated_at = NOW()
          WHERE
            shopify_order_id = $1
            AND assigned_driver_user_id = $2
            AND delivery_status = $4
          RETURNING
            id,
            shopify_order_id,
            shopify_order_name,
            fulfillment_workspace,
            delivery_status,
            assigned_driver_user_id,
            requires_age_check,
            temperature_class,
            service_priority,
            promised_delivery_at,
            estimated_delivery_at,
            assigned_at,
            ready_for_pickup_at,
            picked_up_at,
            on_the_way_at,
            delivered_at,
            cancelled_at,
            version,
            created_at,
            updated_at
        `,
        [
          shopifyOrderId,
          staffUserId,
          targetStatus,
          expectedCurrentStatus,
        ]
      );

    const updated =
      result.rows[0];

    if (!updated) {
      throw new Error(
        "ALO_NOW_DRIVER_TRANSITION_FAILED_AFTER_LOCK"
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      delivery: updated,
      alreadyApplied: false,
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

export type MarkAloNowReadyForPickupResult =
  | {
      ok: true;
      delivery: AloNowDelivery;
      alreadyReady: boolean;
    }
  | {
      ok: false;
      reason:
        | "NOT_FOUND"
        | "NO_DRIVER_ASSIGNED"
        | "INVALID_STATUS";
      delivery: AloNowDelivery | null;
    };

export async function markAloNowReadyForPickup(
  shopifyOrderId: string
): Promise<MarkAloNowReadyForPickupResult> {
  const client =
    await db.connect();

  try {
    await client.query("BEGIN");

    const deliveryResult =
      await client.query<AloNowDelivery>(
        `
          SELECT
            id,
            shopify_order_id,
            shopify_order_name,
            fulfillment_workspace,
            delivery_status,
            assigned_driver_user_id,
            requires_age_check,
            temperature_class,
            service_priority,
            promised_delivery_at,
            estimated_delivery_at,
            assigned_at,
            ready_for_pickup_at,
            picked_up_at,
            on_the_way_at,
            delivered_at,
            cancelled_at,
            version,
            created_at,
            updated_at
          FROM alo_now_deliveries
          WHERE shopify_order_id = $1
          FOR UPDATE
        `,
        [shopifyOrderId]
      );

    const delivery =
      deliveryResult.rows[0];

    if (!delivery) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "NOT_FOUND",
        delivery: null,
      };
    }

    if (
      delivery.delivery_status ===
        "READY_FOR_PICKUP" ||
      delivery.delivery_status ===
        "PICKED_UP" ||
      delivery.delivery_status ===
        "ON_THE_WAY" ||
      delivery.delivery_status ===
        "DELIVERED"
    ) {
      await client.query("COMMIT");

      return {
        ok: true,
        delivery,
        alreadyReady: true,
      };
    }

    if (
      !delivery.assigned_driver_user_id
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "NO_DRIVER_ASSIGNED",
        delivery,
      };
    }

    if (
      delivery.delivery_status !==
      "DRIVER_ASSIGNED"
    ) {
      await client.query("ROLLBACK");

      return {
        ok: false,
        reason: "INVALID_STATUS",
        delivery,
      };
    }

    const result =
      await client.query<AloNowDelivery>(
        `
          UPDATE alo_now_deliveries
          SET
            delivery_status =
              'READY_FOR_PICKUP',
            ready_for_pickup_at =
              COALESCE(
                ready_for_pickup_at,
                NOW()
              ),
            version = version + 1,
            updated_at = NOW()
          WHERE
            shopify_order_id = $1
            AND delivery_status =
              'DRIVER_ASSIGNED'
            AND assigned_driver_user_id
              IS NOT NULL
          RETURNING
            id,
            shopify_order_id,
            shopify_order_name,
            fulfillment_workspace,
            delivery_status,
            assigned_driver_user_id,
            requires_age_check,
            temperature_class,
            service_priority,
            promised_delivery_at,
            estimated_delivery_at,
            assigned_at,
            ready_for_pickup_at,
            picked_up_at,
            on_the_way_at,
            delivered_at,
            cancelled_at,
            version,
            created_at,
            updated_at
        `,
        [shopifyOrderId]
      );

    const updated =
      result.rows[0];

    if (!updated) {
      throw new Error(
        "ALO_NOW_READY_FOR_PICKUP_FAILED_AFTER_LOCK"
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      delivery: updated,
      alreadyReady: false,
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
