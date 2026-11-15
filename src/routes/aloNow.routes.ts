import { aloNowCustomerStatusRouter } from "./aloNowCustomerStatus.routes.js";
import { aloNowFinanceV962Router } from "./aloNowFinanceV962.routes.js";
import aloNowGpsRouter from "./aloNowGps.routes.js";
import { aloNowRouteBridgeRouter } from "./aloNowRouteBridge.routes.js";
import { heartbeatAloNowDriver } from "../database/aloNowDrivers.js";
import { getAloNowDelivery } from "../database/aloNowDeliveries.js";
import { getVerifiedAloNowQuote } from "../modules/aloNow/aloNowVerifiedRouting.service.js";
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


// ALO KIOSK DELIVERY V114 - VERIFIED QUOTE
aloNowRouter.post("/quote", async (req, res) => {
  const body = req.body;
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const workspace = typeof body?.workspace === "string" ? body.workspace.toUpperCase().trim() : "";
  if (address.length < 8 || address.length > 180 || !["AARAU", "OLTEN"].includes(workspace)) {
    return res.status(400).json({ ok: false, error: "INVALID_DELIVERY_ADDRESS_OR_WORKSPACE" });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.json(await getVerifiedAloNowQuote(address, workspace as "AARAU" | "OLTEN"));
});


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
    const result = await db.query<{id: string; status: string; created_at: Date}>(`
      INSERT INTO alo_now_order_requests
        (id, client_request_id, workspace, delivery_address, items,
         quote_status, road_distance_km, quoted_delivery_fee_chf, verified_subtotal_chf, verified_at, customer_status_token_hash)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,NOW(),$10)
      ON CONFLICT (client_request_id) DO NOTHING
      RETURNING id, status, created_at
    `, [randomUUID(), clientRequestId, workspace, address,
        JSON.stringify(verifiedCart.items), quote.status, quote.roadDistanceKm,
        quote.deliveryFeeCHF, verifiedCart.subtotalCHF, customerStatusTokenHash]);
    if (!result.rows[0]) {
      return res.status(409).json({ ok: false, error: "REQUEST_ID_ALREADY_USED" });
    }
    return res.status(202).json({ ok: true, requestId: result.rows[0].id,
      status: "PENDING_REVIEW", checkoutAllowed: false, customerStatusToken,
      verifiedSubtotalCHF: verifiedCart.subtotalCHF, currency: "CHF",
      message: "Unverbindliche Lieferanfrage gespeichert. Keine Bestellung oder Zahlung erfolgt." });
  } catch (error) {
    console.error("ALO NOW REQUEST INTAKE FAILED", error);
    return res.status(503).json({ ok: false, error: "ORDER_REQUEST_UNAVAILABLE" });
  }
});


// V117: ORIGINAL UNPAID EXPIRY LOGIC
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
          )
    RETURNING id
  `);
  return result.rowCount ?? 0;
}


aloNowRouter.get("/admin/order-requests", requireStaffAuth, async (_req, res) => {
  const staff = getStaffUser(res);
  if (staff.role !== "ADMIN" && staff.role !== "MANAGER") {
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  }
  try {
    // ALO_NOW_V342B_REQUEST_LIST_GUARD

    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {

      return res.status(503).json({

        ok: false,

        error: "ALO_NOW_REQUESTS_NOT_ENABLED"

      });

    }

    await expireAloNowUnpaidPreaccepts();
    const { db } = await import("../database/db.js");
    const result = await db.query(`
      /* ALO_NOW_V344B_CAPACITY_STATUS */
        SELECT
          r.id, r.workspace, r.delivery_address,
          r.items, r.quote_status, r.road_distance_km,
          r.quoted_delivery_fee_chf, r.status,
          r.reviewed_at, r.created_at,
          m.fulfillment_method,
          m.capacity_confirmed_until,
          COALESCE(
            m.fulfillment_method = 'INTERNAL_DELIVERY'
            AND m.capacity_confirmed_until > NOW(),
            FALSE
          ) AS merchant_capacity_active
        FROM alo_now_order_requests r
        LEFT JOIN alo_now_merchant_acceptances m
          ON m.request_id = r.id
        ORDER BY r.created_at DESC
        LIMIT 100
    `);
    return res.json({ ok: true, requests: result.rows });
  } catch (error) {
    console.error("ALO NOW ADMIN REQUESTS FAILED", error);
    return res.status(503).json({ ok: false, error: "ORDER_REQUESTS_UNAVAILABLE" });
  }
});


aloNowRouter.post("/order-requests/:id/status", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
    return res.status(503).json({ok:false,error:"ALO_NOW_REQUESTS_NOT_ENABLED"});
  }
  const id = String(req.params.id ?? "");
  const token = req.body?.statusToken;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
      typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return res.status(400).json({ok:false,error:"INVALID_STATUS_REQUEST"});
  }
  try {
    const {createHash} = await import("node:crypto");
    const {db} = await import("../database/db.js");
    const hash = createHash("sha256").update(token).digest("hex");
    // Expired accepts should never be advertised as current to a customer.
    // Inline conditional status does not depend on a background sweeper running.
    // ALO_V266_CUSTOMER_PAYMENT_STATUS
    const result = await db.query<{
      status: string;
      reservation_expires_at: Date | null;
      quote_status: string;
      payment_phase: string | null;
      payment_method: string | null;
        merchant_method: string | null;
        merchant_until: Date | null;
    }>(`
      SELECT
        r.status,
        r.reservation_expires_at,
        r.quote_status,
        p.phase AS payment_phase,
        p.payment_method,
          m.fulfillment_method AS merchant_method,
          m.capacity_confirmed_until AS merchant_until
      FROM alo_now_order_requests r
      LEFT JOIN alo_now_payment_states p
        ON p.request_id = r.id
        LEFT JOIN alo_now_merchant_acceptances m
          ON m.request_id = r.id
      WHERE r.id=$1
        AND r.customer_status_token_hash=$2
      LIMIT 1
    `,[id,hash]);
    const record = result.rows[0];
    if (!record) return res.status(404).json({ok:false,error:"REQUEST_NOT_FOUND"});
    const expired = record.status === "DRIVER_ACCEPTED" &&
      (!record.reservation_expires_at ||
        new Date(record.reservation_expires_at).getTime() <= Date.now());

    const confirmedOnline =
      record.payment_phase === "PAYMENT_CONFIRMED" &&
      record.payment_method === "ONLINE";

    const agreedCash =
      record.payment_phase === "CASH_CONFIRMED" &&
      record.payment_method === "CASH";

    const paymentConfirmed = confirmedOnline || agreedCash;
    const requiresReview = expired && paymentConfirmed;

    // An expired paid reservation must not be presented
    // as an ordinary unpaid request.
    const status =
      expired && !paymentConfirmed
        ? "PENDING_REVIEW"
        : record.status;

    const paymentStatus =
      requiresReview ? "RECONCILIATION_REQUIRED" :
      confirmedOnline ? "ONLINE_CONFIRMED" :
      agreedCash ? "CASH_AGREED" :
      expired ? "RESERVATION_EXPIRED" :
      record.payment_phase === "AWAITING_PAYMENT"
        ? "AWAITING_PAYMENT" :
      record.payment_phase === "DRIVER_ACCEPTED"
        ? "DRIVER_ACCEPTED" :
      "NOT_REQUESTED";


    // ALO_NOW_V347_CUSTOMER_INTERNAL_DELIVERY
    // Merchant capacity is separate from the driver reservation.
    const merchantActive =
      record.merchant_method === "INTERNAL_DELIVERY" &&
      !!record.merchant_until &&
      new Date(record.merchant_until).getTime() > Date.now();

    const merchantCapacityUntil = merchantActive
      ? record.merchant_until
      : null;

    const message =
      merchantActive && !paymentConfirmed
        ? record.payment_phase === "AWAITING_PAYMENT"
          ? "ALO hat deine Lieferung übernommen. Die Zahlung wird vorbereitet."
          : "ALO hat deine Lieferung übernommen. Wir prüfen den nächsten Schritt."
        :
      requiresReview
        ? "Deine Zahlung ist erfasst. Die Fahrerreservierung ist abgelaufen und wird geprueft." :
      confirmedOnline
        ? "Deine Onlinezahlung wurde bestaetigt." :
      agreedCash
        ? "Deine Barzahlungsvereinbarung wurde bestaetigt." :
      paymentStatus === "AWAITING_PAYMENT"
        ? "Fahrer gefunden. Deine Zahlung steht noch aus." :
      status === "DRIVER_ACCEPTED"
        ? "Fahrer gefunden. Die Zahlung ist noch nicht freigegeben." :
      status === "DRIVER_OFFERED"
        ? "Wir suchen einen geeigneten Fahrer." :
      status === "REJECTED"
        ? "Diese Anfrage konnte nicht angenommen werden." :
      status === "CONTACTED"
        ? "ALO NOW prueft deine Anfrage." :
      expired
        ? "Die Fahrerreservierung ist abgelaufen. Wir pruefen deine Anfrage erneut." :
      "Deine Lieferanfrage wird geprueft.";

    // Never return payment links, private identities or
    // checkout permission based on an unverified phase.
    return res.json({
      ok: true,
      status,
      message,
      paymentStatus,
      paymentConfirmed,
      requiresReview,
      merchantDeliveryConfirmed: merchantActive,
        merchantCapacityUntil,
        checkoutAllowed: false,
      reservationExpiresAt:
        !expired && status === "DRIVER_ACCEPTED"
          ? record.reservation_expires_at
          : null
    });
  } catch(error) {
    console.error("ALO NOW CUSTOMER STATUS FAILED",error);
    return res.status(503).json({ok:false,error:"STATUS_UNAVAILABLE"});
  }
});


// V118: STAFF AND DRIVER FLOW
aloNowRouter.patch("/admin/order-requests/:id/review", requireStaffAuth, async (req, res) => {
  const staff = getStaffUser(res);
  if (staff.role !== "ADMIN" && staff.role !== "MANAGER") {
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  }
  const id = String(req.params.id ?? "").trim();
  const action = req.body?.action;
  if (!/^[0-9a-f-]{36}$/i.test(id) || (action !== "CONTACTED" && action !== "REJECTED")) {
    return res.status(400).json({ ok: false, error: "INVALID_REVIEW" });
  }
  try {
    const { db } = await import("../database/db.js");
    const result = await db.query(`
      UPDATE alo_now_order_requests
      SET status = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING_REVIEW'
      RETURNING id, status, reviewed_at
    `, [id, action, staff.id]);
    if (!result.rows[0]) return res.status(409).json({ ok: false, error: "REVIEW_NOT_AVAILABLE" });
    return res.json({ ok: true, request: result.rows[0], checkoutAllowed: false });
  } catch (error) {
    console.error("ALO NOW REQUEST REVIEW FAILED", error);
    return res.status(503).json({ ok: false, error: "REVIEW_UNAVAILABLE" });
  }
});

aloNowRouter.patch('/admin/order-requests/:id/offer-drivers', requireStaffAuth, async (req, res) => {
  if (process.env.ALO_NOW_REQUESTS_ENABLED !== 'true')
    return res.status(503).json({ok:false,error:'ALO_NOW_REQUESTS_NOT_ENABLED'});
  const staff = getStaffUser(res);
  if (staff.role !== 'ADMIN' && staff.role !== 'MANAGER')
    return res.status(403).json({ok:false,error:'FORBIDDEN'});
  const id = String(req.params.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return res.status(400).json({ok:false,error:'INVALID_REQUEST_ID'});
  try {
    const {db} = await import('../database/db.js');
    const updated = await db.query(`
      UPDATE alo_now_order_requests SET
        status='DRIVER_OFFERED', offered_at=NOW(), updated_at=NOW(),
        driver_user_id=NULL, driver_accepted_at=NULL, reservation_expires_at=NULL
      WHERE id=$1 AND status IN ('PENDING_REVIEW','CONTACTED')
        AND quote_status='STANDARD'
      RETURNING id,status,workspace,offered_at
    `,[id]);
    if (!updated.rows[0])
      return res.status(409).json({ok:false,error:'OFFER_NOT_ALLOWED_OR_MANUAL_QUOTE'});
    return res.json({ok:true,request:updated.rows[0],checkoutAllowed:false,
      message:'Fahrerangebot ist unverbindlich. Warenkorb und Alter noch nicht geprüft.'});
  } catch(e) {
    console.error('ALO NOW DRIVER OFFER FAILED',e);
    return res.status(503).json({ok:false,error:'OFFER_UNAVAILABLE'});
  }
});

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
          )
    `,[staff.id]);
    // ALO_NOW_MULTI_PREACCEPT_CAPACITY_V4
    // Count UNPAID reservations + active PAID deliveries as the same capacity.
    // This query runs while the driver's profile row is FOR UPDATE locked.
    const reserved=await client.query<{ n: number }>(`
      SELECT COUNT(*)::integer AS n FROM alo_now_order_requests
      WHERE driver_user_id=$1 AND status='DRIVER_ACCEPTED'
        AND reservation_expires_at > NOW()
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

aloNowRouter.patch(
  "/admin/order-requests/:id/accept-delivery",
  requireStaffAuth,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (
      process.env.ALO_NOW_REQUESTS_ENABLED !== "true" ||
      process.env.ALO_NOW_MERCHANT_ACCEPT_ENABLED !== "true"
    ) {
      return res.status(503).json({
        ok: false,
        error: "MERCHANT_ACCEPTANCE_DISABLED",
        checkoutAllowed: false
      });
    }

    const staff = getStaffUser(res);

    if (staff.role !== "ADMIN" && staff.role !== "MANAGER") {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN",
        checkoutAllowed: false
      });
    }

    const requestId = String(req.params.id ?? "");
    const body = req.body ?? {};

    // External-driver assignments are deliberately not exposed.
    // An arbitrary browser-provided driver ID is not trusted.
    if (
      body.method !== "INTERNAL_DELIVERY" ||
      body.assignedDriverId !== undefined ||
      !Number.isInteger(body.capacityMinutes) ||
      body.capacityMinutes < 5 ||
      body.capacityMinutes > 30
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_INTERNAL_DELIVERY_REQUEST",
        checkoutAllowed: false
      });
    }

    try {
      const { acceptAloNowDeliveryV330 } = await import(
        "../modules/aloNow/aloNowMerchantAcceptanceService.v330.js"
      );

      const result = await acceptAloNowDeliveryV330({
        requestId,
        method: "INTERNAL_DELIVERY",
        acceptedBy: String(staff.id),
        assignedDriverId: null,
        capacityMinutes: body.capacityMinutes
      });

      if (!result.ok) {
        const status =
          result.reason === "INVALID_REQUEST_ID" ? 400 :
          result.reason === "REQUEST_NOT_FOUND" ? 404 :
          result.reason === "ACCEPTANCE_UNAVAILABLE" ? 503 :
          409;

        return res.status(status).json({
          ok: false,
          error: result.reason,
          checkoutAllowed: false
        });
      }

      return res.json({
        ok: true,
        action: result.action,
        fulfillmentMethod: result.method,
        capacityConfirmedUntil: result.validUntil,
        checkoutAllowed: false,
        message: "ALO Kiosk hat die Eigenlieferung intern bestätigt."
      });
    } catch (error) {
      console.error("ALO NOW MERCHANT ACCEPTANCE FAILED", error);
      return res.status(503).json({
        ok: false,
        error: "MERCHANT_ACCEPTANCE_UNAVAILABLE",
        checkoutAllowed: false
      });
    }
  }
);


// V119: ORIGINAL PAYMENT HANDLERS
aloNowRouter.patch(
  "/admin/order-requests/:id/authorize-payment",
  requireStaffAuth,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (
      process.env.ALO_NOW_REQUESTS_ENABLED !== "true" ||
      process.env.ALO_NOW_MERCHANT_ACCEPT_ENABLED !== "true" ||
      process.env.ALO_NOW_MERCHANT_PAYMENT_ENABLED !== "true"
    ) {
      return res.status(503).json({
        ok: false,
        error: "MERCHANT_PAYMENT_DISABLED",
        checkoutAllowed: false
      });
    }

    const staff = getStaffUser(res);

    if (
      staff.role !== "ADMIN" &&
      staff.role !== "MANAGER"
    ) {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN",
        checkoutAllowed: false
      });
    }

    const requestId = String(req.params.id ?? "").trim();

    // No browser-provided price, address verification,
    // actor identity or payment method is accepted.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(requestId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST_ID",
        checkoutAllowed: false
      });
    }

    try {
      const { authorizeAloNowMerchantPaymentV336 } =
        await import(
          "../modules/aloNow/aloNowMerchantPaymentStart.v336.js"
        );

      const result = await authorizeAloNowMerchantPaymentV336(
        requestId,
        String(staff.id)
      );

      if (!result.ok) {
        const code =
          result.reason === "REQUEST_NOT_FOUND" ? 404 :
          result.reason === "MERCHANT_PAYMENT_UNAVAILABLE" ? 503 :
          result.reason === "INVALID_ACTOR" ? 403 :
          409;

        return res.status(code).json({
          ok: false,
          error: result.reason,
          checkoutAllowed: false
        });
      }

      return res.json({
        ok: true,
        action: result.action,
        paymentPhase: "AWAITING_PAYMENT",
        paymentMethod: "ONLINE",
        version: result.version,
        checkoutAllowed: false,
        message:
          "Interne Zahlungsfreigabe vorbereitet. " +
          "Es wurde keine Zahlung ausgeführt."
      });
    } catch (error) {
      console.error(
        "ALO NOW MERCHANT PAYMENT AUTHORIZATION FAILED",
        error
      );

      return res.status(503).json({
        ok: false,
        error: "MERCHANT_PAYMENT_UNAVAILABLE",
        checkoutAllowed: false
      });
    }
  }
);

aloNowRouter.post(
  "/admin/order-requests/:id/verify-online-payment",
  requireStaffAuth,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (
      process.env.ALO_NOW_REQUESTS_ENABLED !== "true" ||
      process.env.ALO_NOW_MERCHANT_ACCEPT_ENABLED !== "true" ||
      process.env.ALO_NOW_MERCHANT_PAYMENT_ENABLED !== "true" ||
      process.env.ALO_NOW_VERIFIED_PAYMENT_COMMIT_ENABLED !== "true"
    ) {
      return res.status(503).json({
        ok: false,
        error: "VERIFIED_PAYMENT_COMMIT_DISABLED",
        cashCollectionAllowed: false
      });
    }

    const staff = getStaffUser(res);

    if (
      staff.role !== "ADMIN" &&
      staff.role !== "MANAGER"
    ) {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN",
        cashCollectionAllowed: false
      });
    }

    const requestId = String(req.params.id ?? "").trim();

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(requestId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST_ID",
        cashCollectionAllowed: false
      });
    }

    if (
      req.body != null &&
      (
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length !== 0
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: "PAYMENT_EVIDENCE_FROM_CLIENT_FORBIDDEN",
        cashCollectionAllowed: false
      });
    }

    try {
      const { commitVerifiedAloNowOnlinePayment } =
        await import(
          "../modules/aloNow/aloNowVerifiedPaymentCommit.js"
        );

      const { readAloNowLiveShopifyPayment } =
        await import(
          "../modules/aloNow/aloNowLiveShopifyPaymentReader.js"
        );

      const result = await commitVerifiedAloNowOnlinePayment(
        requestId,
        readAloNowLiveShopifyPayment
      );

      if (!result.ok) {
        const status =
          result.reason === "INVALID_REQUEST_ID" ? 400 :
          result.reason === "REQUEST_NOT_FOUND" ? 404 :
          result.reason === "SHOPIFY_LOOKUP_FAILED" ? 503 :
          result.reason === "SHOPIFY_ORDER_NOT_FOUND" ? 503 :
          409;

        return res.status(status).json({
          ok: false,
          error: result.reason,
          cashCollectionAllowed: false
        });
      }

      return res.json({
        ok: true,
        action: result.action,
        paymentPhase:
          result.action === "RECONCILE"
            ? "AWAITING_PAYMENT"
            : "PAYMENT_CONFIRMED",
        version: result.version ?? null,
        cashCollectionAllowed: false,
        canConfirmCashPayment: false,
        deliveryDispatched: false
      });
    } catch (error) {
      console.error(
        "ALO NOW VERIFIED PAYMENT COMMIT ERROR",
        error instanceof Error ? error.name : "UNKNOWN_ERROR"
      );

      return res.status(503).json({
        ok: false,
        error: "VERIFIED_PAYMENT_COMMIT_UNAVAILABLE",
        cashCollectionAllowed: false
      });
    }
  }
);


// V123: DELIVERY STATUS AND DRIVER HEARTBEAT
aloNowRouter.get(
  "/deliveries/:orderId/status",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const orderId = String(req.params.orderId ?? "").trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "SHOPIFY_ORDER_ID_REQUIRED",
        });
      }

      const delivery = await getAloNowDelivery(orderId);

      // Same response for missing and unassigned deliveries:
      // do not reveal whether another driver's order exists.
      if (
        !delivery ||
        delivery.assigned_driver_user_id !== staffUser.id
      ) {
        return res.status(404).json({
          ok: false,
          error: "DELIVERY_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        orderId: delivery.shopify_order_id,
        status: delivery.delivery_status,
      });
    } catch (error) {
      console.error("ALO NOW DELIVERY STATUS ERROR", error);
      return res.status(500).json({
        ok: false,
        error: "ALO_NOW_DELIVERY_STATUS_FAILED",
      });
    }
  }
);

aloNowRouter.post(
  "/driver/heartbeat",
  requireStaffAuth,
  async (_req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const result = await heartbeatAloNowDriver(staffUser.id);
      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          error: "ALO_DRIVER_NOT_APPROVED_OR_OFFLINE",
        });
      }
      return res.json({
        ok: true,
        lastSeenAt: result.lastSeenAt,
      });
    } catch (error) {
      console.error("ALO NOW HEARTBEAT ERROR", error);
      return res.status(500).json({
        ok: false,
        error: "ALO_NOW_HEARTBEAT_FAILED",
      });
    }
  }
);


// V128: GPS AND ROUTE BRIDGE
aloNowRouter.use(aloNowGpsRouter);
// V155: Customer-owned order status, token protected.
aloNowRouter.use(aloNowCustomerStatusRouter);


// V136: Test routing is disabled unless explicitly enabled.
if (
  process.env.NODE_ENV !== "production" &&
  process.env.ALO_NOW_TEST_BRIDGE_ENABLED === "true"
) {
  aloNowRouter.use("/test-tour-bridge", aloNowRouteBridgeRouter);
}


/**
 * V133 - Finance routes remain OFF by default.
 * Do not enable before authorization,
 * payment and database integration tests.
 */
if (process.env.ALO_NOW_FINANCE_ROUTER_ENABLED === "true") {
  aloNowRouter.use(aloNowFinanceV962Router);
}
