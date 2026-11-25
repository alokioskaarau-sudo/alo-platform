import { db as aloNowCheckoutPoolV3062 } from "../database/db.js";
import { getShopifyAccessToken as getCheckoutShopifyTokenV3062 } from "../integrations/shopify/auth.js";
import { env as aloNowCheckoutEnvV3062 } from "../config/env.js";
import { createAloNowLiveCheckoutV3060D } from "../modules/aloNow/aloNowLiveCheckoutOrchestrator.v3060d.js";
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


aloNowRouter.post("/order-requests", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  // ALO_NOW_V2948W_PUBLIC_INTAKE_KILL_SWITCH
  // Independent from existing staff and offer workflows.
  if (process.env.ALO_NOW_PUBLIC_INTAKE_ENABLED !== "true") {
    return res.status(503).json({
      ok: false,
      error: "ALO_NOW_PUBLIC_INTAKE_DISABLED"
    });
  }
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

  // V3658_NEW_CONTACT
  const {validateAloNowDeliveryContact,
    formatAloNowDeliveryAddress} =
    await import("../modules/aloNow/aloNowDeliveryContact.js");

  let validatedContactV3658:
    ReturnType<typeof validateAloNowDeliveryContact> | null = null;

  if (body.deliveryContact !== undefined) {
    try {
      validatedContactV3658 =
        validateAloNowDeliveryContact(body.deliveryContact);
      if (formatAloNowDeliveryAddress(validatedContactV3658)
          !== address) {
        return res.status(422).json({
          ok:false,error:"DELIVERY_ADDRESS_MISMATCH"
        });
      }
    } catch {
      return res.status(422).json({
        ok:false,error:"INVALID_DELIVERY_CONTACT"
      });
    }
  }
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
         quote_status, road_distance_km, quoted_delivery_fee_chf, verified_subtotal_chf, verified_at, customer_status_token_hash, delivery_contact)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,NOW(),$10,$11::jsonb)
      ON CONFLICT (client_request_id) DO NOTHING
      RETURNING id, status, created_at
    `, [randomUUID(), clientRequestId, workspace, address,
        JSON.stringify(verifiedCart.items), quote.status, quote.roadDistanceKm,
        quote.deliveryFeeCHF, verifiedCart.subtotalCHF,
        customerStatusTokenHash,
        validatedContactV3658
          ? JSON.stringify(validatedContactV3658)
          : null]);
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


// V3658_CUSTOMER_CONTACT_RECOVERY
aloNowRouter.post(
  "/order-requests/:id/delivery-contact",
  async (req,res) => {
    res.setHeader("Cache-Control","no-store");

    const requestId=String(req.params.id ?? "");
    const token=req.body?.statusToken;

    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId) ||
      typeof token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)
    ) {
      return res.status(400).json({
        ok:false,error:"INVALID_CONTACT_AUTHORIZATION"
      });
    }

    try {
      const {createHash}=await import("node:crypto");
      const {db}=await import("../database/db.js");
      const {
        validateAloNowDeliveryContact,
        formatAloNowDeliveryAddress
      }=await import("../modules/aloNow/aloNowDeliveryContact.js");

      let contact;
      try {
        contact=validateAloNowDeliveryContact(
          req.body?.deliveryContact
        );
      } catch {
        return res.status(422).json({
          ok:false,error:"INVALID_DELIVERY_CONTACT"
        });
      }

      const tokenHash=createHash("sha256")
        .update(token).digest("hex");

      const address=formatAloNowDeliveryAddress(contact);

      const result=await db.query(`
        UPDATE public.alo_now_order_requests r
        SET delivery_contact=$3::jsonb,
            updated_at=NOW()
        WHERE r.id=$1
          AND r.customer_status_token_hash=$2
          AND r.workspace='AARAU'
          AND r.delivery_address=$4
          AND r.delivery_contact IS NULL
          AND r.status IN ('PENDING_REVIEW','CONTACTED')
          AND NOT EXISTS (
            SELECT 1
            FROM public.alo_now_checkout_attempts a
            WHERE a.request_id=r.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.alo_now_payment_states p
            WHERE p.request_id=r.id
              AND p.phase NOT IN ('AWAITING_PAYMENT')
          )
        RETURNING r.id
      `,[requestId,tokenHash,JSON.stringify(contact),address]);

      if (result.rowCount !== 1) {
        return res.status(409).json({
          ok:false,error:"CONTACT_UPDATE_NOT_ALLOWED"
        });
      }

      return res.json({
        ok:true,contactSaved:true,checkoutAllowed:false
      });
    } catch (error) {
      console.error(
        "V3658 CONTACT RECOVERY FAILED",
        error instanceof Error ? error.name : "UNKNOWN"
      );
      return res.status(503).json({
        ok:false,error:"CONTACT_UPDATE_UNAVAILABLE"
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
    // V3663B_ADMIN_ARCHIVE
    const viewV3663B = String(_req.query.view ?? "active");
    if (viewV3663B !== "active" && viewV3663B !== "archive") {
      return res.status(400).json({
        ok: false, error: "INVALID_REQUEST_VIEW"
      });
    }
    const archiveViewV3663B = viewV3663B === "archive";

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
          r.id,
          r.workspace,
          r.status,
          r.delivery_address,
            r.items,
          r.quote_status,
          r.road_distance_km,
          r.quoted_delivery_fee_chf,
          r.verified_subtotal_chf,
            offer.manual_offer_status,
            offer.manual_offer_expires_at,
            offer.manual_offer_version,
          r.created_at
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
        WHERE r.workspace = ANY($1::text[])
AND (
  ($2::boolean AND
(
  r.status IN (
    'EXPIRED', 'REJECTED', 'CANCELLED',
    'DELIVERED', 'COMPLETED'
  )
  OR (
    r.status IN (
      'PENDING_REVIEW', 'CONTACTED',
      'DRIVER_OFFERED', 'DRIVER_ACCEPTED'
    )
    AND r.created_at < NOW() - INTERVAL '24 hours'
    AND r.delivery_contact IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM alo_now_checkout_attempts ca
      WHERE ca.request_id = r.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM alo_now_merchant_acceptances ma
      WHERE ma.request_id = r.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM alo_now_manual_offers mo
      WHERE mo.request_id = r.id
        AND (
          mo.status = 'ACCEPTED'
          OR (
            mo.status = 'OFFERED'
            AND mo.expires_at > NOW()
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM alo_now_payment_states ps
      WHERE ps.request_id = r.id
        AND ps.phase IN (
          'PAYMENT_CONFIRMED', 'CASH_CONFIRMED'
        )
    )
  )
)
)
  OR
  (NOT $2::boolean AND NOT
(
  r.status IN (
    'EXPIRED', 'REJECTED', 'CANCELLED',
    'DELIVERED', 'COMPLETED'
  )
  OR (
    r.status IN (
      'PENDING_REVIEW', 'CONTACTED',
      'DRIVER_OFFERED', 'DRIVER_ACCEPTED'
    )
    AND r.created_at < NOW() - INTERVAL '24 hours'
    AND r.delivery_contact IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM alo_now_checkout_attempts ca
      WHERE ca.request_id = r.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM alo_now_merchant_acceptances ma
      WHERE ma.request_id = r.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM alo_now_manual_offers mo
      WHERE mo.request_id = r.id
        AND (
          mo.status = 'ACCEPTED'
          OR (
            mo.status = 'OFFERED'
            AND mo.expires_at > NOW()
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM alo_now_payment_states ps
      WHERE ps.request_id = r.id
        AND ps.phase IN (
          'PAYMENT_CONFIRMED', 'CASH_CONFIRMED'
        )
    )
  )
)
)
)
        ORDER BY r.created_at DESC
        LIMIT 100
      `, [allowedWorkspaces, archiveViewV3663B]);

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

// ALO_NOW_V2912_ISOLATED_CUSTOMER_API
// ALO_NOW_V2851_CUSTOMER_MANUAL_DECISION
// Stores customer decision only. Does not release checkout.
aloNowRouter.post(
  "/order-requests/:id/manual-offer/:offerId/decision",
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (
      process.env.ALO_NOW_REQUESTS_ENABLED !== "true" ||
      process.env.ALO_NOW_MANUAL_OFFERS_ENABLED !== "true"
    ) {
      return res.status(503).json({
        ok: false,
        error: "MANUAL_OFFERS_NOT_ENABLED",
        checkoutAllowed: false
      });
    }

    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const requestId = String(req.params.id ?? "");
    const offerId = String(req.params.offerId ?? "");
    const token = req.body?.statusToken;
    const decision = req.body?.decision;
    const version = req.body?.version;

    if (
      !uuid.test(requestId) ||
      !uuid.test(offerId) ||
      typeof token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !["ACCEPT", "DECLINE"].includes(decision) ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_MANUAL_DECISION",
        checkoutAllowed: false
      });
    }

    const { createHash } = await import("node:crypto");
    const { db } = await import("../database/db.js");

    const digest = createHash("sha256")
      .update(token)
      .digest("hex");

    const client = await db.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(
        "SET LOCAL lock_timeout = '3s'"
      );
      await client.query(
        "SET LOCAL statement_timeout = '12s'"
      );

      const request = await client.query<{
        status: string;
        quote_status: string;
      }>(`
        SELECT status, quote_status
        FROM alo_now_order_requests
        WHERE id = $1
          AND customer_status_token_hash = $2
        FOR UPDATE
      `, [requestId, digest]);

      const row = request.rows[0];

      if (!row) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(404).json({
          ok: false,
          error: "REQUEST_NOT_FOUND",
          checkoutAllowed: false
        });
      }

      if (
        row.quote_status !== "MANUAL_APPROVAL" ||
        !["PENDING_REVIEW", "CONTACTED"]
          .includes(row.status)
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(409).json({
          ok: false,
          error: "REQUEST_NOT_ELIGIBLE",
          checkoutAllowed: false
        });
      }

      const result = await client.query<{
        status: string;
        still_valid: boolean;
      }>(`
        SELECT status,
               (expires_at > clock_timestamp()) AS still_valid
        FROM alo_now_manual_offers
        WHERE id = $1
          AND request_id = $2
          AND version = $3
        FOR UPDATE
      `, [offerId, requestId, version]);

      const offer = result.rows[0];

      if (!offer ||
          offer.status !== "OFFERED" ||
          offer.still_valid !== true) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return res.status(409).json({
          ok: false,
          error: "OFFER_NOT_ACTIVE",
          checkoutAllowed: false
        });
      }

      const nextStatus =
        decision === "ACCEPT"
          ? "ACCEPTED"
          : "DECLINED";

      await client.query(`
        UPDATE alo_now_manual_offers
        SET status = $4,
            accepted_at = CASE
              WHEN $4 = 'ACCEPTED' THEN NOW()
              ELSE NULL
            END
        WHERE id = $1
          AND request_id = $2
          AND version = $3
          AND status = 'OFFERED'
      `, [offerId, requestId, version, nextStatus]);

      await client.query("COMMIT");
      inTransaction = false;

      return res.status(200).json({
        ok: true,
        requestId,
        offerId,
        version,
        status: nextStatus,
        checkoutAllowed: false,
        paymentCreated: false
      });
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK");
      }

      console.error(
        "ALO NOW MANUAL DECISION FAILURE",
        error instanceof Error ? error.name : "UNKNOWN"
      );

      return res.status(503).json({
        ok: false,
        error: "MANUAL_DECISION_UNAVAILABLE",
        checkoutAllowed: false
      });
    } finally {
      client.release();
    }
  }
);

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
    // ALO_NOW_V2850_CUSTOMER_MANUAL_OFFER
    // Only available after V2848 database migration.
    // No checkout or payment authorization.
    let manualOffer: null | {
      id: string;
      version: number;
      status: string;
      currency: "CHF";
      subtotalCHF: string;
      deliveryFeeCHF: string;
      extraFeeCHF: string;
      extraReason: string | null;
      totalCHF: string;
      expiresAt: string;
      canAccept: boolean;
    } = null;

    if (process.env.ALO_NOW_MANUAL_OFFERS_ENABLED === "true") {
      const offerResult = await db.query<{
        id: string;
        version: number;
        status: string;
        subtotal_chf: string;
        delivery_fee_chf: string;
        extra_fee_chf: string;
        extra_reason: string | null;
        total_chf: string;
        expires_at: Date;
      }>(`
        SELECT o.id::text, o.version, o.status,
               o.subtotal_chf::text,
               o.delivery_fee_chf::text,
               o.extra_fee_chf::text,
               o.extra_reason,
               o.total_chf::text,
               o.expires_at
        FROM alo_now_manual_offers o
        INNER JOIN alo_now_order_requests r
          ON r.id = o.request_id
        WHERE o.request_id = $1
          AND r.customer_status_token_hash = $2
          AND o.status IN ('OFFERED', 'ACCEPTED')
        ORDER BY o.version DESC
        LIMIT 1
      `, [id, digest]);

      const offer = offerResult.rows[0];

      if (offer) {
        const expiresAt = new Date(offer.expires_at);
        const stillValid = expiresAt.getTime() > Date.now();

        manualOffer = {
          id: offer.id,
          version: Number(offer.version),
          status:
            offer.status === "OFFERED" && !stillValid
              ? "EXPIRED"
              : offer.status,
          currency: "CHF",
          subtotalCHF: Number(offer.subtotal_chf).toFixed(2),
          deliveryFeeCHF: Number(offer.delivery_fee_chf).toFixed(2),
          extraFeeCHF: Number(offer.extra_fee_chf).toFixed(2),
          extraReason: offer.extra_reason,
          totalCHF: Number(offer.total_chf).toFixed(2),
          expiresAt: expiresAt.toISOString(),
          canAccept:
            offer.status === "OFFERED" &&
            stillValid &&
            status !== "REJECTED"
        };
      }
    }


    // V3583_CUSTOMER_CHECKOUT_READY
    // Read-only. No Shopify call or payment creation.
    let checkoutReadyV3583 = false;

    if (
      process.env.ALO_NOW_CUSTOMER_CHECKOUT_LINK_ENABLED === "true" &&
      ["DRIVER_ACCEPTED", "PENDING_REVIEW", "CONTACTED"]
        .includes(status)
    ) {
      const readinessV3583 = await db.query<{
        ready: boolean;
      }>(`
        SELECT EXISTS (
          SELECT 1
          FROM public.alo_now_order_requests r
          JOIN public.alo_now_payment_states p
            ON p.request_id = r.id
          JOIN LATERAL (
            SELECT
              a.status,
              a.invoice_url,
              a.expected_total_chf
            FROM public.alo_now_checkout_attempts a
            WHERE a.request_id = r.id
            ORDER BY a.created_at DESC,
                     a.checkout_reference DESC
            LIMIT 1
          ) a ON TRUE
          WHERE r.id = $1
            AND r.customer_status_token_hash = $2
            AND r.workspace = 'AARAU'
            AND (
              (
                r.status = 'DRIVER_ACCEPTED'
                AND r.driver_user_id IS NOT NULL
                AND r.reservation_expires_at > NOW()
              )
              OR (
                r.status IN ('PENDING_REVIEW', 'CONTACTED')
                AND r.driver_user_id IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM public.alo_now_merchant_acceptances mi
                  WHERE mi.request_id = r.id
                    AND mi.fulfillment_method = 'INTERNAL_DELIVERY'
                    AND mi.assigned_driver_id IS NULL
                    AND btrim(mi.accepted_by) <> ''
                    AND mi.capacity_confirmed_at <= NOW()
                    AND (mi.capacity_confirmed_until > NOW() OR (
  r.status = 'CONTACTED'
  AND r.quote_status = 'MANUAL_APPROVAL'
  AND r.driver_user_id IS NULL
  AND r.verified_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.alo_now_manual_offers recovery_offer
    WHERE recovery_offer.request_id = r.id
      AND recovery_offer.status = 'ACCEPTED'
      AND recovery_offer.version = (
        SELECT MAX(recovery_latest.version)
        FROM public.alo_now_manual_offers recovery_latest
        WHERE recovery_latest.request_id = r.id
      )
      AND recovery_offer.subtotal_chf =
          r.verified_subtotal_chf
      AND recovery_offer.delivery_fee_chf = 12.90
      AND recovery_offer.extra_fee_chf >= 0
      AND recovery_offer.total_chf =
          recovery_offer.subtotal_chf
          + recovery_offer.delivery_fee_chf
          + recovery_offer.extra_fee_chf
  )
))
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.alo_now_merchant_acceptances m
              WHERE m.request_id = r.id
                AND m.capacity_confirmed_until <= NOW()
AND NOT (
  r.status = 'CONTACTED'
  AND r.quote_status = 'MANUAL_APPROVAL'
  AND r.driver_user_id IS NULL
  AND r.verified_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.alo_now_manual_offers recovery_offer
    WHERE recovery_offer.request_id = r.id
      AND recovery_offer.status = 'ACCEPTED'
      AND recovery_offer.version = (
        SELECT MAX(recovery_latest.version)
        FROM public.alo_now_manual_offers recovery_latest
        WHERE recovery_latest.request_id = r.id
      )
      AND recovery_offer.subtotal_chf =
          r.verified_subtotal_chf
      AND recovery_offer.delivery_fee_chf = 12.90
      AND recovery_offer.extra_fee_chf >= 0
      AND recovery_offer.total_chf =
          recovery_offer.subtotal_chf
          + recovery_offer.delivery_fee_chf
          + recovery_offer.extra_fee_chf
  )
)
            )
            AND p.phase = 'AWAITING_PAYMENT'
            AND p.payment_method = 'ONLINE'
            AND a.status = 'READY'
            AND a.invoice_url IS NOT NULL
            AND length(a.invoice_url) > 8
            AND a.expected_total_chf::numeric = (
              CASE
                WHEN r.quote_status = 'STANDARD'
                  AND r.verified_at IS NOT NULL
                  AND r.verified_subtotal_chf > 0
                  AND r.quoted_delivery_fee_chf = 12.90
                THEN
                  r.verified_subtotal_chf +
                  r.quoted_delivery_fee_chf

                WHEN r.quote_status = 'MANUAL_APPROVAL'
                  AND r.verified_at IS NOT NULL
                THEN (
                  SELECT mo.total_chf
                  FROM public.alo_now_manual_offers mo
                  WHERE mo.request_id = r.id
                    AND mo.version = (
                      SELECT MAX(newest.version)
                      FROM public.alo_now_manual_offers newest
                      WHERE newest.request_id = r.id
                    )
                    AND mo.status = 'ACCEPTED'
                    AND mo.subtotal_chf =
                        r.verified_subtotal_chf
                    AND mo.delivery_fee_chf = 12.90
                    AND mo.extra_fee_chf >= 0
                    AND mo.total_chf =
                        mo.subtotal_chf +
                        mo.delivery_fee_chf +
                        mo.extra_fee_chf
                  LIMIT 1
                )
                ELSE NULL
              END
            )
        ) AS ready
      `, [id, digest]);

      checkoutReadyV3583 =
        readinessV3583.rows[0]?.ready === true;
    }

    const message = status === 'DRIVER_OFFERED' ? 'Wir suchen einen verfügbaren Fahrer.' :
      status === 'DRIVER_ACCEPTED' ? 'Ein Fahrer hat deine Anfrage vorläufig angenommen. Noch keine Bestellung oder Zahlung.' :
      status === 'EXPIRED' ? 'Die Fahrerreservierung ist abgelaufen. Bitte beim Team nachfragen.' :
      status === 'PENDING_REVIEW' ? 'Die Lieferanfrage wird geprüft.' :
      status === 'REJECTED' ? 'Diese Lieferanfrage wurde abgelehnt.' :
      'Der Status deiner Lieferanfrage wurde aktualisiert.';
    return res.status(200).json({
      ok: true, requestId: id, status,
      manualOffer,
      message, checkoutAllowed: checkoutReadyV3583,
      reservationExpiresAt: expiryMs === null ? null : new Date(expiryMs).toISOString()
    });
  } catch (error) {
    console.error('ALO NOW CUSTOMER STATUS FAILED', error instanceof Error ? error.name : 'UNKNOWN');
    return res.status(503).json({ ok: false, error: 'REQUEST_STATUS_UNAVAILABLE' });
  }
});


// V3557_MANUAL_DRIVER_PREACCEPT
// Manual offer must already be accepted and price-verified.
// Driver acceptance is temporary; no Shopify order or charge.

aloNowRouter.patch(
  "/admin/order-requests/:id/offer-drivers",
  requireStaffAuth,
  async (req, res) => {

    // V3563_GUARDED_DRIVER_RELEASE
    if (process.env.ALO_NOW_MANUAL_DRIVER_DISPATCH_ENABLED !== "true") {
      return res.status(503).json({
        ok: false,
        error: "MANUAL_DRIVER_DISPATCH_NOT_ENABLED"
      });
    }

    const staff = getStaffUser(res);
    if (!["ADMIN", "MANAGER"].includes(String(staff.role))) {
      return res.status(403).json({ok:false,error:"FORBIDDEN"});
    }
    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
      return res.status(503).json({ok:false,error:"REQUESTS_DISABLED"});
    }
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ok:false,error:"INVALID_REQUEST_ID"});
    }

    const {db} = await import("../database/db.js");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query<{
        id:string; workspace:string; status:string;
        quote_status:string; verified_at:Date|null;
        verified_subtotal_chf:string; driver_user_id:string|null;
      }>(`
        SELECT id,workspace,status,quote_status,verified_at,
               verified_subtotal_chf,driver_user_id
        FROM alo_now_order_requests WHERE id=$1 FOR UPDATE
      `,[id]);

      const request = rows.rows[0];
      if (!request) {
        await client.query("ROLLBACK");
        return res.status(404).json({ok:false,error:"REQUEST_NOT_FOUND"});
      }

      const identity = staff as typeof staff & {
        allowedWorkspaces?:string[];
      };
      if (String(staff.role) !== "ADMIN" &&
          !identity.allowedWorkspaces?.includes(request.workspace)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ok:false,error:"WORKSPACE_FORBIDDEN"});
      }

      if (!["PENDING_REVIEW","CONTACTED"].includes(request.status) ||
          request.quote_status !== "MANUAL_APPROVAL" ||
          !request.verified_at || request.driver_user_id !== null) {
        await client.query("ROLLBACK");
        return res.status(409).json({ok:false,error:"REQUEST_NOT_ELIGIBLE"});
      }

      const offer = await client.query<{id:string}>(`
        SELECT o.id FROM alo_now_manual_offers o
        WHERE o.request_id=$1
          AND o.version=(
            SELECT MAX(v.version) FROM alo_now_manual_offers v
            WHERE v.request_id=$1
          )
          AND o.status='ACCEPTED'
          AND o.subtotal_chf=$2::numeric
          AND o.delivery_fee_chf>=12.90
          AND o.extra_fee_chf>=0
          AND o.total_chf=o.subtotal_chf+
              o.delivery_fee_chf+o.extra_fee_chf
        LIMIT 1
      `,[id,request.verified_subtotal_chf]);

      if (!offer.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ok:false,error:"NO_VERIFIED_ACCEPTED_OFFER"});
      }

      const conflict = await client.query<{n:boolean}>(`
        SELECT EXISTS (
          SELECT 1 FROM alo_now_merchant_acceptances
          WHERE request_id=$1
            AND fulfillment_method='INTERNAL_DELIVERY'
            AND capacity_confirmed_until>NOW()
        ) AS n
      `,[id]);

      if (conflict.rows[0]?.n) {
        await client.query("ROLLBACK");
        return res.status(409).json({ok:false,error:"INTERNAL_DELIVERY_ACTIVE"});
      }

      const updated = await client.query(`
        UPDATE alo_now_order_requests
        SET status='DRIVER_OFFERED',
            offered_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status IN ('PENDING_REVIEW','CONTACTED')
        RETURNING id,status,workspace,offered_at
      `,[id]);

      await client.query("COMMIT");
      // V3562_DRIVER_PUSH
      // The DB transition is committed before external push delivery.
      // Push errors never roll back an already released request.
      try {
        const {sendAloNowDriverOfferPushV3562} =
          await import(
            "../modules/aloNow/aloNowDriverOfferPush.v3562.js"
          );
        const push = await sendAloNowDriverOfferPushV3562(
          id,
          request.workspace
        );
        console.info("ALO_NOW_DRIVER_PUSH_RESULT", {
          recipients: push.recipients,
          accepted: push.accepted,
          errors: push.errors
        });
      } catch (_pushError) {
        console.error("ALO_NOW_DRIVER_PUSH_FAILED");
      }

      return res.json({
        ok:true,request:updated.rows[0],checkoutAllowed:false
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("V3557 DRIVER RELEASE FAILED");
      return res.status(503).json({ok:false,error:"DRIVER_RELEASE_UNAVAILABLE"});
    } finally {
      client.release();
    }
  }
);


// V3644B_ACCEPTED_TOUR
// Read-only list of internally accepted requests.
// Never confirms payment or creates a Shopify order.
aloNowRouter.get(
  "/driver/accepted-tour-requests",
  requireStaffAuth,
  async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
      return res.status(503).json({
        ok: false, error: "REQUESTS_DISABLED"
      });
    }

    const staff = getStaffUser(res);

    try {
      const {db} = await import("../database/db.js");

      const result = await db.query(`
        SELECT
          r.id,
          r.workspace,
          r.status,
          r.quote_status,
          r.road_distance_km,
          r.delivery_address,
          r.items,
          r.created_at,
          jsonb_array_length(r.items) AS line_count,
          r.verified_subtotal_chf,
          r.quoted_delivery_fee_chf,
          p.phase AS payment_phase,
          c.status AS checkout_status,
          c.expected_total_chf,
          o.total_chf AS agreed_total_chf,
          NULL::text AS shopify_order_id,
          FALSE AS verified_paid,
          (m.capacity_confirmed_until > NOW())
            AS reservation_active
        FROM public.alo_now_order_requests r
        JOIN public.alo_now_merchant_acceptances m
          ON m.request_id = r.id
        LEFT JOIN public.alo_now_payment_states p
          ON p.request_id = r.id
        LEFT JOIN LATERAL (
          SELECT status, expected_total_chf
          FROM public.alo_now_checkout_attempts ca
          WHERE ca.request_id = r.id
          ORDER BY ca.created_at DESC
          LIMIT 1
        ) c ON TRUE
        LEFT JOIN LATERAL (
          SELECT total_chf
          FROM public.alo_now_manual_offers mo
          WHERE mo.request_id = r.id
          ORDER BY mo.version DESC
          LIMIT 1
        ) o ON TRUE
        WHERE r.workspace = 'AARAU'
          AND r.status = 'CONTACTED'
          AND m.fulfillment_method = 'INTERNAL_DELIVERY'
          AND m.accepted_by = $1
          AND p.phase = 'AWAITING_PAYMENT'
        ORDER BY r.created_at DESC
        LIMIT 30
      `, [String(staff.id)]);

      return res.json({
        ok: true,
        offers: result.rows
      });
    } catch (error) {
      console.error(
        "V3644B ACCEPTED TOUR READ FAILED",
        error instanceof Error ? error.name : "UNKNOWN"
      );
      return res.status(503).json({
        ok: false,
        error: "ACCEPTED_TOUR_UNAVAILABLE"
      });
    }
  }
);

aloNowRouter.get(
  "/driver/order-request-offers",
  requireStaffAuth,
  async (_req,res) => {

    // V3563_GUARDED_DRIVER_RELEASE
    if (process.env.ALO_NOW_MANUAL_DRIVER_DISPATCH_ENABLED !== "true") {
      return res.status(503).json({
        ok: false,
        error: "MANUAL_DRIVER_DISPATCH_NOT_ENABLED"
      });
    }

    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
      return res.status(503).json({ok:false,error:"REQUESTS_DISABLED"});
    }
    const staff=getStaffUser(res);
    try {
      const {db}=await import("../database/db.js");
      const result=await db.query(`
        SELECT r.id,r.workspace,r.road_distance_km,
               r.created_at,
               jsonb_array_length(r.items) AS line_count
        FROM alo_now_order_requests r
        JOIN alo_driver_profiles d ON d.staff_user_id=$1
        WHERE r.status='DRIVER_OFFERED'
          AND r.quote_status='MANUAL_APPROVAL'
          AND d.approved=TRUE
          AND d.availability_status='ONLINE'
          AND d.last_seen_at>NOW()-INTERVAL '3 minutes'
          AND (d.home_workspace='ONLINE' OR d.home_workspace=r.workspace)
          AND r.verified_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM alo_now_manual_offers o
            WHERE o.request_id=r.id
              AND o.version=(
                SELECT MAX(v.version) FROM alo_now_manual_offers v
                WHERE v.request_id=r.id
              )
              AND o.status='ACCEPTED'
              AND o.subtotal_chf=r.verified_subtotal_chf
              AND o.delivery_fee_chf>=12.90
              AND o.extra_fee_chf>=0
              AND o.total_chf=o.subtotal_chf+
                  o.delivery_fee_chf+o.extra_fee_chf
          )
        ORDER BY r.created_at ASC LIMIT 30
      `,[staff.id]);
      res.setHeader("Cache-Control","no-store");
      return res.json({ok:true,offers:result.rows,checkoutAllowed:false});
    } catch (error) {
      console.error("V3557 DRIVER LIST FAILED");
      return res.status(503).json({ok:false,error:"OFFERS_UNAVAILABLE"});
    }
  }
);

aloNowRouter.post(
  "/driver/order-request-offers/:id/accept",
  requireStaffAuth,
  async (req,res) => {

    // V3563_GUARDED_DRIVER_RELEASE
    if (process.env.ALO_NOW_MANUAL_DRIVER_DISPATCH_ENABLED !== "true") {
      return res.status(503).json({
        ok: false,
        error: "MANUAL_DRIVER_DISPATCH_NOT_ENABLED"
      });
    }

    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
      return res.status(503).json({ok:false,error:"REQUESTS_DISABLED"});
    }
    const id=String(req.params.id??"");
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ok:false,error:"INVALID_REQUEST_ID"});
    }
    const staff=getStaffUser(res);
    const {db}=await import("../database/db.js");
    const client=await db.connect();
    try {
      await client.query("BEGIN");
      const driver=await client.query<{
        home_workspace:string;
        max_active_deliveries:number;
        transport_type:string;
      }>(`
        SELECT home_workspace,max_active_deliveries,transport_type
        FROM alo_driver_profiles
        WHERE staff_user_id=$1 AND approved=TRUE
          AND availability_status='ONLINE'
          AND last_seen_at>NOW()-INTERVAL '3 minutes'
        FOR UPDATE
      `,[staff.id]);

      const d=driver.rows[0];
      if (!d) {
        await client.query("ROLLBACK");
        return res.status(409).json({ok:false,error:"DRIVER_NOT_AVAILABLE"});
      }

      const vehicle=String(d.transport_type).toUpperCase();
      const limit=vehicle==="SCOOTER"?2:vehicle==="CAR"?4:0;
      const slots=Math.min(limit,Number(d.max_active_deliveries)||0);

      const capacity=await client.query<{n:number}>(`
        SELECT (
          (SELECT COUNT(*) FROM alo_now_order_requests
           WHERE driver_user_id=$1 AND status='DRIVER_ACCEPTED'
             AND reservation_expires_at>NOW())
          +
          (SELECT COUNT(*) FROM alo_now_deliveries
           WHERE assigned_driver_user_id=$1
             AND delivery_status IN
               ('DRIVER_ASSIGNED','READY_FOR_PICKUP','PICKED_UP','ON_THE_WAY'))
        )::integer AS n
      `,[staff.id]);

      if (slots<1 || Number(capacity.rows[0]?.n??0)>=slots) {
        await client.query("ROLLBACK");
        return res.status(409).json({ok:false,error:"DRIVER_CAPACITY_UNAVAILABLE"});
      }

      const updated=await client.query(`
        UPDATE alo_now_order_requests r
        SET status='DRIVER_ACCEPTED',driver_user_id=$2,
            driver_accepted_at=NOW(),
            reservation_expires_at=NOW()+INTERVAL '10 minutes',
            updated_at=NOW()
        WHERE r.id=$1 AND r.status='DRIVER_OFFERED'
          AND r.quote_status='MANUAL_APPROVAL'
          AND (r.workspace=$3 OR $3='ONLINE')
          AND EXISTS (
            SELECT 1 FROM alo_now_manual_offers o
            WHERE o.request_id=r.id
              AND o.version=(
                SELECT MAX(v.version) FROM alo_now_manual_offers v
                WHERE v.request_id=r.id
              )
              AND o.status='ACCEPTED'
              AND o.subtotal_chf=r.verified_subtotal_chf
              AND o.delivery_fee_chf>=12.90
              AND o.extra_fee_chf>=0
              AND o.total_chf=o.subtotal_chf+
                  o.delivery_fee_chf+o.extra_fee_chf
          )
        RETURNING id,status,workspace,reservation_expires_at
      `,[id,staff.id,d.home_workspace]);

      if (!updated.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ok:false,error:"ALREADY_TAKEN_OR_NOT_ELIGIBLE"});
      }


    // V3586_DRIVER_PAYMENT
    // Separater Feature-Schalter, standardmaessig deaktiviert.
    // Fuehrt keine Shopify-Aktion aus.
    // V3588_REQUIRE_PAYMENT_TRANSITION
    // Ohne Zahlungsuebergang keine erfolgreiche Fahrerannahme.
    // Ein Fehler rollt die bereits begonnene Transaktion zurueck.
    if (
      process.env.ALO_NOW_MANUAL_DRIVER_PAYMENT_ENABLED !== "true"
    ) {
      throw new Error("MANUAL_DRIVER_PAYMENT_DISABLED");
    }

    if (updated.rows[0]) {
      const eligibilityV3586 = await client.query<{
        quote_status: string;
      }>(`
        SELECT r.quote_status
        FROM public.alo_now_order_requests r
        WHERE r.id = $1
          AND r.status = 'DRIVER_ACCEPTED'
          AND r.driver_user_id = $2
          AND r.reservation_expires_at > NOW()
        FOR UPDATE
      `, [id, String(staff.id)]);

      if (eligibilityV3586.rowCount !== 1) {
        throw new Error("DRIVER_RESERVATION_INVALID");
      }

      if (eligibilityV3586.rows[0].quote_status === 'MANUAL_APPROVAL') {
        const acceptedV3586 = await client.query(`
          SELECT 1
          FROM public.alo_now_order_requests r
          JOIN public.alo_now_manual_offers m
            ON m.request_id = r.id
          WHERE r.id = $1
            AND r.verified_at IS NOT NULL
            AND m.version = (
              SELECT MAX(version)
              FROM public.alo_now_manual_offers
              WHERE request_id = r.id
            )
            AND m.status = 'ACCEPTED'
            AND m.subtotal_chf = r.verified_subtotal_chf
            AND m.delivery_fee_chf = 12.90
            AND m.extra_fee_chf >= 0
            AND m.total_chf =
              m.subtotal_chf + m.delivery_fee_chf + m.extra_fee_chf
          LIMIT 1
        `, [id]);

        if (acceptedV3586.rowCount !== 1) {
          throw new Error("LATEST_MANUAL_OFFER_INVALID");
        }

        const merchantV3586 = await client.query(`
          INSERT INTO public.alo_now_merchant_acceptances (
            request_id, fulfillment_method, assigned_driver_id,
            accepted_by, capacity_confirmed_at,
            capacity_confirmed_until
          )
          VALUES (
            $1, 'ASSIGNED_DRIVER', $2, $2,
            NOW(), NOW() + INTERVAL '10 minutes'
          )
          ON CONFLICT (request_id) DO NOTHING
          RETURNING request_id
        `, [id, String(staff.id)]);

        if (merchantV3586.rowCount !== 1) {
          throw new Error("FULFILLMENT_ALREADY_CLAIMED");
        }

        const { randomUUID } = await import("node:crypto");

        const paymentV3586 = await client.query(`
          INSERT INTO public.alo_now_payment_states (
            id, request_id, phase, payment_method
          )
          VALUES ($1, $2, 'AWAITING_PAYMENT', 'ONLINE')
          ON CONFLICT (request_id) DO UPDATE
            SET phase = 'AWAITING_PAYMENT',
                payment_method = 'ONLINE',
                version = alo_now_payment_states.version + 1,
                updated_at = NOW()
          WHERE alo_now_payment_states.phase
                IN ('AWAITING_DRIVER', 'DRIVER_ACCEPTED')
            AND alo_now_payment_states.payment_method IS NULL
          RETURNING request_id
        `, [randomUUID(), id]);

        if (paymentV3586.rowCount !== 1) {
          throw new Error("PAYMENT_STATE_CONFLICT");
        }
      }
    }
      await client.query("COMMIT");
      const checkoutV3590 =
        await prepareCheckoutAfterClaimV3590(id);
      return res.json({
        ok:true,
        request:updated.rows[0],
        checkoutAllowed:false,
        checkoutPrepared:checkoutV3590.prepared
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(()=>undefined);
      console.error("V3557 DRIVER ACCEPT FAILED");
      return res.status(503).json({ok:false,error:"DRIVER_ACCEPT_UNAVAILABLE"});
    } finally {
      client.release();
    }
  }
);


// V3558_APPROVED_DRIVER_HEARTBEAT
// Only refresh an already approved and online driver.
// Never changes availability, approval, payment or assignment.
aloNowRouter.post(
  "/driver/heartbeat",
  requireStaffAuth,
  async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
      return res.status(503).json({
        ok: false,
        error: "ALO_NOW_REQUESTS_NOT_ENABLED"
      });
    }

    const staff = getStaffUser(res);

    try {
      const { db } = await import("../database/db.js");

      const result = await db.query<{last_seen_at: Date}>(`
        UPDATE alo_driver_profiles
        SET last_seen_at = NOW()
        WHERE staff_user_id = $1
          AND approved = TRUE
          AND availability_status = 'ONLINE'
        RETURNING last_seen_at
      `, [staff.id]);

      const row = result.rows[0];

      if (!row) {
        return res.status(409).json({
          ok: false,
          error: "ALO_DRIVER_NOT_APPROVED_OR_OFFLINE"
        });
      }

      return res.json({
        ok: true,
        lastSeenAt: row.last_seen_at
      });
    } catch (_error) {
      console.error("V3558 DRIVER HEARTBEAT FAILED");
      return res.status(503).json({
        ok: false,
        error: "DRIVER_HEARTBEAT_UNAVAILABLE"
      });
    }
  }
);

// V3572_RESTORED_GUARDED_CHECKOUT_ROUTES
aloNowRouter.post(
  "/admin/order-requests/:id/prepare-checkout",
  requireStaffAuth,
  async (req, res) => {
    const staff = getStaffUser(res);

    if (String(staff.role).toUpperCase() !== "ADMIN") {
      return res.status(403).json({
        ok: false,
        error: "ADMIN_REQUIRED"
      });
    }

    if (
      process.env.ALO_NOW_LIVE_DRAFT_CHECKOUT_ENABLED !== "true" ||
      process.env.ALO_NOW_LIVE_CHECKOUT_ORCHESTRATOR_ENABLED !== "true"
    ) {
      return res.status(503).json({
        ok: false,
        error: "CHECKOUT_NOT_RELEASED"
      });
    }

    const requestId = String(req.params.id || "");

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST_ID"
      });
    }

    try {
      const accessToken =
        await getCheckoutShopifyTokenV3062();

      const rawShop =
        aloNowCheckoutEnvV3062.shopify.shop
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, "");

      const shopDomain =
        rawShop.endsWith(".myshopify.com")
          ? rawShop
          : rawShop + ".myshopify.com";

      if (
        !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(
          shopDomain
        )
      ) {
        throw new Error("INVALID_SHOPIFY_DOMAIN");
      }

      const result =
        await createAloNowLiveCheckoutV3060D(
          aloNowCheckoutPoolV3062,
          {
            requestId,
            shopDomain,
            accessToken
          }
        );

      if (!result.ok) {
        return res.status(
          result.status === "RECONCILE" ? 409 : 422
        ).json({
          ok: false,
          status: result.status,
          error: result.reason
        });
      }

      // Zahlungslink wird hier absichtlich NICHT
      // ausgegeben. Nur die geschuetzte Kundenroute
      // darf den gespeicherten Link zurueckgeben.
      return res.json({
        ok: true,
        status: "READY",
        checkoutAllowed: true
      });
    } catch (error) {
      console.error(
        "ALO NOW V3062 CHECKOUT ERROR",
        error instanceof Error
          ? error.message
          : "UNKNOWN_ERROR"
      );

      return res.status(500).json({
        ok: false,
        error: "CHECKOUT_PREPARATION_FAILED"
      });
    }
  }
);

aloNowRouter.post(
  "/order-requests/:id/checkout-link",
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (
      process.env.ALO_NOW_CUSTOMER_CHECKOUT_LINK_ENABLED !== "true"
    ) {
      return res.status(503).json({
        ok: false,
        error: "CUSTOMER_CHECKOUT_NOT_ENABLED"
      });
    }

    const requestId = String(req.params.id ?? "");
    const token = req.body?.statusToken;

    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !uuid.test(requestId) ||
      typeof token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(token)
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CHECKOUT_AUTHORIZATION"
      });
    }

    try {
      const {createHash} = await import("node:crypto");
      const {db} = await import("../database/db.js");

      const tokenHash = createHash("sha256")
        .update(token)
        .digest("hex");

      const result = await db.query<{
        status: string;
        payment_phase: string | null;
        payment_method: string | null;
        checkout_status: string | null;
        invoice_url: string | null;
      }>(`
        SELECT
          r.status,
          p.phase AS payment_phase,
          p.payment_method,
          a.status AS checkout_status,
          a.invoice_url
        FROM public.alo_now_order_requests r
        LEFT JOIN public.alo_now_payment_states p
          ON p.request_id = r.id
        LEFT JOIN LATERAL (
          -- V3517_LATEST_CHECKOUT
          SELECT
            latest_attempt.status,
            latest_attempt.invoice_url,
            latest_attempt.expected_total_chf
          FROM public.alo_now_checkout_attempts latest_attempt
          WHERE latest_attempt.request_id = r.id
          ORDER BY latest_attempt.created_at DESC,
                   latest_attempt.checkout_reference DESC
          LIMIT 1
        ) a ON TRUE
        WHERE r.id = $1
          -- V3582_CHECKOUT_RESERVATION_GUARD
          AND (
            (
              r.status = 'DRIVER_ACCEPTED'
              AND r.driver_user_id IS NOT NULL
              AND r.reservation_expires_at > NOW()
            )
            OR (
              r.status IN ('PENDING_REVIEW', 'CONTACTED')
              AND r.driver_user_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM public.alo_now_merchant_acceptances mi
                WHERE mi.request_id = r.id
                  AND mi.fulfillment_method = 'INTERNAL_DELIVERY'
                  AND mi.assigned_driver_id IS NULL
                  AND btrim(mi.accepted_by) <> ''
                  AND mi.capacity_confirmed_at <= NOW()
                  AND (mi.capacity_confirmed_until > NOW() OR (
  r.status = 'CONTACTED'
  AND r.quote_status = 'MANUAL_APPROVAL'
  AND r.driver_user_id IS NULL
  AND r.verified_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.alo_now_manual_offers recovery_offer
    WHERE recovery_offer.request_id = r.id
      AND recovery_offer.status = 'ACCEPTED'
      AND recovery_offer.version = (
        SELECT MAX(recovery_latest.version)
        FROM public.alo_now_manual_offers recovery_latest
        WHERE recovery_latest.request_id = r.id
      )
      AND recovery_offer.subtotal_chf =
          r.verified_subtotal_chf
      AND recovery_offer.delivery_fee_chf = 12.90
      AND recovery_offer.extra_fee_chf >= 0
      AND recovery_offer.total_chf =
          recovery_offer.subtotal_chf
          + recovery_offer.delivery_fee_chf
          + recovery_offer.extra_fee_chf
  )
))
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.alo_now_merchant_acceptances merchant
            WHERE merchant.request_id = r.id
              AND merchant.capacity_confirmed_until <= NOW()
AND NOT (
  r.status = 'CONTACTED'
  AND r.quote_status = 'MANUAL_APPROVAL'
  AND r.driver_user_id IS NULL
  AND r.verified_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.alo_now_manual_offers recovery_offer
    WHERE recovery_offer.request_id = r.id
      AND recovery_offer.status = 'ACCEPTED'
      AND recovery_offer.version = (
        SELECT MAX(recovery_latest.version)
        FROM public.alo_now_manual_offers recovery_latest
        WHERE recovery_latest.request_id = r.id
      )
      AND recovery_offer.subtotal_chf =
          r.verified_subtotal_chf
      AND recovery_offer.delivery_fee_chf = 12.90
      AND recovery_offer.extra_fee_chf >= 0
      AND recovery_offer.total_chf =
          recovery_offer.subtotal_chf
          + recovery_offer.delivery_fee_chf
          + recovery_offer.extra_fee_chf
  )
)
          )
          AND r.customer_status_token_hash = $2
          AND r.workspace = 'AARAU'
          AND a.status = 'READY'
          AND a.invoice_url IS NOT NULL
          AND length(a.invoice_url) > 8
          AND a.expected_total_chf::numeric = (
                CASE
                  WHEN r.quote_status = 'STANDARD'
                    AND r.verified_at IS NOT NULL
                    AND r.verified_subtotal_chf > 0
                    AND r.quoted_delivery_fee_chf = 12.90
                  THEN
                    r.verified_subtotal_chf
                    + r.quoted_delivery_fee_chf

                  WHEN r.quote_status = 'MANUAL_APPROVAL'
                    AND r.verified_at IS NOT NULL
                  THEN (
                    SELECT mo.total_chf
                    FROM public.alo_now_manual_offers mo
                    WHERE mo.request_id = r.id
                      AND mo.version = (
                        SELECT MAX(latest.version)
                        FROM public.alo_now_manual_offers latest
                        WHERE latest.request_id = r.id
                      )
                      AND mo.status = 'ACCEPTED'
                      AND mo.subtotal_chf =
                          r.verified_subtotal_chf
                      AND mo.delivery_fee_chf = 12.90
                      AND mo.extra_fee_chf >= 0
                      AND mo.total_chf =
                          mo.subtotal_chf
                          + mo.delivery_fee_chf
                          + mo.extra_fee_chf
                    LIMIT 1
                  )
                  ELSE NULL
                END
              )
          -- V3503_CUSTOMER_INTERNAL_CHECKOUT
          AND (
            (
              r.status = 'DRIVER_ACCEPTED'
              AND r.driver_user_id IS NOT NULL
              AND r.reservation_expires_at > clock_timestamp()
            )
            OR (
              r.status IN ('PENDING_REVIEW', 'CONTACTED')
              AND EXISTS (
                SELECT 1
                FROM public.alo_now_merchant_acceptances m
                WHERE m.request_id = r.id
                  AND m.fulfillment_method = 'INTERNAL_DELIVERY'
                  AND m.capacity_confirmed_at <= clock_timestamp()
                  AND (m.capacity_confirmed_until > clock_timestamp() OR (
  r.status = 'CONTACTED'
  AND r.quote_status = 'MANUAL_APPROVAL'
  AND r.driver_user_id IS NULL
  AND r.verified_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.alo_now_manual_offers recovery_offer
    WHERE recovery_offer.request_id = r.id
      AND recovery_offer.status = 'ACCEPTED'
      AND recovery_offer.version = (
        SELECT MAX(recovery_latest.version)
        FROM public.alo_now_manual_offers recovery_latest
        WHERE recovery_latest.request_id = r.id
      )
      AND recovery_offer.subtotal_chf =
          r.verified_subtotal_chf
      AND recovery_offer.delivery_fee_chf = 12.90
      AND recovery_offer.extra_fee_chf >= 0
      AND recovery_offer.total_chf =
          recovery_offer.subtotal_chf
          + recovery_offer.delivery_fee_chf
          + recovery_offer.extra_fee_chf
  )
))
                  AND btrim(m.accepted_by) <> ''
                  AND m.assigned_driver_id IS NULL
              )
              AND (
                r.quote_status = 'STANDARD'
                OR (
                  r.quote_status = 'MANUAL_APPROVAL'
                  AND r.verified_at IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM public.alo_now_manual_offers mo
                    WHERE mo.request_id = r.id
                      AND mo.status = 'ACCEPTED'
                      AND mo.version = (
                        SELECT MAX(latest.version)
                        FROM public.alo_now_manual_offers latest
                        WHERE latest.request_id = r.id
                      )
                      AND mo.subtotal_chf = r.verified_subtotal_chf
                      AND mo.delivery_fee_chf = 12.90
                      AND mo.extra_fee_chf >= 0
                      AND mo.total_chf =
                          mo.subtotal_chf
                          + mo.delivery_fee_chf
                          + mo.extra_fee_chf
                  )
                )
              )
            )
          )
        LIMIT 1
      `, [requestId, tokenHash]);

      const row = result.rows[0];

      if (!row) {
        return res.status(404).json({
          ok: false,
          error: "CHECKOUT_NOT_AVAILABLE"
        });
      }

      if (
        row.payment_phase !== "AWAITING_PAYMENT" ||
        row.payment_method !== "ONLINE" ||
        row.checkout_status !== "READY" ||
        !row.invoice_url
      ) {
        return res.status(409).json({
          ok: false,
          error: "CHECKOUT_NOT_READY"
        });
      }

      let url: URL;

      try {
        url = new URL(row.invoice_url);
      } catch {
        return res.status(503).json({
          ok: false,
          error: "INVALID_STORED_CHECKOUT_LINK"
        });
      }

      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        row.invoice_url.length > 2048
      ) {
        return res.status(503).json({
          ok: false,
          error: "INVALID_STORED_CHECKOUT_LINK"
        });
      }

      return res.json({
        ok: true,
        requestId,
        checkoutAllowed: true,
        checkoutUrl: row.invoice_url,
        paymentConfirmed: false,
        message: "Shopify-Zahlungsseite bereit."
      });

    } catch (error) {
      console.error(
        "ALO NOW CUSTOMER CHECKOUT LINK FAILED",
        error instanceof Error ? error.name : "UNKNOWN"
      );

      return res.status(503).json({
        ok: false,
        error: "CHECKOUT_LINK_UNAVAILABLE"
      });
    }
  }
);


// V3590_CHECKOUT_AFTER_CLAIM
// Feature standardmaessig AUS.
// Shopify-Aktion ausschliesslich nach Datenbank-COMMIT.
async function prepareCheckoutAfterClaimV3590(
  requestId: string
): Promise<{attempted: boolean; prepared: boolean}> {
  if (
    process.env.ALO_NOW_AUTO_CHECKOUT_AFTER_CLAIM_ENABLED !== "true" ||
    process.env.ALO_NOW_LIVE_DRAFT_CHECKOUT_ENABLED !== "true" ||
    process.env.ALO_NOW_LIVE_CHECKOUT_ORCHESTRATOR_ENABLED !== "true"
  ) {
    return {attempted: false, prepared: false};
  }

  try {
    const accessToken =
      await getCheckoutShopifyTokenV3062();

    const rawShop =
      aloNowCheckoutEnvV3062.shopify.shop
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");

    const shopDomain =
      rawShop.endsWith(".myshopify.com")
        ? rawShop
        : rawShop + ".myshopify.com";

    if (
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(
        shopDomain
      )
    ) {
      throw new Error("INVALID_SHOPIFY_DOMAIN");
    }

    const result =
      await createAloNowLiveCheckoutV3060D(
        aloNowCheckoutPoolV3062,
        {
          requestId,
          shopDomain,
          accessToken
        }
      );

    if (!result.ok) {
      console.error(
        "ALO NOW V3590 CHECKOUT NOT READY",
        result.reason
      );

      return {attempted: true, prepared: false};
    }

    return {attempted: true, prepared: true};
  } catch (error) {
    console.error(
      "ALO NOW V3590 CHECKOUT FAILED",
      error instanceof Error ? error.name : "UNKNOWN"
    );

    return {attempted: true, prepared: false};
  }
}

// V3579_ATOMIC_SELF_ASSIGNMENT
// Separater, deaktivierter Übernahmeweg.
// Erst Übernahme und Zahlungsstatus committen; Shopify separat vorbereiten.
aloNowRouter.post(
  "/admin/order-requests/:id/self-assign",
  requireStaffAuth,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (
      process.env.ALO_NOW_REQUESTS_ENABLED !== "true" ||
      process.env.ALO_NOW_MANUAL_OFFERS_ENABLED !== "true" ||
      process.env.ALO_NOW_ATOMIC_SELF_ASSIGN_ENABLED !== "true"
    ) {
      return res.status(503).json({
        ok: false, error: "SELF_ASSIGN_DISABLED"
      });
    }

    const staff = getStaffUser(res);
    const role = String(staff.role ?? "").toUpperCase();
    if (role !== "ADMIN" && role !== "MANAGER") {
      return res.status(403).json({
        ok: false, error: "FORBIDDEN"
      });
    }

    const id = String(req.params.id ?? "");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!uuid.test(id)) {
      return res.status(400).json({
        ok: false, error: "INVALID_REQUEST_ID"
      });
    }

    const staffId = String(staff.id);
    const allowedWorkspaces = role === "ADMIN"
      ? ["AARAU", "OLTEN"]
      : (staff.allowedWorkspaces ?? []).filter(
          (w: string) => w === "AARAU" || w === "OLTEN"
        );

    if (allowedWorkspaces.length === 0) {
      return res.status(403).json({
        ok: false, error: "NO_WORKSPACE_ACCESS"
      });
    }

    const { db } = await import("../database/db.js");
    const { randomUUID } = await import("node:crypto");
    const client = await db.connect();
    let transaction = false;

    try {
      await client.query("BEGIN");
      transaction = true;
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '12s'");

      // Die Anfrage ist unser gemeinsamer Lock für konkurrierende Aktionen.
      const requestResult = await client.query<{
        status: string;
        quote_status: string;
        verified_at: Date | null;
        verified_subtotal_chf: string;
        driver_user_id: string | null;
      }>(`
        SELECT status, quote_status, verified_at,
               verified_subtotal_chf, driver_user_id
        FROM public.alo_now_order_requests
        WHERE id = $1
          AND workspace = ANY($2::text[])
        FOR UPDATE
      `, [id, allowedWorkspaces]);

      const request = requestResult.rows[0];

      if (!request) {
        await client.query("ROLLBACK");
        transaction = false;
        return res.status(404).json({
          ok: false, error: "REQUEST_NOT_FOUND"
        });
      }

      if (
        !["PENDING_REVIEW", "CONTACTED"].includes(request.status) ||
        request.quote_status !== "MANUAL_APPROVAL" ||
        !request.verified_at ||
        request.driver_user_id !== null
      ) {
        await client.query("ROLLBACK");
        transaction = false;
        return res.status(409).json({
          ok: false, error: "REQUEST_NOT_ELIGIBLE"
        });
      }

      // Ausschliesslich das NEUESTE Angebot zählt.
      const offerResult = await client.query<{
        status: string;
        total_chf: string;
      }>(`
        SELECT status, total_chf::text
        FROM public.alo_now_manual_offers
        WHERE request_id = $1
          AND version = (
            SELECT MAX(version)
            FROM public.alo_now_manual_offers
            WHERE request_id = $1
          )
          AND status = 'ACCEPTED'
          AND subtotal_chf = $2::numeric
          AND delivery_fee_chf = 12.90
          AND extra_fee_chf >= 0
          AND total_chf =
              subtotal_chf + delivery_fee_chf + extra_fee_chf
        LIMIT 1
      `, [id, request.verified_subtotal_chf]);

      const offer = offerResult.rows[0];

      if (!offer) {
        await client.query("ROLLBACK");
        transaction = false;
        return res.status(409).json({
          ok: false, error: "LATEST_OFFER_NOT_ACCEPTED"
        });
      }

      // Frühere Zuweisungen und Zahlungsversuche nicht überschreiben.
      const existing = await client.query<{
        acceptance_exists: boolean;
        payment_blocked: boolean;
        checkout_exists: boolean;
      }>(`
        SELECT
          EXISTS (
            SELECT 1 FROM public.alo_now_merchant_acceptances
            WHERE request_id = $1
          ) AS acceptance_exists,
          EXISTS (
            SELECT 1 FROM public.alo_now_payment_states
            WHERE request_id = $1
              AND (
                phase NOT IN ('AWAITING_DRIVER', 'DRIVER_ACCEPTED')
                OR payment_method IS NOT NULL
              )
          ) AS payment_blocked,
          EXISTS (
            SELECT 1 FROM public.alo_now_checkout_attempts
            WHERE request_id = $1
          ) AS checkout_exists
      `, [id]);

      const prior = existing.rows[0];

      if (
        !prior ||
        prior.acceptance_exists ||
        prior.payment_blocked ||
        prior.checkout_exists
      ) {
        await client.query("ROLLBACK");
        transaction = false;
        return res.status(409).json({
          ok: false, error: "ASSIGNMENT_OR_PAYMENT_EXISTS"
        });
      }

      // Die übernehmende Person wird gespeichert.
      // INTERN erlaubt laut vorhandenem Schema keine assigned_driver_id.
      await client.query(`
        INSERT INTO public.alo_now_merchant_acceptances (
          request_id, fulfillment_method, assigned_driver_id,
          accepted_by, capacity_confirmed_at,
          capacity_confirmed_until
        )
        VALUES (
          $1, 'INTERNAL_DELIVERY', NULL, $2,
          NOW(), NOW() + INTERVAL '15 minutes'
        )
      `, [id, staffId]);

      await client.query(`
        UPDATE public.alo_now_order_requests
        -- V3593_INTERNAL_FULFILLMENT_FIX
        -- Verantwortlicher bleibt in merchant_acceptances.accepted_by.
        -- Keine Fahrer-ID und kein DRIVER_ACCEPTED-Status.
        SET status = 'CONTACTED',
            driver_user_id = NULL,
            driver_accepted_at = NULL,
            reservation_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND status IN ('PENDING_REVIEW', 'CONTACTED')
      `, [id]);

      // Noch keine Zahlung: Nur Erlaubnis, Checkout vorzubereiten.
      // V3581_PAYMENT_STATE_TRANSITION
      // Bestehende Vorstufen atomar aktualisieren;
      // nie bestätigte, abgelaufene oder stornierte Zahlungen.
      const paymentUpdate = await client.query(`
        UPDATE public.alo_now_payment_states
        SET phase = 'AWAITING_PAYMENT',
            payment_method = 'ONLINE',
            version = version + 1,
            updated_at = NOW()
        WHERE request_id = $1
          AND phase IN ('AWAITING_DRIVER', 'DRIVER_ACCEPTED')
          AND payment_method IS NULL
        RETURNING request_id
      `, [id]);

      if (paymentUpdate.rowCount === 0) {
        const paymentCheck = await client.query(`
          SELECT 1
          FROM public.alo_now_payment_states
          WHERE request_id = $1
          LIMIT 1
        `, [id]);

        if (paymentCheck.rowCount !== 0) {
          throw new Error('PAYMENT_STATE_CONFLICT');
        }

        await client.query(`
          INSERT INTO public.alo_now_payment_states (
            id, request_id, phase, payment_method
          )
          VALUES ($1, $2, 'AWAITING_PAYMENT', 'ONLINE')
        `, [randomUUID(), id]);
      }

      await client.query("COMMIT");
      transaction = false;
      const checkoutV3590 =
        await prepareCheckoutAfterClaimV3590(id);

      return res.json({
        ok: true,
        action: "SELF_ASSIGNED",
        status: "CONTACTED",
        paymentPhase: "AWAITING_PAYMENT",
        amountCHF: offer.total_chf,
        checkoutAllowed: false,
        checkoutPrepared: checkoutV3590.prepared
      });
    } catch (error) {
      if (transaction) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      console.error(
        "ALO NOW SELF ASSIGN FAILED",
        error instanceof Error ? error.name : "UNKNOWN"
      );
      return res.status(503).json({
        ok: false, error: "SELF_ASSIGN_UNAVAILABLE"
      });
    } finally {
      client.release();
    }
  }
);
