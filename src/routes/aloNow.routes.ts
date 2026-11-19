import {
  Router,
} from "express";

import {
  getStaffUser,
  requireStaffAuth,
} from "../middleware/staffAuth.js";

import {
  getAloDriverProfile,
  setAloDriverAvailability,
} from "../database/aloNowDrivers.js";
import {
  listActiveAloNowDeliveriesForDriver,
  listAvailableAloNowDeliveriesForDriver,
  setAloNowDriverDeliveryStatus,
  verifyAloNowAgeAtHandoff,
} from "../database/aloNowDeliveries.js";

import {
  claimAloNowDeliveryForDriver,
} from "../modules/aloNow/aloNowDelivery.service.js";
import {
  completeAloNowDeliveryForDriver,
} from "../modules/aloNow/aloNowCompletion.service.js";
import {
  toAloNowAssignedDeliveryView,
  toAloNowAvailableDeliveryView,
} from "../modules/aloNow/aloNowDriverView.service.js";


import {
  getAloNowAvailability,
} from "../modules/aloNow/aloNowAvailability.service.js";

const aloNowRouter =
  Router();

aloNowRouter.get(
  "/availability",
  async (req, res) => {
    try {
      const workspace =
        String(req.query.workspace ?? "AARAU")
          .trim()
          .toUpperCase();

      if (
        workspace !== "AARAU" &&
        workspace !== "OLTEN"
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_ALO_NOW_WORKSPACE",
          allowedWorkspaces: [
            "AARAU",
            "OLTEN",
          ],
        });
      }

      const requiresAgeCheckRaw =
        String(
          req.query.requiresAgeCheck ?? "false"
        )
          .trim()
          .toLowerCase();

      if (
        requiresAgeCheckRaw !== "true" &&
        requiresAgeCheckRaw !== "false"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_REQUIRES_AGE_CHECK",
        });
      }

      const requiresAgeCheck =
        requiresAgeCheckRaw === "true";

      const availability =
        await getAloNowAvailability(
          workspace,
          requiresAgeCheck
        );

      return res.json({
        ok: true,
        ...availability,
      });
    } catch (error) {
      console.error(
        "ALO NOW AVAILABILITY ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "ALO_NOW_AVAILABILITY_FAILED",
      });
    }
  }
);

aloNowRouter.get(
  "/driver/profile",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const profile =
        await getAloDriverProfile(
          staffUser.id
        );

      if (!profile) {
        return res.status(404).json({
          ok: false,
          error:
            "ALO_DRIVER_PROFILE_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        driver: {
          staffUserId:
            profile.staff_user_id,
          approved:
            profile.approved,
          availabilityStatus:
            profile.availability_status,
          workspace:
            profile.home_workspace,
          transportType:
            profile.transport_type,
          approvedForAgeRestricted:
            profile.approved_for_age_restricted,
          maxActiveDeliveries:
            profile.max_active_deliveries,
          onlineSince:
            profile.online_since,
          lastSeenAt:
            profile.last_seen_at,
        },
      });
    } catch (error) {
      console.error(
        "ALO NOW DRIVER PROFILE ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_DRIVER_PROFILE_FAILED",
      });
    }
  }
);

aloNowRouter.patch(
  "/driver/availability",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const status =
        String(
          req.body?.status ?? ""
        )
          .trim()
          .toUpperCase();

      if (
        status !== "ONLINE" &&
        status !== "OFFLINE"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_DRIVER_AVAILABILITY",
          allowedStatuses: [
            "ONLINE",
            "OFFLINE",
          ],
        });
      }

      const result =
        await setAloDriverAvailability(
          staffUser.id,
          status
        );

      if (!result.ok) {
        const httpStatus =
          result.reason ===
          "DRIVER_NOT_FOUND"
            ? 404
            : 409;

        return res.status(
          httpStatus
        ).json({
          ok: false,
          error:
            result.reason,
          driver:
            result.profile,
        });
      }

      return res.json({
        ok: true,
        driver: {
          staffUserId:
            result.profile.staff_user_id,
          approved:
            result.profile.approved,
          availabilityStatus:
            result.profile.availability_status,
          workspace:
            result.profile.home_workspace,
          transportType:
            result.profile.transport_type,
          approvedForAgeRestricted:
            result.profile.approved_for_age_restricted,
          maxActiveDeliveries:
            result.profile.max_active_deliveries,
          onlineSince:
            result.profile.online_since,
          lastSeenAt:
            result.profile.last_seen_at,
        },
      });
    } catch (error) {
      console.error(
        "ALO NOW DRIVER AVAILABILITY ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_DRIVER_AVAILABILITY_FAILED",
      });
    }
  }
);

aloNowRouter.get(
  "/deliveries/available",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const deliveries =
        await listAvailableAloNowDeliveriesForDriver(
          staffUser.id
        );

      const deliveryViews =
        deliveries.map(
          toAloNowAvailableDeliveryView
        );

      return res.json({
        ok: true,
        deliveries: deliveryViews,
        count: deliveryViews.length,
      });
    } catch (error) {
      console.error(
        "ALO NOW AVAILABLE DELIVERIES ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_NOW_AVAILABLE_DELIVERIES_FAILED",
      });
    }
  }
);

aloNowRouter.get(
  "/deliveries/mine",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const deliveries =
        await listActiveAloNowDeliveriesForDriver(
          staffUser.id
        );

      const deliveryViews =
        await Promise.all(
          deliveries.map((delivery) =>
            toAloNowAssignedDeliveryView(
              delivery,
              staffUser.id
            )
          )
        );

      return res.json({
        ok: true,
        deliveries: deliveryViews,
        count: deliveryViews.length,
      });
    } catch (error) {
      console.error(
        "ALO NOW MY DELIVERIES ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_NOW_MY_DELIVERIES_FAILED",
      });
    }
  }
);

aloNowRouter.post(
  "/deliveries/:orderId/claim",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const orderId =
        String(
          req.params.orderId ?? ""
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error:
            "SHOPIFY_ORDER_ID_REQUIRED",
        });
      }

      const result =
        await claimAloNowDeliveryForDriver(
          orderId,
          staffUser.id
        );

      if (!result.ok) {
        const httpStatus =
          result.reason ===
          "NOT_AVAILABLE"
            ? 404
            : 409;

        return res.status(
          httpStatus
        ).json({
          ok: false,
          error:
            result.reason,
          delivery:
            result.delivery,
        });
      }

      return res.json({
        ok: true,
        delivery:
          result.delivery,
        alreadyAssignedToMe:
          result.alreadyAssignedToMe,
        automaticallyReadyForPickup:
          "automaticallyReadyForPickup"
            in result
            ? result.automaticallyReadyForPickup
            : false,
      });
    } catch (error) {
      console.error(
        "ALO NOW DELIVERY CLAIM ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_NOW_DELIVERY_CLAIM_FAILED",
      });
    }
  }
);


aloNowRouter.post(
  "/deliveries/:orderId/pickup",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const orderId =
        String(
          req.params.orderId ?? ""
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error:
            "SHOPIFY_ORDER_ID_REQUIRED",
        });
      }

      const result =
        await setAloNowDriverDeliveryStatus(
          orderId,
          staffUser.id,
          "PICKED_UP"
        );

      if (!result.ok) {
        const httpStatus =
          result.reason === "NOT_FOUND"
            ? 404
            : 409;

        return res.status(
          httpStatus
        ).json({
          ok: false,
          error:
            result.reason,
          delivery:
            result.delivery,
        });
      }

      return res.json({
        ok: true,
        delivery:
          result.delivery,
        alreadyApplied:
          result.alreadyApplied,
      });
    } catch (error) {
      console.error(
        "ALO NOW DELIVERY PICKUP ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_NOW_DELIVERY_PICKUP_FAILED",
      });
    }
  }
);



aloNowRouter.post(
  "/deliveries/:orderId/start",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const orderId =
        String(
          req.params.orderId ?? ""
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error:
            "SHOPIFY_ORDER_ID_REQUIRED",
        });
      }

      const result =
        await setAloNowDriverDeliveryStatus(
          orderId,
          staffUser.id,
          "ON_THE_WAY"
        );

      if (!result.ok) {
        const httpStatus =
          result.reason === "NOT_FOUND"
            ? 404
            : 409;

        return res.status(
          httpStatus
        ).json({
          ok: false,
          error:
            result.reason,
          delivery:
            result.delivery,
        });
      }

      return res.json({
        ok: true,
        delivery:
          result.delivery,
        alreadyApplied:
          result.alreadyApplied,
      });
    } catch (error) {
      console.error(
        "ALO NOW DELIVERY START ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_NOW_DELIVERY_START_FAILED",
      });
    }
  }
);



aloNowRouter.post(
  "/deliveries/:orderId/verify-age",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const orderId =
        String(
          req.params.orderId ?? ""
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error:
            "SHOPIFY_ORDER_ID_REQUIRED",
        });
      }

      const result =
        await verifyAloNowAgeAtHandoff(
          orderId,
          staffUser.id
        );

      if (!result.ok) {
        const status =
          result.reason === "NOT_FOUND"
            ? 404
            : result.reason ===
                "NOT_ASSIGNED_TO_DRIVER"
              ? 403
              : 409;

        return res.status(status).json({
          ok: false,
          error: result.reason,
          delivery: result.delivery,
        });
      }

      return res.json({
        ok: true,
        delivery: result.delivery,
        alreadyVerified:
          result.alreadyVerified,
      });
    } catch (error) {
      console.error(
        "ALO NOW AGE VERIFY ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_NOW_AGE_VERIFY_FAILED",
      });
    }
  }
);

aloNowRouter.post(
  "/deliveries/:orderId/deliver",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const orderId =
        String(
          req.params.orderId ?? ""
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error:
            "SHOPIFY_ORDER_ID_REQUIRED",
        });
      }

      const result =
        await completeAloNowDeliveryForDriver(
          orderId,
          staffUser.id
        );

      return res.json({
        ok: true,
        delivery:
          result.delivery,
        alreadyDelivered:
          result.alreadyDelivered,
      });
    } catch (error) {
      console.error(
        "ALO NOW DELIVERY DELIVER ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ALO_NOW_DELIVERY_DELIVER_FAILED",
      });
    }
  }
);


export default aloNowRouter;

// ALO_NOW_V2896_ADMIN_ONLY_RELEASE
// ALO_NOW_ADMIN_REQUEST_LIST_V2816
// Authenticated and role-restricted merchant inbox.
// Read-only: no driver assignment, payment or delivery acceptance.
aloNowRouter.get(
  "/admin/order-requests",
  requireStaffAuth,
  async (_req, res) => {
    const staffUser = getStaffUser(res);
    const role = String(
      (staffUser as unknown as {role?: string}).role ?? ""
    ).toUpperCase();

    if (role !== "ADMIN" && role !== "MANAGER") {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN"
      });
    }

    // ALO_NOW_ADMIN_WORKSPACE_SCOPE_V2818
    const allowedWorkspaces = role === "ADMIN"
      ? ["AARAU", "OLTEN"]
      : (staffUser.allowedWorkspaces ?? []).filter(
          workspace => workspace === "AARAU" || workspace === "OLTEN"
        );

    if (allowedWorkspaces.length === 0) {
      return res.status(403).json({
        ok: false,
        error: "NO_WORKSPACE_ACCESS"
      });
    }

    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
      return res.status(503).json({
        ok: false,
        error: "ALO_NOW_REQUESTS_NOT_ENABLED"
      });
    }

    try {
      const {db} = await import("../database/db.js");

      const result = await db.query(`
        SELECT
          id,
          workspace,
          status,
          delivery_address,
          quote_status,
          road_distance_km,
          quoted_delivery_fee_chf,
          verified_subtotal_chf,
            offer.manual_offer_status,
            offer.manual_offer_expires_at,
            offer.manual_offer_version,
          created_at
        FROM alo_now_order_requests r
          LEFT JOIN LATERAL (
            SELECT
              o.status AS manual_offer_status,
              o.expires_at AS manual_offer_expires_at,
              o.version AS manual_offer_version
            FROM alo_now_manual_offers o
            WHERE o.request_id = r.id
            ORDER BY o.version DESC
            LIMIT 1
          ) offer ON TRUE
          -- ALO_NOW_V2862_ADMIN_OFFER_STATUS
        WHERE status IN (
          'PENDING_REVIEW',
          'CONTACTED'
        )
        AND workspace = ANY($1::text[])
        ORDER BY created_at DESC
        LIMIT 100
      `, [allowedWorkspaces]);

      // V2890: Display actual capacity only after the new schema has been applied.
      const capacityByRequest = new Map<string, {
        fulfillment_method:string;
        capacity_confirmed_until:Date;
        merchant_capacity_active:boolean;
      }>();
      const capacityTable = await db.query<{present:boolean}>(
        "SELECT to_regclass('public.alo_now_merchant_acceptances') IS NOT NULL AS present"
      );
      if (capacityTable.rows[0]?.present === true && result.rows.length > 0) {
        const ids = result.rows.map(row => String(row.id));
        const capacities = await db.query<{
          request_id:string;
          fulfillment_method:string;
          capacity_confirmed_until:Date;
          merchant_capacity_active:boolean;
        }>(`SELECT request_id::text AS request_id,fulfillment_method,
                    capacity_confirmed_until,
                    (capacity_confirmed_at <= clock_timestamp() AND
                     capacity_confirmed_until > clock_timestamp()) AS merchant_capacity_active
             FROM alo_now_merchant_acceptances
             WHERE request_id=ANY($1::uuid[])`, [ids]);
        for (const capacity of capacities.rows) {
          capacityByRequest.set(capacity.request_id, capacity);
        }
      }
      return res.json({
        ok: true,
        requests: result.rows.map(row => {
          const capacity = capacityByRequest.get(String(row.id));
          return {
            ...row,
            fulfillment_method: capacity?.fulfillment_method ?? null,
            capacity_confirmed_until: capacity?.capacity_confirmed_until ?? null,
            merchant_capacity_active: capacity?.merchant_capacity_active ?? false
          };
        })
      });
    } catch (error) {
      console.error(
        "ALO NOW ADMIN REQUEST LIST FAILED",
        error
      );

      return res.status(503).json({
        ok: false,
        error: "ADMIN_REQUEST_LIST_UNAVAILABLE"
      });
    }
  }
);

// ALO_NOW_V2890_INTERNAL_DELIVERY_CAPACITY_ROUTE
// Merchant capacity reservation only. Never dispatches, charges, or creates orders.
aloNowRouter.patch(
  "/admin/order-requests/:id/accept-delivery",
  requireStaffAuth,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const staff = getStaffUser(res);
    const role = String((staff as { role?: string }).role ?? "").toUpperCase();
    if (role !== "ADMIN" && role !== "MANAGER") {
      return res.status(403).json({ok:false,error:"FORBIDDEN"});
    }
    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true" ||
        process.env.ALO_NOW_INTERNAL_CAPACITY_ENABLED !== "true") {
      return res.status(503).json({ok:false,error:"CAPACITY_NOT_ENABLED"});
    }
    const requestId = String(req.params.id ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ||
        req.body?.method !== "INTERNAL_DELIVERY" ||
        req.body?.capacityMinutes !== 15) {
      return res.status(400).json({ok:false,error:"INVALID_CAPACITY_REQUEST"});
    }
    const identity = staff as {id:string|number;allowedWorkspaces?:string[]};
    const workspaces = role === "ADMIN" ? ["AARAU", "OLTEN"] :
      (identity.allowedWorkspaces ?? []).filter(w => w === "AARAU" || w === "OLTEN");
    if (workspaces.length === 0) {
      return res.status(403).json({ok:false,error:"NO_WORKSPACE_ACCESS"});
    }
    const {db} = await import("../database/db.js");
    const client = await db.connect();
    let transaction = false;
    try {
      await client.query("BEGIN");
      transaction = true;
      const table = await client.query<{present:boolean}>(
        "SELECT to_regclass('public.alo_now_merchant_acceptances') IS NOT NULL AS present"
      );
      if (table.rows[0]?.present !== true) {
        await client.query("ROLLBACK"); transaction = false;
        return res.status(503).json({ok:false,error:"CAPACITY_SCHEMA_NOT_READY"});
      }
      const request = await client.query<{
        id:string; status:string; quote_status:string; driver_user_id:string|null;
        reservation_expires_at:Date|null;
      }>(`SELECT id,status,quote_status,driver_user_id,reservation_expires_at
          FROM alo_now_order_requests WHERE id=$1 AND workspace=ANY($2::text[])
          FOR UPDATE`, [requestId, workspaces]);
      const item = request.rows[0];
      if (!item) {
        await client.query("ROLLBACK"); transaction = false;
        return res.status(404).json({ok:false,error:"REQUEST_NOT_FOUND"});
      }
      if (!["PENDING_REVIEW","CONTACTED"].includes(item.status) ||
          item.quote_status !== "MANUAL_APPROVAL" ||
          item.driver_user_id !== null) {
        await client.query("ROLLBACK"); transaction = false;
        return res.status(409).json({ok:false,error:"REQUEST_NOT_ELIGIBLE"});
      }
      const previous = await client.query<{assigned_driver_id:string|null}>(
        "SELECT assigned_driver_id FROM alo_now_merchant_acceptances WHERE request_id=$1 FOR UPDATE",
        [requestId]
      );
      if (previous.rows[0]?.assigned_driver_id != null) {
        await client.query("ROLLBACK"); transaction = false;
        return res.status(409).json({ok:false,error:"DRIVER_ALREADY_ASSIGNED"});
      }
      const result = await client.query<{capacity_confirmed_until:Date}>(`
        INSERT INTO alo_now_merchant_acceptances
          (request_id, fulfillment_method, assigned_driver_id, accepted_by,
           capacity_confirmed_at, capacity_confirmed_until)
        VALUES ($1,'INTERNAL_DELIVERY',NULL,$2,clock_timestamp(),
                clock_timestamp()+INTERVAL '15 minutes')
        ON CONFLICT (request_id) DO UPDATE
          SET fulfillment_method='INTERNAL_DELIVERY',assigned_driver_id=NULL,
              accepted_by=EXCLUDED.accepted_by,
              capacity_confirmed_at=EXCLUDED.capacity_confirmed_at,
              capacity_confirmed_until=EXCLUDED.capacity_confirmed_until
        WHERE alo_now_merchant_acceptances.assigned_driver_id IS NULL
        RETURNING capacity_confirmed_until`, [requestId,String(identity.id)]);
      if (result.rowCount !== 1) {
        await client.query("ROLLBACK"); transaction = false;
        return res.status(409).json({ok:false,error:"CAPACITY_CONFLICT"});
      }
      await client.query("COMMIT"); transaction = false;
      return res.json({ok:true,action:"INTERNAL_CAPACITY_CONFIRMED",
        capacityConfirmedUntil:result.rows[0].capacity_confirmed_until});
    } catch (_error) {
      if (transaction) await client.query("ROLLBACK").catch(() => undefined);
      console.error("ALO NOW V2890 CAPACITY RESERVATION FAILED");
      return res.status(503).json({ok:false,error:"CAPACITY_UNAVAILABLE"});
    } finally {
      client.release();
    }
  }
);

// ALO_NOW_V2849_ADMIN_MANUAL_OFFER_ROUTE
// Disabled by default. No payment or Shopify order creation.
aloNowRouter.post(
  "/admin/order-requests/:id/manual-offer",
  requireStaffAuth,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    const user = getStaffUser(res);
    const role = String(
      (user as { role?: string }).role ?? ""
    ).toUpperCase();

    if (role !== "ADMIN" && role !== "MANAGER") {
      return res.status(403).json({
        ok: false,
        error: "ADMIN_REQUIRED"
      });
    }

    if (
      process.env.ALO_NOW_REQUESTS_ENABLED !== "true" ||
      process.env.ALO_NOW_MANUAL_OFFERS_ENABLED !== "true"
    ) {
      return res.status(503).json({
        ok: false,
        error: "MANUAL_OFFERS_NOT_ENABLED"
      });
    }

    const body = req.body ?? {};

    if (
      typeof body.deliveryFeeCHF !== "string" ||
      typeof body.extraFeeCHF !== "string" ||
      (body.extraReason != null &&
       typeof body.extraReason !== "string")
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_OFFER_INPUT"
      });
    }

    const identity = user as {
      id: string | number;
      defaultWorkspace?: string | null;
      allowedWorkspaces?: string[];
    };

    // ALO_NOW_V2862_SCOPE_MATCH_ADMIN_INBOX
    const allowedWorkspaces = role === "ADMIN"
      ? ["AARAU", "OLTEN"]
      : (identity.allowedWorkspaces ?? []).filter(
          workspace =>
            workspace === "AARAU" || workspace === "OLTEN"
        );

    try {
      const { createAloNowManualOfferV2848 } =
        await import(
          "../modules/aloNow/aloNowManualOfferService.v2848.js"
        );

      const result = await createAloNowManualOfferV2848({
        requestId: String(req.params.id ?? ""),
        staffUserId: String(identity.id),
        allowedWorkspaces,
        deliveryFeeCHF: body.deliveryFeeCHF,
        extraFeeCHF: body.extraFeeCHF,
        extraReason: body.extraReason ?? null
      });

      return res.status(201).json(result);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "UNKNOWN";

      const badInput = new Set([
        "INVALID_OFFER_IDENTITY",
        "INVALID_CHF_AMOUNT",
        "INVALID_CHF_TOTAL",
        "SUBTOTAL_OUT_OF_RANGE",
        "FEE_OUT_OF_RANGE",
          "DELIVERY_FEE_BELOW_MINIMUM",
          "INVALID_VERIFIED_SUBTOTAL",
        "EXTRA_REASON_TOO_LONG",
        "EXTRA_REASON_REQUIRED",
        "TOTAL_OVERFLOW"
      ]);

      if (badInput.has(reason)) {
        return res.status(400).json({
          ok: false,
          error: reason
        });
      }

      if (
        reason === "REQUEST_NOT_ELIGIBLE" ||
        reason === "ACTIVE_OFFER_ALREADY_EXISTS"
      ) {
        return res.status(409).json({
          ok: false,
          error: reason
        });
      }

      if (
        reason === "REQUEST_NOT_FOUND" ||
        reason === "WORKSPACE_NOT_ALLOWED"
      ) {
        return res.status(404).json({
          ok: false,
          error: "REQUEST_NOT_FOUND"
        });
      }

      console.error(
        "ALO NOW MANUAL OFFER FAILURE",
        reason === "UNKNOWN" ? "UNKNOWN" : "SERVER_ERROR"
      );

      return res.status(503).json({
        ok: false,
        error: "MANUAL_OFFER_UNAVAILABLE"
      });
    }
  }
);
