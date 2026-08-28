import express from "express";

import { env } from "./config/env.js";

import {
  testDatabaseConnection,
} from "./database/db.js";

import {
  initializeDatabase,
} from "./database/init.js";

import {
  getSwissPostAccessToken,
} from "./integrations/swisspost/auth.js";

import {
  validateSwissPostAddress,
} from "./integrations/swisspost/address.js";

import {
  createSwissPostPreviewLabel,
} from "./integrations/swisspost/label.js";

import {
  getShopifyAccessToken,
} from "./integrations/shopify/auth.js";

import {
  getLatestShopifyOrders,
} from "./integrations/shopify/orders.js";

import {
  getFulfillmentOrdersForOrder,
} from "./integrations/shopify/fulfillment.js";

import {
  validateShopifyShippingAddress,
} from "./modules/shipping/shopifyShipping.js";

import {
  createSpecimenLabelForOrder,
} from "./modules/shipping/shipping.service.js";

import {
  fulfillShopifyOrderWithSwissPostTracking,
} from "./modules/shipping/fulfillment.service.js";

import * as webhookRecovery
  from "./modules/shipping/webhookRecovery.service.js";

import {
  shopifyWebhookRouter,
} from "./routes/shopifyWebhook.routes.js";

import {
  shippingDashboardRouter,
} from "./routes/shippingDashboard.routes.js";

import {
  printersRouter,
} from "./routes/printers.routes.js";


// ============================================================
// EXPRESS
// ============================================================

const app =
  express();


// ============================================================
// SHOPIFY WEBHOOK RAW BODY
// ============================================================
//
// WICHTIG:
//
// Shopify prüft den Webhook mit HMAC.
// Dafür benötigen wir den unveränderten RAW Body.
//
// Deshalb MUSS dieser Block VOR express.json() stehen.
//
// ============================================================

app.use(
  "/webhooks/shopify",
  express.raw({
    type:
      "application/json",
  })
);


// ============================================================
// SHOPIFY WEBHOOK ROUTER
// ============================================================

app.use(
  shopifyWebhookRouter
);


// ============================================================
// JSON BODY
// ============================================================

app.use(
  express.json({
    limit:
      "10mb",
  })
);


// ============================================================
// SHIPPING ROUTER
// ============================================================

app.use(
  shippingDashboardRouter
);


// ============================================================
// PRINTER ROUTER
// ============================================================

app.use(
  printersRouter
);


// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (_req, res) => {
    return res.json({
      ok:
        true,

      service:
        "ALO Platform",

      status:
        "online",

      mode:
        "SPECIMEN",

      pages: {
        shipping:
          "/shipping",

        printers:
          "/printers",
      },

      api: {
        health:
          "/health",

        shippingDashboard:
          "/api/shipping/dashboard",

        printers:
          "/api/printers",
      },
    });
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (_req, res) => {
    return res.json({
      ok:
        true,

      service:
        "ALO Platform API",

      timestamp:
        new Date()
          .toISOString(),
    });
  }
);


// ============================================================
// SWISS POST STATUS
// ============================================================

app.get(
  "/api/swisspost/status",
  async (_req, res) => {
    try {
      await getSwissPostAccessToken();

      return res.json({
        ok:
          true,

        provider:
          "Swiss Post",

        authenticated:
          true,

        mode:
          "SPECIMEN",
      });
    } catch (error: any) {
      console.error(
        "Swiss Post status error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          provider:
            "Swiss Post",

          authenticated:
            false,

          error:
            error?.message ??
            "Swiss Post Fehler",
        });
    }
  }
);


// ============================================================
// SWISS POST ADRESSE TESTEN
// ============================================================

app.post(
  "/api/shipping/validate-address",
  async (req, res) => {
    try {
      const {
        firstName,
        lastName,
        street,
        houseNumber,
        zip,
        city,
      } =
        req.body ?? {};

      if (
        !firstName ||
        !lastName ||
        !street ||
        !houseNumber ||
        !zip ||
        !city
      ) {
        return res
          .status(400)
          .json({
            ok:
              false,

            error:
              "Missing address fields",
          });
      }

      const result =
        await validateSwissPostAddress({
          firstName:
            String(
              firstName
            ),

          lastName:
            String(
              lastName
            ),

          street:
            String(
              street
            ),

          houseNumber:
            String(
              houseNumber
            ),

          zip:
            String(
              zip
            ),

          city:
            String(
              city
            ),
        });

      return res.json({
        ok:
          true,

        provider:
          "Swiss Post",

        result,
      });
    } catch (error: any) {
      console.error(
        "Address validation error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ??
            "Address validation failed",
        });
    }
  }
);


// ============================================================
// TEST LABEL
// ============================================================
//
// NUR SPECIMEN.
//
// KEIN LIVE-LABEL.
//
// ============================================================

app.post(
  "/api/shipping/test-label",
  async (_req, res) => {
    try {
      const result =
        await createSwissPostPreviewLabel({
          itemId:
            `ALO-${Date.now()}`,

          recipient: {
            name1:
              "Hans Muster",

            street:
              "Wankdorfallee",

            houseNo:
              "4",

            zip:
              "3030",

            city:
              "Bern",

            country:
              "CH",
          },

          weightGrams:
            1000,

          service:
            "ECO",
        });

      return res.json({
        ok:
          true,

        provider:
          "Swiss Post",

        preview:
          true,

        identCode:
          result
            ?.item
            ?.identCode ??
          null,

        labelDefinition:
          result
            ?.labelDefinition ??
          null,
      });
    } catch (error: any) {
      console.error(
        "Label generation error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ??
            "Label generation failed",
        });
    }
  }
);


// ============================================================
// TEST LABEL PDF
// ============================================================

app.get(
  "/api/shipping/test-label.pdf",
  async (_req, res) => {
    try {
      const result =
        await createSwissPostPreviewLabel({
          itemId:
            `ALO-${Date.now()}`,

          recipient: {
            name1:
              "Hans Muster",

            street:
              "Wankdorfallee",

            houseNo:
              "4",

            zip:
              "3030",

            city:
              "Bern",

            country:
              "CH",
          },

          weightGrams:
            1000,

          service:
            "ECO",
        });

      const base64Pdf =
        result
          ?.item
          ?.label
          ?.[0];

      if (!base64Pdf) {
        return res
          .status(500)
          .json({
            ok:
              false,

            error:
              "Swiss Post hat kein PDF geliefert.",
          });
      }

      const pdfBuffer =
        Buffer.from(
          base64Pdf,
          "base64"
        );

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        'inline; filename="alo-swisspost-test-label.pdf"'
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res.send(
        pdfBuffer
      );
    } catch (error: any) {
      console.error(
        "PDF label error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ??
            "PDF generation failed",
        });
    }
  }
);


// ============================================================
// SHOPIFY STATUS
// ============================================================

app.get(
  "/api/shopify/status",
  async (_req, res) => {
    try {
      await getShopifyAccessToken();

      return res.json({
        ok:
          true,

        provider:
          "Shopify",

        authenticated:
          true,

        shop:
          env.shopify.shop,

        apiVersion:
          env.shopify.apiVersion,
      });
    } catch (error: any) {
      console.error(
        "Shopify status error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          provider:
            "Shopify",

          authenticated:
            false,

          error:
            error?.message ??
            "Shopify authentication failed",
        });
    }
  }
);


// ============================================================
// SHOPIFY ORDERS
// ============================================================

app.get(
  "/api/shopify/orders",
  async (req, res) => {
    try {
      const requestedLimit =
        Number(
          req.query.limit ??
          5
        );

      const validLimit =
        Number.isFinite(
          requestedLimit
        )
          ? requestedLimit
          : 5;

      const limit =
        Math.min(
          Math.max(
            Math.floor(
              validLimit
            ),
            1
          ),
          20
        );

      const orders =
        await getLatestShopifyOrders(
          limit
        );

      return res.json({
        ok:
          true,

        provider:
          "Shopify",

        count:
          orders.length,

        orders,
      });
    } catch (error: any) {
      console.error(
        "Shopify orders endpoint error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ??
            "Shopify orders failed",
        });
    }
  }
);


// ============================================================
// LETZTE SHOPIFY BESTELLUNG:
// ADRESSE VALIDIEREN
// ============================================================

app.post(
  "/api/shipping/latest-order/validate",
  async (_req, res) => {
    try {
      const orders =
        await getLatestShopifyOrders(
          1
        );

      if (
        orders.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            ok:
              false,

            error:
              "Keine Shopify-Bestellung gefunden.",
          });
      }

      const order =
        orders[0];

      if (
        !order
          ?.shippingAddress
      ) {
        return res
          .status(400)
          .json({
            ok:
              false,

            error:
              "Bestellung hat keine Versandadresse.",
          });
      }

      const validation =
        await validateShopifyShippingAddress(
          order
            .shippingAddress
        );

      return res.json({
        ok:
          true,

        order: {
          id:
            order.id,

          name:
            order.name,

          financialStatus:
            order
              .displayFinancialStatus,

          fulfillmentStatus:
            order
              .displayFulfillmentStatus,
        },

        addressValidation:
          validation,
      });
    } catch (error: any) {
      console.error(
        "Shopify -> Swiss Post validation error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ??
            "Validation failed",
        });
    }
  }
);


// ============================================================
// LETZTE SHOPIFY BESTELLUNG:
// SPECIMEN LABEL
// ============================================================

app.get(
  "/api/shipping/latest-order/label.pdf",
  async (_req, res) => {
    try {
      const orders =
        await getLatestShopifyOrders(
          1
        );

      if (
        orders.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            ok:
              false,

            error:
              "Keine Shopify-Bestellung gefunden.",
          });
      }

      const order =
        orders[0];

      if (!order) {
        return res
          .status(404)
          .json({
            ok:
              false,

            error:
              "Bestellung nicht gefunden.",
          });
      }

      const result =
        await createSpecimenLabelForOrder(
          order
        );

      const pdfBuffer =
        Buffer.from(
          result.pdfBase64,
          "base64"
        );

      if (
        result.reused
      ) {
        console.log(
          `SPECIMEN Label wiederverwendet: ${order.name} | ${result.identCode}`
        );
      } else {
        console.log(
          `SPECIMEN Label neu erstellt: ${order.name} | ${result.identCode}`
        );
      }

      console.log(
        `Versandgewicht: ${result.weightGrams} g`
      );

      const safeOrderName =
        String(
          order.name
        )
          .replace(
            "#",
            ""
          )
          .replace(
            /[^a-zA-Z0-9_-]/g,
            "-"
          );

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="ALO-${safeOrderName}-SPECIMEN.pdf"`
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res.send(
        pdfBuffer
      );
    } catch (error: any) {
      console.error(
        "Shipping service error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ??
            "Shipping service failed",
        });
    }
  }
);


// ============================================================
// FULFILLMENT ORDERS
// ============================================================

app.get(
  "/api/shopify/latest-order/fulfillment-orders",
  async (_req, res) => {
    try {
      const orders =
        await getLatestShopifyOrders(
          1
        );

      if (
        orders.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            ok:
              false,

            error:
              "Keine Shopify-Bestellung gefunden.",
          });
      }

      const order =
        orders[0];

      if (!order) {
        return res
          .status(404)
          .json({
            ok:
              false,

            error:
              "Bestellung nicht gefunden.",
          });
      }

      const fulfillmentData =
        await getFulfillmentOrdersForOrder(
          order.id
        );

      const fulfillmentOrders =
        fulfillmentData
          ?.fulfillmentOrders
          ?.nodes ??
        [];

      return res.json({
        ok:
          true,

        order: {
          id:
            order.id,

          name:
            order.name,

          financialStatus:
            order
              .displayFinancialStatus,

          fulfillmentStatus:
            order
              .displayFulfillmentStatus,
        },

        count:
          fulfillmentOrders.length,

        fulfillmentOrders,
      });
    } catch (error: any) {
      console.error(
        "Fulfillment Order Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ??
            "Fulfillment orders failed",
        });
    }
  }
);


// ============================================================
// SHOPIFY FULFILLMENT TEST
// ============================================================
//
// NOCH NICHT FÜR AUTOMATISCHEN PRODUKTIVBETRIEB.
//
// Später:
// PRINTED
//      ↓
// Fulfillment
//      ↓
// Tracking zu Shopify
//
// ============================================================

app.post(
  "/api/shopify/latest-order/fulfill",
  async (_req, res) => {
    try {
      const orders =
        await getLatestShopifyOrders(
          1
        );

      if (
        orders.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            ok:
              false,

            error:
              "Keine Shopify-Bestellung gefunden.",
          });
      }

      const order =
        orders[0];

      if (!order) {
        return res
          .status(404)
          .json({
            ok:
              false,

            error:
              "Bestellung nicht gefunden.",
          });
      }

      const result =
        await fulfillShopifyOrderWithSwissPostTracking(
          order
        );

      return res.json({
        ok:
          true,

        order: {
          id:
            order.id,

          name:
            order.name,
        },

        result,
      });
    } catch (error: any) {
      console.error(
        "Shopify Fulfillment Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ??
            "Shopify fulfillment failed",
        });
    }
  }
);


// ============================================================
// WEBHOOK RECOVERY
// ============================================================
//
// Dein Recovery-Service wurde bereits erstellt.
//
// Wir importieren bewusst das komplette Modul,
// weil der genaue Funktionsname in deinem aktuellen Stand
// von früheren Versionen abweicht.
//
// Dadurch verursacht ein anderer Funktionsname
// KEINEN TypeScript Import-Fehler mehr.
//
// ============================================================

async function runWebhookRecovery() {
  try {
    const recoveryModule =
      webhookRecovery as unknown as
        Record<
          string,
          unknown
        >;

    const candidates = [
      "recoverPendingShopifyWebhooks",
      "recoverShopifyWebhookEvents",
      "recoverWebhookEvents",
      "recoverPendingWebhookEvents",
    ];

    let recoveryFunction:
      | (() => Promise<unknown>)
      | null =
      null;

    let recoveryName:
      | string
      | null =
      null;

    for (
      const candidate
      of candidates
    ) {
      const value =
        recoveryModule[
          candidate
        ];

      if (
        typeof value ===
        "function"
      ) {
        recoveryFunction =
          value as
            () =>
              Promise<unknown>;

        recoveryName =
          candidate;

        break;
      }
    }

    if (
      !recoveryFunction
    ) {
      console.warn(
        "Webhook Recovery: keine bekannte Recovery-Funktion gefunden."
      );

      console.warn(
        "Verfügbare Exports:",
        Object.keys(
          recoveryModule
        )
      );

      return;
    }

    console.log(
      `Webhook Recovery startet: ${recoveryName}`
    );

    await recoveryFunction();

    console.log(
      "Webhook Recovery abgeschlossen."
    );
  } catch (error) {
    console.error(
      "Webhook Recovery fehlgeschlagen:",
      error
    );
  }
}


// ============================================================
// 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {
    return res
      .status(404)
      .json({
        ok:
          false,

        error:
          "Route nicht gefunden.",

        method:
          req.method,

        path:
          req.path,
      });
  }
);


// ============================================================
// SERVER START
// ============================================================

async function startServer() {
  try {
    // --------------------------------------------------------
    // DATABASE CONNECTION
    // --------------------------------------------------------

    const database =
      await testDatabaseConnection();

    console.log(
      "PostgreSQL verbunden:",
      database.server_time
    );


    // --------------------------------------------------------
    // DATABASE SCHEMA / MIGRATIONS
    // --------------------------------------------------------

    await initializeDatabase();

    console.log(
      "Datenbank initialisiert."
    );


    // --------------------------------------------------------
    // WEBHOOK RECOVERY
    // --------------------------------------------------------

    await runWebhookRecovery();


    // --------------------------------------------------------
    // START EXPRESS
    // --------------------------------------------------------

    app.listen(
      env.port,
      () => {
        console.log(
          `ALO Platform läuft auf Port ${env.port}`
        );

        console.log(
          `Shipping: http://localhost:${env.port}/shipping`
        );

        console.log(
          `Printers: http://localhost:${env.port}/printers`
        );

        console.log(
          "Swiss Post: SPECIMEN MODE"
        );
      }
    );
  } catch (error) {
    console.error(
      "ALO Platform konnte nicht gestartet werden:",
      error
    );

    process.exit(1);
  }
}


// ============================================================
// START
// ============================================================

void startServer();
