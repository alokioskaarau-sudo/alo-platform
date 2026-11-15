import { Router } from "express";
import { db } from "../database/db.js";
import { requireStaffAuth } from "../middleware/staffAuth.js";

import { getStaffUser } from "../middleware/staffAuth.js";
import { getShopifyOrderById } from "../integrations/shopify/orders.js";
import { getStaffOrderChannel } from "../modules/orders/orderFulfillmentType.js";
import { getOrderFulfillmentWorkflow, setOrderPackStatus } from "../database/orderFulfillmentWorkflow.js";
import { isPickupOrderFullyPacked } from "../database/orderPackItems.js";

import { fulfillShopifyPickupOrder } from "../modules/shipping/fulfillment.service.js";
import { getFulfillmentOrdersForOrder } from "../integrations/shopify/fulfillment.js";
import { verifyPickupFullyFulfilled } from "../modules/shipping/pickupCore.js";

// ALO_PICKUP_ROUTER_V1
const pickupRouter = Router();

// ALO_PICKUP_PRECHECK_V1
pickupRouter.post(
  "/:orderId/confirm-pickup",
  requireStaffAuth,
  async (req, res) => {
    try {
      // ALO_PICKUP_SAFETY_GATE_V2
      if (process.env.ALO_PICKUP_CONFIRM_ENABLED !== "true") {
        return res.status(503).json({
          ok: false,
          error: "PICKUP_SAFETY_REVIEW",
        });
      }

      if (req.body?.confirmHandover !== true) {
        return res.status(400).json({
          ok: false,
          error: "HANDOVER_CONFIRMATION_REQUIRED",
        });
      }

      const orderId = String(req.params.orderId ?? "");

      if (!/^[0-9]+$/.test(orderId)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_ORDER_ID",
        });
      }

      // ALO_PICKUP_LOCK_V1
      const lockClient = await db.connect();
      let locked = false;

      try {
        const lock = await lockClient.query(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
          ["staff-order-fulfillment:" + orderId]
        );

        locked = lock.rows[0]?.locked === true;

        if (!locked) {
          return res.status(409).json({
            ok: false,
            error: "ORDER_ALREADY_PROCESSING",
          });
        }

      const staffUser = getStaffUser(res);
      const order = await getShopifyOrderById(orderId);

      if (!order || getStaffOrderChannel(order) !== "PICKUP") {
        return res.status(409).json({
          ok: false,
          error: "NOT_PICKUP",
        });
      }

      if (
        order.cancelledAt ||
        String(order.displayFinancialStatus).toUpperCase() !== "PAID"
      ) {
        return res.status(409).json({
          ok: false,
          error: "ORDER_NOT_PAID_OR_CANCELLED",
        });
      }

      const workflow = await getOrderFulfillmentWorkflow(orderId);

      if (
        !workflow ||
        workflow.claimed_by_staff_user_id !== staffUser.id ||
        !["READY_TO_SHIP", "COMPLETED"].includes(workflow.pack_status)
      ) {
        return res.status(409).json({
          ok: false,
          error: "PICKUP_NOT_READY",
        });
      }

      if (!(await isPickupOrderFullyPacked(orderId))) {
        return res.status(409).json({
          ok: false,
          error: "PICKUP_NOT_FULLY_PACKED",
        });
      }


      // ALO_PICKUP_COMPLETE_V1
      await fulfillShopifyPickupOrder(order);
      // ALO_PICKUP_VERIFIED_QUANTITIES_V1
      const verified = await getShopifyOrderById(orderId);
      if (!verified || verified.displayFulfillmentStatus !== "FULFILLED")
        throw new Error("PICKUP_SHOPIFY_NOT_CONFIRMED");

      const verifiedFulfillments =
        await getFulfillmentOrdersForOrder(order.id);

      verifyPickupFullyFulfilled(verifiedFulfillments);
      const completed = workflow.pack_status === "COMPLETED"
        ? workflow
        : await setOrderPackStatus(orderId, staffUser.id, "COMPLETED");
      if (!completed || completed.pack_status !== "COMPLETED")
        throw new Error("PICKUP_LOCAL_COMPLETION_FAILED");
      return res.json({ok:true,fulfillmentType:"PICKUP",status:"COMPLETED",workflow:completed});
      } finally {
        try {
          if (locked) {
            await lockClient.query(
              "SELECT pg_advisory_unlock(hashtext($1))",
              ["staff-order-fulfillment:" + orderId]
            );
          }
        } finally {
          lockClient.release();
        }
      }
    } catch (error) {
      console.error("PICKUP PRECHECK ERROR", error);

      return res.status(500).json({
        ok: false,
        error: "PICKUP_PRECHECK_FAILED",
      });
    }
  }
);

export default pickupRouter;
