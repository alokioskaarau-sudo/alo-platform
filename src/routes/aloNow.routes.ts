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
import { heartbeatAloDriver } from "../database/aloNowDrivers.js";
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

// ALO_NOW_DRIVER_HEARTBEAT_ROUTE_V1
aloNowRouter.post(
  "/driver/heartbeat",
  requireStaffAuth,
  async (_req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const accepted = await heartbeatAloDriver(staffUser.id);

      if (!accepted) {
        return res.status(409).json({
          ok: false,
          error: "DRIVER_NOT_ONLINE_OR_NOT_APPROVED",
        });
      }

      return res.json({ ok: true });
    } catch (error) {
      console.error("ALO NOW DRIVER HEARTBEAT ERROR", error);
      return res.status(500).json({
        ok: false,
        error: "ALO_DRIVER_HEARTBEAT_FAILED",
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

// ALO_V2678_PRODUCTION_ORDER_REQUEST
// ALO KIOSK DELIVERY V115
aloNowRouter.post("/order-requests", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
    return res.status(503).json({ ok: false, error: "ALO_NOW_REQUESTS_NOT_ENABLED" });
  }
  const { randomUUID, randomBytes, createHash } = await import("node:crypto");
  // ALO_NOW_CUSTOMER_STATUS_V5: independent random customer token, never log it.
  const customerStatusToken = randomBytes(32).toString("base64url");
  const customerStatusTokenHash = createHash("sha256").update(customerStatusToken).digest("hex");
  const { db } = await import("../database/db.js");
  const body = req.body ?? {};
  const workspace = typeof body.workspace === "string" ? body.workspace.trim().toUpperCase() : "";
  const address = typeof body.address === "string" ? body.address.trim() : "";
  const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : "";
  const items = body.items;
  if (!(["AARAU", "OLTEN"].includes(workspace)) || address.length < 8 || address.length > 180 ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(clientRequestId) ||
      !Array.isArray(items) || items.length < 1 || items.length > 15 ||
      !items.every((x: unknown) => {
        if (!x || typeof x !== "object") return false;
        const item = x as Record<string, unknown>;
        return typeof item.variantId === "string" &&
          /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/.test(item.variantId) &&
          Number.isInteger(item.quantity) && Number(item.quantity) >= 1 && Number(item.quantity) <= 30 &&
          Object.keys(item).every(k => k === "variantId" || k === "quantity");
      })) {
    return res.status(400).json({ ok: false, error: "INVALID_ORDER_REQUEST" });
  }
  // A customer can request a review, not a final checkout or price commitment.
  // Until trusted Shopify variant price and age checks exist, admin cannot "accept".
  try {
    const { getVerifiedAloNowQuote } = await import("../modules/aloNow/aloNowVerifiedRouting.service.js");
    const quote = await getVerifiedAloNowQuote(address, workspace as "AARAU" | "OLTEN");
    if (!quote.ok || (quote.status !== "STANDARD" && quote.status !== "MANUAL_APPROVAL") ||
        typeof quote.roadDistanceKm !== "number" || !Number.isFinite(quote.roadDistanceKm)) {
      return res.status(422).json({ ok: false, error: "DELIVERY_ROUTE_UNVERIFIED" });
    }
    // ALO_NOW_SHOPIFY_CART_GUARD_V1: trust server-fetched price, not browser values.
    // AGE_16/18 and unreviewed products are blocked (pilot NONE only).
    const { verifyAloNowShopifyCart, AloNowCartError } =
      await import("../modules/aloNow/aloNowShopifyCartGuard.service.js");
    let verifiedCart;
    try {
      verifiedCart = await verifyAloNowShopifyCart(items);
    } catch (error) {
      if (error instanceof AloNowCartError) {
        return res.status(422).json({ ok: false, error: error.code });
      }
      console.error("ALO NOW SHOPIFY CART LOOKUP FAILED", error);
      return res.status(503).json({ ok: false, error: "SHOPIFY_VALIDATION_UNAVAILABLE" });
    }

    // V2373: Only trusted, verified STANDARD requests.
    // Explicit opt-in, OFF by default; never authorizes checkout.
    const initialRequestStatus =
      process.env.ALO_NOW_AUTO_OFFER_VERIFIED_REQUESTS_ENABLED === "true" &&
      quote.status === "STANDARD"
        ? "DRIVER_OFFERED"
        : "PENDING_REVIEW";

    const result = await db.query<{id: string; status: string; created_at: Date}>(`
      INSERT INTO alo_now_order_requests
        (id, client_request_id, workspace, delivery_address, items,
         quote_status, road_distance_km, quoted_delivery_fee_chf, verified_subtotal_chf, verified_at, customer_status_token_hash, status, offered_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,NOW(),$10,$11,CASE WHEN $11='DRIVER_OFFERED' THEN NOW() ELSE NULL END)
      ON CONFLICT (client_request_id) DO NOTHING
      RETURNING id, status, created_at
    `, [randomUUID(), clientRequestId, workspace, address,
        JSON.stringify(verifiedCart.items), quote.status, quote.roadDistanceKm,
        quote.deliveryFeeCHF, verifiedCart.subtotalCHF, customerStatusTokenHash, initialRequestStatus]);
    if (!result.rows[0]) {
      return res.status(409).json({ ok: false, error: "REQUEST_ID_ALREADY_USED" });
    }
    return res.status(202).json({ ok: true, requestId: result.rows[0].id,
      status: result.rows[0].status, checkoutAllowed: false, customerStatusToken,
      verifiedSubtotalCHF: verifiedCart.subtotalCHF, currency: "CHF",
      message: "Unverbindliche Lieferanfrage gespeichert. Keine Bestellung oder Zahlung erfolgt." });
  } catch (error) {
    console.error("ALO NOW REQUEST INTAKE FAILED", error);
    return res.status(503).json({ ok: false, error: "ORDER_REQUEST_UNAVAILABLE" });
  }
});

// ALO_V2681_DRIVER_OFFERS
async function expireAloNowUnpaidPreaccepts(): Promise<number> {
  const { db } = await import("../database/db.js");
  const result = await db.query(`
    UPDATE alo_now_order_requests
    SET status = 'PENDING_REVIEW',
        driver_user_id = NULL,
        driver_accepted_at = NULL,
        reservation_expires_at = NULL,
        updated_at = NOW()
    WHERE status = 'DRIVER_ACCEPTED'
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at <= NOW()
          -- ALO_V261_GLOBAL_PAYMENT_PROTECTION
          AND NOT EXISTS (
            SELECT 1
            FROM alo_now_payment_states payment
            WHERE payment.request_id = alo_now_order_requests.id
              AND payment.phase IN (
                'PAYMENT_CONFIRMED',
                'CASH_CONFIRMED'
              )
              OR (
                payment.request_id = alo_now_order_requests.id
                AND payment.phase = 'AWAITING_PAYMENT'
                AND NOW() < (
                  alo_now_order_requests.reservation_expires_at
                  + INTERVAL '3 minutes'
                )
              -- ALO_NOW_PAYMENT_GRACE_V2382
              )
          )
    RETURNING id
  `);
  return result.rowCount ?? 0;
}


aloNowRouter.get('/driver/order-request-offers', requireStaffAuth, async (_req,res) => {
  if (process.env.ALO_NOW_REQUESTS_ENABLED !== 'true')
    return res.status(503).json({ok:false,error:'ALO_NOW_REQUESTS_NOT_ENABLED'});
  const staff = getStaffUser(res);
  try {
    await expireAloNowUnpaidPreaccepts();
    const {db} = await import('../database/db.js');
    const data = await db.query(`
      SELECT r.id,r.workspace,r.road_distance_km,r.created_at,
             jsonb_array_length(r.items) AS line_count
      FROM alo_now_order_requests r
      JOIN alo_driver_profiles d ON d.staff_user_id=$1
      WHERE r.status='DRIVER_OFFERED' AND r.quote_status='STANDARD'
        AND d.approved=TRUE AND d.availability_status='ONLINE'
        AND d.last_seen_at > NOW() - INTERVAL '3 minutes'
        AND (d.home_workspace='ONLINE' OR d.home_workspace=r.workspace)
      ORDER BY r.created_at ASC LIMIT 30
    `,[staff.id]);
    return res.json({ok:true,offers:data.rows,checkoutAllowed:false});
  }catch(e){
    console.error('ALO NOW OFFER LIST FAILED',e);
    return res.status(503).json({ok:false,error:'OFFERS_UNAVAILABLE'});
  }
});


aloNowRouter.post('/driver/order-request-offers/:id/accept', requireStaffAuth, async (req,res) => {
  if (process.env.ALO_NOW_REQUESTS_ENABLED !== 'true')
    return res.status(503).json({ok:false,error:'ALO_NOW_REQUESTS_NOT_ENABLED'});
  const staff=getStaffUser(res);
  const id=String(req.params.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return res.status(400).json({ok:false,error:'INVALID_REQUEST_ID'});
  const {db}=await import('../database/db.js');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const driver=await client.query(`
      SELECT staff_user_id,home_workspace,max_active_deliveries,transport_type
      FROM alo_driver_profiles WHERE staff_user_id=$1
        AND approved=TRUE AND availability_status='ONLINE'
        AND last_seen_at > NOW() - INTERVAL '3 minutes'
      FOR UPDATE
    `,[staff.id]);
    if (!driver.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ok:false,error:'DRIVER_NOT_AVAILABLE'});
    }
    const driverData=driver.rows[0];
    // Clear expired, unpaid holds owned by this locked driver before evaluating capacity.
    await client.query(`
      UPDATE alo_now_order_requests
      SET status='PENDING_REVIEW', driver_user_id=NULL,
          driver_accepted_at=NULL, reservation_expires_at=NULL, updated_at=NOW()
      WHERE driver_user_id=$1 AND status='DRIVER_ACCEPTED'
        AND reservation_expires_at IS NOT NULL
        AND reservation_expires_at <= NOW()
          -- ALO_V260_PROTECT_CONFIRMED_PAYMENTS
          AND NOT EXISTS (
            SELECT 1
            FROM alo_now_payment_states payment
            WHERE payment.request_id = alo_now_order_requests.id
              AND payment.phase IN (
                'PAYMENT_CONFIRMED',
                'CASH_CONFIRMED'
              )
              OR (
                payment.request_id = alo_now_order_requests.id
                AND payment.phase = 'AWAITING_PAYMENT'
                AND NOW() < (
                  alo_now_order_requests.reservation_expires_at
                  + INTERVAL '3 minutes'
                )
              -- ALO_NOW_PAYMENT_GRACE_V2382
              )
          )
      -- ALO_NOW_RESERVATION_CONSISTENCY_V2386
    `,[staff.id]);
    // ALO_NOW_MULTI_PREACCEPT_CAPACITY_V4
    // Count UNPAID reservations + active PAID deliveries as the same capacity.
    // This query runs while the driver's profile row is FOR UPDATE locked.
    const reserved=await client.query<{ n: number }>(`
      SELECT COUNT(*)::integer AS n FROM alo_now_order_requests
      WHERE driver_user_id=$1 AND status='DRIVER_ACCEPTED'
        AND (
          reservation_expires_at > NOW()
          OR (
            reservation_expires_at + INTERVAL '3 minutes' > NOW()
            AND EXISTS (
              SELECT 1 FROM alo_now_payment_states payment
              WHERE payment.request_id = alo_now_order_requests.id
                AND payment.phase = 'AWAITING_PAYMENT'
            )
          )
        )
    `,[staff.id]);
    const active=await client.query(`
      SELECT COUNT(*)::integer AS n FROM alo_now_deliveries
      WHERE assigned_driver_user_id=$1
        AND delivery_status IN ('DRIVER_ASSIGNED','READY_FOR_PICKUP','PICKED_UP','ON_THE_WAY')
    `,[staff.id]);
    // Interim safe operational caps: scooter 2, car 4 concurrent jobs.
    // Business profile max_active_deliveries always provides a stricter limit.
    // Weight, packing volume and multi-stop ETA are NOT verified in V4.
    // OTHER/BIKE are not enabled for new ALO NOW unpaid preaccepts.
    const vehicle = String(driverData.transport_type ?? '').toUpperCase();
    const vehicleLimit = vehicle === 'SCOOTER' ? 2 : vehicle === 'CAR' ? 4 : 0;
    const configuredLimit = Number(driverData.max_active_deliveries);
    const allowedSlots = Math.min(vehicleLimit, Number.isFinite(configuredLimit) ? configuredLimit : 0);
    const occupiedSlots = Number(reserved.rows[0]?.n ?? 0) + Number(active.rows[0]?.n ?? 0);
    if (allowedSlots < 1 || occupiedSlots >= allowedSlots) {
      await client.query('ROLLBACK');
      return res.status(409).json({ok:false,error:'DRIVER_CAPACITY_UNAVAILABLE'});
    }
    const updated=await client.query(`
      UPDATE alo_now_order_requests SET
        status='DRIVER_ACCEPTED',driver_user_id=$2,
        driver_accepted_at=NOW(),reservation_expires_at=NOW()+INTERVAL '10 minutes',
        updated_at=NOW()
      WHERE id=$1 AND status='DRIVER_OFFERED' AND quote_status='STANDARD'
        AND (workspace=$3 OR $3='ONLINE')
      RETURNING id,status,workspace,reservation_expires_at
    `,[id,staff.id,driverData.home_workspace]);
    if (!updated.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ok:false,error:'OFFER_ALREADY_TAKEN_OR_NOT_AVAILABLE'});
    }
    // ALO_V257_ATOMIC_ACCEPTANCE
      if (
        updated.rows[0] &&
        process.env.ALO_NOW_ATOMIC_PAYMENT_ACCEPT_ENABLED === "true"
      ) {
        const { recordAloNowAcceptedPaymentInTransaction } =
          await import(
            "../modules/aloNow/aloNowAtomicAcceptance.js"
          );
        await recordAloNowAcceptedPaymentInTransaction(
          client,
          id,
          String(staff.id)
        );
      }

      await client.query('COMMIT');
    return res.json({ok:true,request:updated.rows[0],checkoutAllowed:false,
      message:'Fahrer reserviert fuer 10 Minuten. Noch keine Bestellung oder Zahlung.'});
  }catch(e){
    try{await client.query('ROLLBACK');}catch{}
    console.error('ALO NOW DRIVER PREACCEPT FAILED',e);
    return res.status(503).json({ok:false,error:'PREACCEPT_UNAVAILABLE'});
  }finally{client.release();}
});




// ALO_V2700_CUSTOMER_CHECKOUT_PREPARATION
// Customer-token authenticated, atomic payment+intent preparation.
// Does NOT create a Shopify checkout, draft order, or paid delivery.
aloNowRouter.post('/order-requests/:id/prepare-online-payment', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.ALO_NOW_CHECKOUT_PREPARE_ENABLED !== 'true' ||
      process.env.ALO_NOW_REQUESTS_ENABLED !== 'true') {
    return res.status(503).json({ ok: false, error: 'CHECKOUT_PREPARATION_DISABLED' });
  }

  const id = String(req.params.id ?? '');
  const token = req.body?.customerStatusToken;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
      typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return res.status(400).json({ ok: false, error: 'INVALID_CHECKOUT_REQUEST' });
  }

  const { createHash, randomUUID } = await import('node:crypto');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const { db } = await import('../database/db.js');
  const client = await db.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '12s'");

    // Exact opaque customer credential validated by the database; no PII in response.
    const request = await client.query<{
      workspace: string;
      status: string;
      driver_user_id: string | null;
      reservation_valid: boolean;
      quote_status: string;
    }>(`
      SELECT workspace, status, driver_user_id, quote_status,
             COALESCE(reservation_expires_at > clock_timestamp(), FALSE) AS reservation_valid
      FROM alo_now_order_requests
      WHERE id=$1 AND customer_status_token_hash=$2
      FOR UPDATE
    `, [id, tokenHash]);
    const r = request.rows[0];
    if (!r) {
      await client.query('ROLLBACK'); inTransaction = false;
      return res.status(404).json({ ok: false, error: 'REQUEST_NOT_FOUND' });
    }
    // Checkout pilot is restricted to Aarau, verified standard prices and a live driver hold.
    if (r.workspace !== 'AARAU' || r.status !== 'DRIVER_ACCEPTED' ||
        !r.driver_user_id || !r.reservation_valid || r.quote_status !== 'STANDARD') {
      await client.query('ROLLBACK'); inTransaction = false;
      return res.status(409).json({ ok: false, error: 'DRIVER_RESERVATION_REQUIRED' });
    }

    // Lock order: request -> payment state -> checkout intent.
    await client.query(`
      INSERT INTO alo_now_payment_states (id, request_id, phase, version)
      VALUES ($1,$2,'AWAITING_DRIVER',1)
      ON CONFLICT (request_id) DO NOTHING
    `, [randomUUID(), id]);

    const payment = await client.query<{
      id: string; phase: string; payment_method: string | null; version: number;
    }>(`
      SELECT id,phase,payment_method,version
      FROM alo_now_payment_states WHERE request_id=$1 FOR UPDATE
    `, [id]);
    const p = payment.rows[0];
    if (!p) throw new Error('PAYMENT_STATE_MISSING');

    const { transitionAloNowPayment } = await import('../modules/aloNow/aloNowPaymentLifecycle.js');
    let phase = p.phase;
    let method = p.payment_method;
    let version = p.version;
    const steps: Array<{ type: 'DRIVER_ACCEPTED' | 'ONLINE_PAYMENT_REQUESTED'; actor: 'DRIVER' | 'CUSTOMER'; actorId: string | null }> = [];
    if (phase === 'AWAITING_DRIVER' && method === null) {
      steps.push({ type: 'DRIVER_ACCEPTED', actor: 'DRIVER', actorId: r.driver_user_id });
    }
    if (phase === 'AWAITING_DRIVER' || phase === 'DRIVER_ACCEPTED') {
      steps.push({ type: 'ONLINE_PAYMENT_REQUESTED', actor: 'CUSTOMER', actorId: null });
    }
    if (phase !== 'AWAITING_DRIVER' && phase !== 'DRIVER_ACCEPTED' &&
        !(phase === 'AWAITING_PAYMENT' && method === 'ONLINE')) {
      await client.query('ROLLBACK'); inTransaction = false;
      return res.status(409).json({ ok: false, error: 'PAYMENT_STATE_CONFLICT' });
    }

    for (const step of steps) {
      const previousPhase = phase;
      const next = transitionAloNowPayment(
        { phase: phase as 'AWAITING_DRIVER' | 'DRIVER_ACCEPTED', method: method as null },
        { type: step.type }
      );
      if (!next.ok) throw new Error('PAYMENT_TRANSITION_REJECTED');
      const newVersion = version + 1;
      const updated = await client.query(`
        UPDATE alo_now_payment_states
        SET phase=$2,payment_method=$3,version=$4,updated_at=NOW()
        WHERE id=$1 AND version=$5
      `, [p.id, next.state.phase, next.state.method, newVersion, version]);
      if (updated.rowCount !== 1) throw new Error('PAYMENT_VERSION_CONFLICT');
      await client.query(`
        INSERT INTO alo_now_payment_events
          (id,payment_state_id,event_type,previous_phase,next_phase,
           actor_type,actor_id,resulting_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [randomUUID(),p.id,step.type,previousPhase,next.state.phase,
          step.actor,step.actorId,newVersion]);
      phase = next.state.phase;
      method = next.state.method;
      version = newVersion;
    }

    await client.query(`
      INSERT INTO alo_now_checkout_intents (request_id,checkout_reference)
      VALUES ($1,$2) ON CONFLICT (request_id) DO NOTHING
    `, [id,randomUUID()]);
    const intent = await client.query<{
      checkout_reference: string; shopify_order_id: string | null;
    }>(`
      SELECT checkout_reference::text,shopify_order_id
      FROM alo_now_checkout_intents WHERE request_id=$1 FOR UPDATE
    `,[id]);
    if (!intent.rows[0] || intent.rows[0].shopify_order_id !== null)
      throw new Error('CHECKOUT_INTENT_CONFLICT');

    await client.query('COMMIT'); inTransaction = false;
    return res.status(200).json({
      ok: true, requestId: id, paymentPhase: 'AWAITING_PAYMENT',
      checkoutPrepared: true, checkoutAllowed: false,
      message: 'Zahlungsstatus vorbereitet. Noch keine Shopify-Bestellung oder Zahlung.'
    });
  } catch (error) {
    console.error('ALO NOW CHECKOUT PREPARATION FAILED', error);
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch { /* connection cleanup */ }
    }
    return res.status(503).json({ ok: false, error: 'CHECKOUT_PREPARATION_UNAVAILABLE' });
  } finally {
    client.release();
  }
});

// ALO_V2701_CUSTOMER_DRAFT_CHECKOUT
// Real Shopify mutations require ALL explicit release gates.
// The opaque customer token is checked before accessing Shopify.
aloNowRouter.post('/order-requests/:id/create-online-checkout', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (
    process.env.NODE_ENV !== 'production' ||
    process.env.ALO_RUNTIME_MODE !== 'production' ||
    process.env.ALO_NOW_REQUESTS_ENABLED !== 'true' ||
    process.env.ALO_NOW_CHECKOUT_PREPARE_ENABLED !== 'true' ||
    process.env.ALO_NOW_REAL_DRAFT_WRITES_ENABLED !== 'true' ||
    process.env.ALO_NOW_DRAFT_CHECKOUT_ROUTE_ENABLED !== 'true'
  ) {
    return res.status(503).json({ ok: false, error: 'CHECKOUT_RELEASE_DISABLED' });
  }

  const requestId = String(req.params.id ?? '');
  const statusToken = req.body?.customerStatusToken;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ||
    typeof statusToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(statusToken)
  ) {
    return res.status(400).json({ ok: false, error: 'INVALID_CHECKOUT_REQUEST' });
  }

  try {
    const { createHash } = await import('node:crypto');
    const { db } = await import('../database/db.js');
    const tokenHash = createHash('sha256').update(statusToken).digest('hex');

    // Fail closed: never expose draft operations for another customer's request.
    // The claim service subsequently locks and revalidates all payment, cart,
    // delivery and reservation conditions before the irreversible Shopify write.
    const authorized = await db.query<{ valid: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM alo_now_order_requests r
        JOIN alo_now_payment_states p ON p.request_id=r.id
        JOIN alo_now_checkout_intents i ON i.request_id=r.id
        WHERE r.id=$1 AND r.customer_status_token_hash=$2
          AND r.workspace='AARAU' AND r.status='DRIVER_ACCEPTED'
          AND r.driver_user_id IS NOT NULL
          AND r.reservation_expires_at>clock_timestamp()
          AND r.quote_status='STANDARD'
          AND p.phase='AWAITING_PAYMENT' AND p.payment_method='ONLINE'
          AND p.shopify_order_id IS NULL
          AND i.shopify_order_id IS NULL
      ) AS valid
    `, [requestId, tokenHash]);
    if (!authorized.rows[0]?.valid) {
      return res.status(409).json({ ok: false, error: 'CHECKOUT_NOT_READY' });
    }

    const [{ env }, { getShopifyAccessToken }, cart, wiring] = await Promise.all([
      import('../config/env.js'),
      import('../integrations/shopify/auth.js'),
      import('../modules/aloNow/aloNowShopifyCartGuard.service.js'),
      import('../modules/aloNow/aloNowCheckoutWiring.v2445.js')
    ]);
    const token = await getShopifyAccessToken();
    const shop = env.shopify.shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const domain = shop.endsWith('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    const checkout = wiring.createAloNowCheckoutWiringV2445({
      readCart: cart.verifyAloNowShopifyCart,
      domain,
      accessToken: token,
      send: fetch
    });
    const result = await checkout(requestId);
    if (!result.ok) {
      // A Shopify request with an uncertain outcome MUST NOT be retried blindly.
      return res.status(409).json({ ok: false, error: result.reason });
    }
    if (typeof result.invoiceUrl !== 'string' ||
        !/^https:\/\//i.test(result.invoiceUrl)) {
      return res.status(409).json({
        ok: false, error: 'DRAFT_CREATED_WITHOUT_PAYMENT_URL',
        manualReviewRequired: true
      });
    }
    return res.status(200).json({
      ok: true,
      requestId,
      checkoutUrl: result.invoiceUrl,
      paymentStatus: 'AWAITING_PAYMENT',
      orderPaid: false
    });
  } catch (error) {
    console.error('ALO NOW DRAFT CHECKOUT FAILED',
      error instanceof Error ? error.name : 'UNKNOWN');
    return res.status(503).json({ ok: false, error: 'CHECKOUT_UNAVAILABLE' });
  }
});


// ALO_V2702_CUSTOMER_REQUEST_STATUS
// Exact opaque customer token, no customer address or items in response.
aloNowRouter.post('/order-requests/:id/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (process.env.ALO_NOW_REQUESTS_ENABLED !== 'true') {
    return res.status(503).json({ ok: false, error: 'ALO_NOW_REQUESTS_NOT_ENABLED' });
  }
  const id = String(req.params.id ?? '');
  const token = req.body?.statusToken;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
  ) {
    return res.status(400).json({ ok: false, error: 'INVALID_STATUS_REQUEST' });
  }
  try {
    const { createHash } = await import('node:crypto');
    const { db } = await import('../database/db.js');
    const digest = createHash('sha256').update(token).digest('hex');
    const result = await db.query<{
      status: string;
      reservation_expires_at: Date | null;
      payment_phase: string | null;
    }>(`
      SELECT r.status, r.reservation_expires_at,
             p.phase AS payment_phase
      FROM alo_now_order_requests r
      LEFT JOIN alo_now_payment_states p ON p.request_id = r.id
      WHERE r.id = $1 AND r.customer_status_token_hash = $2
      LIMIT 1
    `, [id, digest]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: 'REQUEST_NOT_FOUND' });
    const currentStatus = String(row.status);
    const expiryMs = row.reservation_expires_at ? new Date(row.reservation_expires_at).getTime() : null;
    const expiredHold = currentStatus === 'DRIVER_ACCEPTED' &&
      expiryMs !== null && expiryMs <= Date.now() &&
      !['PAYMENT_CONFIRMED','CASH_CONFIRMED'].includes(String(row.payment_phase ?? ''));
    const status = expiredHold ? 'EXPIRED' : currentStatus;
    const message = status === 'DRIVER_OFFERED' ? 'Wir suchen einen verfügbaren Fahrer.' :
      status === 'DRIVER_ACCEPTED' ? 'Ein Fahrer hat deine Anfrage vorläufig angenommen. Noch keine Bestellung oder Zahlung.' :
      status === 'EXPIRED' ? 'Die Fahrerreservierung ist abgelaufen. Bitte beim Team nachfragen.' :
      status === 'PENDING_REVIEW' ? 'Die Lieferanfrage wird geprüft.' :
      status === 'REJECTED' ? 'Diese Lieferanfrage wurde abgelehnt.' :
      'Der Status deiner Lieferanfrage wurde aktualisiert.';
    return res.status(200).json({
      ok: true, requestId: id, status,
      message, checkoutAllowed: false,
      reservationExpiresAt: expiryMs === null ? null : new Date(expiryMs).toISOString()
    });
  } catch (error) {
    console.error('ALO NOW CUSTOMER STATUS FAILED', error instanceof Error ? error.name : 'UNKNOWN');
    return res.status(503).json({ ok: false, error: 'REQUEST_STATUS_UNAVAILABLE' });
  }
});
