import { Router } from "express";
import { db } from "../database/db.js";
import {
  getShopifyOrderById,
} from "../integrations/shopify/orders.js";

import {
  fulfillShopifyOrderWithSwissPostTracking,
} from "../modules/shipping/fulfillment.service.js";
import {
  syncOrderPackItems,
  adjustOrderPackItem,
  getOrderPackItems,
  isOrderFullyPacked,
} from "../database/orderPackItems.js";

import {
  getStaffUser,
  requireStaffAuth,
} from "../middleware/staffAuth.js";

import {
  getOrderDashboard,
} from "../database/shippingDashboard.js";
import {
  claimOrderForPacking,
  releaseOrderClaim,
  setOrderPackStatus,
  getOrderFulfillmentWorkflows,
  getOrderFulfillmentWorkflow,
  type OrderPackStatus,
} from "../database/orderFulfillmentWorkflow.js";

const router = Router();

/*
 * ALO STAFF – BESTELLMANAGER
 *
 * Eigene Staff-API.
 * Verwendet dieselben Bestelldaten wie die bestehende
 * Bestellzentrale, aber mit Staff-Bearer-Authentifizierung.
 */

router.get(
  "/",
  requireStaffAuth,
  async (_req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const dashboardOrders =
        await getOrderDashboard(500);

      const workflows =
        await getOrderFulfillmentWorkflows(
          dashboardOrders.map(
            (order) => order.shopify_order_id
          )
        );

      const workflowByOrderId =
        new Map(
          workflows.map((workflow) => [
            workflow.shopify_order_id,
            workflow,
          ])
        );

      const orders =
        dashboardOrders.map((order) => ({
          ...order,
          fulfillment_workflow:
            workflowByOrderId.get(
              order.shopify_order_id
            ) ?? null,
        }));

      const stats = {
        total:
          orders.length,

        current:
          orders.filter(
            (order) =>
              order.dashboard_status ===
              "CURRENT"
          ).length,

        completed:
          orders.filter(
            (order) =>
              order.dashboard_status ===
              "COMPLETED"
          ).length,

        error:
          orders.filter(
            (order) =>
              order.dashboard_status ===
              "ERROR"
          ).length,

        archived:
          orders.filter(
            (order) =>
              order.dashboard_status ===
              "ARCHIVED"
          ).length,
      };

      res.json({
        ok: true,

        staff: {
          id:
            staffUser.id,
          displayName:
            staffUser.displayName,
          role:
            staffUser.role,
        },

        stats,
        orders,
      });
    } catch (error) {
      console.error(
        "STAFF ORDERS LIST ERROR",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Bestellungen konnten nicht geladen werden.",
      });
    }
  }
);


/*
 * Bestellung zum Packen übernehmen.
 *
 * Die Staff-ID kommt ausschliesslich aus dem
 * authentifizierten Bearer-Token.
 */

/*
 * ALO STAFF – BESTELLDETAIL
 *
 * Führt Shopify-Bestelldaten, technische Dokumentdaten
 * der Bestellzentrale und den operativen Packworkflow
 * in einer Antwort zusammen.
 *
 * Read-only:
 * - kein Label
 * - kein Fulfillment
 * - kein Druckjob
 * - keine Statusänderung
 */
router.get(
  "/:orderId",
  requireStaffAuth,
  async (req, res) => {
    try {
      const orderId = String(
        req.params.orderId || ""
      ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_ID_REQUIRED",
        });
      }

      const [
        shopifyOrder,
        dashboardOrders,
        workflow,
      ] = await Promise.all([
        getShopifyOrderById(orderId),
        getOrderDashboard(500),
        getOrderFulfillmentWorkflow(orderId),
      ]);

      if (!shopifyOrder) {
        return res.status(404).json({
          ok: false,
          error: "ORDER_NOT_FOUND",
        });
      }

      const normalizedOrderId =
        String(shopifyOrder.id);

      const dashboardOrder =
        dashboardOrders.find(
          (order) =>
            order.shopify_order_id ===
            normalizedOrderId
        ) ?? null;

      const lineItems =
        (
          shopifyOrder.lineItems?.edges ??
          []
        ).map(
          (edge: any) => edge.node
        );

      const packItems =
        await syncOrderPackItems(
          normalizedOrderId,
          lineItems
        );

      const packProgress =
        packItems.reduce(
          (
            progress,
            item
          ) => {
            progress.expected +=
              item.expected_quantity;

            progress.packed +=
              item.packed_quantity;

            return progress;
          },
          {
            expected: 0,
            packed: 0,
          }
        );

      const packComplete =
        packProgress.expected > 0 &&
        packProgress.packed ===
          packProgress.expected;

      return res.json({
        ok: true,

        order: {
          ...shopifyOrder,

          lineItems,

          pack_items:
            packItems,

          pack_progress: {
            packed:
              packProgress.packed,
            expected:
              packProgress.expected,
            complete:
              packComplete,
          },

          fulfillment_workflow:
            workflow,

          dashboard:
            dashboardOrder,
        },
      });
    } catch (error) {
      console.error(
        "STAFF ORDER DETAIL ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestelldetails konnten nicht geladen werden.",
      });
    }
  }
);


router.post(
  "/:orderId/claim",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const orderId = String(
        req.params.orderId || ""
      ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_ID_REQUIRED",
        });
      }

      const result =
        await claimOrderForPacking(
          orderId,
          staffUser.id
        );

      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          error: "ORDER_ALREADY_CLAIMED",
          workflow: result.workflow,
        });
      }

      return res.json({
        ok: true,
        alreadyClaimedByMe:
          result.alreadyClaimedByMe,
        workflow: result.workflow,
      });
    } catch (error) {
      console.error(
        "STAFF ORDER CLAIM ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestellung konnte nicht übernommen werden.",
      });
    }
  }
);


/*
 * Eigene Übernahme wieder freigeben.
 *
 * releaseOrderClaim() erlaubt das nur dem
 * Mitarbeiter, der die Bestellung besitzt.
 */
router.post(
  "/:orderId/release",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const orderId = String(
        req.params.orderId || ""
      ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_ID_REQUIRED",
        });
      }

      const workflow =
        await releaseOrderClaim(
          orderId,
          staffUser.id
        );

      if (!workflow) {
        return res.status(409).json({
          ok: false,
          error:
            "ORDER_RELEASE_NOT_ALLOWED",
        });
      }

      return res.json({
        ok: true,
        workflow,
      });
    } catch (error) {
      console.error(
        "STAFF ORDER RELEASE ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestellung konnte nicht freigegeben werden.",
      });
    }
  }
);


/*
 * Operativen Packstatus ändern.
 *
 * Dieser Status ist bewusst getrennt vom
 * dashboard_status der Bestellzentrale.
 */

/*
 * Einzelne Packposition atomar +1 / -1.
 *
 * Nur der Mitarbeiter, der die Bestellung
 * übernommen hat, darf Packmengen verändern.
 */
router.post(
  "/:orderId/items/:lineItemId/adjust",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);

      const orderId = String(
        req.params.orderId || ""
      ).trim();

      const lineItemId = String(
        req.params.lineItemId || ""
      ).trim();

      const delta =
        Number(req.body?.delta);

      if (!orderId || !lineItemId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_OR_ITEM_ID_REQUIRED",
        });
      }

      if (delta !== 1 && delta !== -1) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PACK_DELTA",
          allowed: [1, -1],
        });
      }

      const result =
        await adjustOrderPackItem(
          orderId,
          lineItemId,
          staffUser.id,
          delta
        );

      if (!result.ok) {
        const status =
          result.reason === "ITEM_NOT_FOUND"
            ? 404
            : 409;

        return res.status(status).json({
          ok: false,
          error: result.reason,
        });
      }

      const packItems =
        await getOrderPackItems(orderId);

      const progress =
        packItems.reduce(
          (
            value,
            item
          ) => {
            value.expected +=
              item.expected_quantity;

            value.packed +=
              item.packed_quantity;

            return value;
          },
          {
            expected: 0,
            packed: 0,
          }
        );

      return res.json({
        ok: true,

        item: result.item,

        pack_progress: {
          packed:
            progress.packed,

          expected:
            progress.expected,

          complete:
            progress.expected > 0 &&
            progress.packed ===
              progress.expected,
        },
      });
    } catch (error) {
      console.error(
        "STAFF PACK ITEM ADJUST ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Packmenge konnte nicht geändert werden.",
      });
    }
  }
);


router.patch(
  "/:orderId/status",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser = getStaffUser(res);
      const orderId = String(
        req.params.orderId || ""
      ).trim();

      if (!orderId) {
        return res.status(400).json({
          ok: false,
          error: "ORDER_ID_REQUIRED",
        });
      }

      // NEW -> PACKING wird ausschließlich durch
      // POST /:orderId/claim ausgelöst.
      //
      // Die Status-API darf nur die nachfolgenden
      // operativen Schritte auslösen.
      const allowedStatuses:
        OrderPackStatus[] = [
          "PACKED",
          "READY_TO_SHIP",
          ];

      const status = String(
        req.body?.status || ""
      ).trim() as OrderPackStatus;

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_PACK_STATUS",
          allowedStatuses,
        });
      }

      if (
        status === "PACKED" ||
        status === "READY_TO_SHIP"
      ) {
        const fullyPacked =
          await isOrderFullyPacked(
            orderId
          );

        if (!fullyPacked) {
          const packItems =
            await getOrderPackItems(
              orderId
            );

          const progress =
            packItems.reduce(
              (
                value,
                item
              ) => {
                value.expected +=
                  item.expected_quantity;

                value.packed +=
                  item.packed_quantity;

                return value;
              },
              {
                expected: 0,
                packed: 0,
              }
            );

          return res.status(409).json({
            ok: false,
            error:
              "ORDER_NOT_FULLY_PACKED",

            pack_progress: {
              packed:
                progress.packed,

              expected:
                progress.expected,

              complete: false,
            },
          });
        }
      }

      let workflow =
        await getOrderFulfillmentWorkflow(
          orderId
        );

      if (!workflow) {
        return res.status(409).json({
          ok: false,
          error:
            "ORDER_WORKFLOW_NOT_FOUND",
        });
      }

      // ------------------------------------------------------
      // PACKED
      // ------------------------------------------------------

      if (status === "PACKED") {
        const packedWorkflow =
          await setOrderPackStatus(
            orderId,
            staffUser.id,
            "PACKED"
          );

        if (!packedWorkflow) {
          return res.status(409).json({
            ok: false,
            error:
              "ORDER_STATUS_CHANGE_NOT_ALLOWED",
          });
        }

        return res.json({
          ok: true,
          workflow:
            packedWorkflow,
        });
      }

      // ------------------------------------------------------
      // READY_TO_SHIP
      //
      // Erster Versuch:
      // PACKED -> READY_TO_SHIP
      //
      // Retry:
      // Ist die Order bereits READY_TO_SHIP, wird die
      // Transition nicht erneut ausgeführt. Stattdessen wird
      // direkt der idempotente Shopify-Fulfillment-Schritt
      // erneut versucht.
      // ------------------------------------------------------

      if (
        workflow.pack_status !==
        "READY_TO_SHIP"
      ) {
        const readyWorkflow =
          await setOrderPackStatus(
            orderId,
            staffUser.id,
            "READY_TO_SHIP"
          );

        if (!readyWorkflow) {
          return res.status(409).json({
            ok: false,
            error:
              "ORDER_STATUS_CHANGE_NOT_ALLOWED",
          });
        }

        workflow =
          readyWorkflow;
      } else if (
        workflow.claimed_by_staff_user_id !==
        staffUser.id
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "ORDER_NOT_CLAIMED_BY_STAFF",
        });
      }

      // ------------------------------------------------------
      // SHOPIFY + SWISS POST TRACKING
      //
      // Pro Order darf immer nur EIN Fulfillment-Versuch
      // gleichzeitig laufen.
      // ------------------------------------------------------

      const fulfillmentLockClient =
        await db.connect();

      const fulfillmentLockKey =
        `staff-order-fulfillment:${orderId}`;

      let fulfillmentLockAcquired =
        false;

      try {
        const lockResult =
          await fulfillmentLockClient.query(
            `
              SELECT pg_try_advisory_lock(
                hashtext($1)
              ) AS locked
            `,
            [
              fulfillmentLockKey,
            ]
          );

        fulfillmentLockAcquired =
          lockResult.rows[0]?.locked === true;

        if (!fulfillmentLockAcquired) {
          return res.status(409).json({
            ok: false,
            error:
              "ORDER_SHIPPING_IN_PROGRESS",
            workflow,
            retryable: true,
          });
        }

        // ----------------------------------------------------
        // Shopify IMMER frisch lesen.
        //
        // Wichtig für Retry-Fälle:
        // Falls Shopify bereits fulfilled wurde, aber unser
        // lokales COMPLETED danach fehlgeschlagen ist, darf
        // kein zweites Fulfillment erstellt werden.
        // ----------------------------------------------------

        let shopifyOrder =
          await getShopifyOrderById(
            orderId
          );

        if (!shopifyOrder) {
          return res.status(502).json({
            ok: false,
            error:
              "SHOPIFY_ORDER_NOT_FOUND",
            workflow,
            retryable: true,
          });
        }

        if (
          String(
            shopifyOrder.displayFinancialStatus ??
              ""
          ).toUpperCase() !== "PAID"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "SHOPIFY_ORDER_NOT_PAID",
            workflow,
            retryable: false,
          });
        }

        let fulfillment: any = null;

        const alreadyFulfilled =
          String(
            shopifyOrder.displayFulfillmentStatus ??
              ""
          ).toUpperCase() === "FULFILLED";

        if (!alreadyFulfilled) {
          fulfillment =
            await fulfillShopifyOrderWithSwissPostTracking(
              shopifyOrder
            );

          // --------------------------------------------------
          // Niemals aufgrund des Helper-Returns alleine lokal
          // abschließen. Shopify erneut laden und den echten
          // finalen Order-Status prüfen.
          // --------------------------------------------------

          shopifyOrder =
            await getShopifyOrderById(
              orderId
            );

          if (!shopifyOrder) {
            return res.status(502).json({
              ok: false,
              error:
                "SHOPIFY_ORDER_VERIFY_FAILED",
              workflow,
              fulfillment,
              retryable: true,
            });
          }
        }

        const verifiedFulfillmentStatus =
          String(
            shopifyOrder.displayFulfillmentStatus ??
              ""
          ).toUpperCase();

        if (
          verifiedFulfillmentStatus !==
          "FULFILLED"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "SHOPIFY_ORDER_NOT_FULLY_FULFILLED",
            shopifyFulfillmentStatus:
              verifiedFulfillmentStatus,
            workflow,
            fulfillment,
            retryable: true,
          });
        }

        // ----------------------------------------------------
        // Erst wenn Shopify nachweislich FULFILLED ist:
        // READY_TO_SHIP -> COMPLETED
        // ----------------------------------------------------

        const completedWorkflow =
          await setOrderPackStatus(
            orderId,
            staffUser.id,
            "COMPLETED"
          );

        if (!completedWorkflow) {
          return res.status(409).json({
            ok: false,
            error:
              "FULFILLMENT_COMPLETED_BUT_LOCAL_COMPLETION_FAILED",
            workflow,
            fulfillment,
            retryable: true,
          });
        }

        return res.json({
          ok: true,
          workflow:
            completedWorkflow,
          fulfillment,
          shopifyFulfillmentStatus:
            verifiedFulfillmentStatus,
        });

      } finally {
        if (fulfillmentLockAcquired) {
          try {
            await fulfillmentLockClient.query(
              `
                SELECT pg_advisory_unlock(
                  hashtext($1)
                )
              `,
              [
                fulfillmentLockKey,
              ]
            );
          } catch (unlockError) {
            console.error(
              "STAFF ORDER FULFILLMENT UNLOCK ERROR",
              {
                orderId,
                error:
                  unlockError,
              }
            );
          }
        }

        fulfillmentLockClient.release();
      }

    } catch (error) {
      console.error(
        "STAFF ORDER STATUS ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Bestellstatus konnte nicht geändert werden.",
      });
    }
  }
);

export default router;
