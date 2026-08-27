import express from "express";

import { env } from "./config/env.js";

import { testDatabaseConnection } from "./database/db.js";
import { initializeDatabase } from "./database/init.js";

import { getSwissPostAccessToken } from "./integrations/swisspost/auth.js";
import { validateSwissPostAddress } from "./integrations/swisspost/address.js";
import { createSwissPostPreviewLabel } from "./integrations/swisspost/label.js";

import { getShopifyAccessToken } from "./integrations/shopify/auth.js";
import { getLatestShopifyOrders } from "./integrations/shopify/orders.js";

import {
  recoverPendingShopifyWebhooks,
} from "./modules/shipping/webhookRecovery.service.js";

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

import {
  shippingDashboardRouter,
} from "./routes/shippingDashboard.routes.js";

import {
  shopifyWebhookRouter,
} from "./routes/shopifyWebhook.routes.js";

const app = express();

/*
 * Shopify Webhooks müssen den unveränderten
 * Request Body für die HMAC-Prüfung erhalten.
 */
app.use(
  "/webhooks/shopify",
  express.raw({
    type: "application/json",
  })
);

app.use(
  shopifyWebhookRouter
);

app.use(express.json());

app.use(
  shippingDashboardRouter
);

// ============================================================
// ROOT
// ============================================================

app.get("/", (_req, res) => {
  return res.json({
    service: "ALO Platform",
    status: "online",
  });
});


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "ALO Platform API",
    timestamp: new Date().toISOString(),
  });
});


// ============================================================
// SWISS POST STATUS
// ============================================================

app.get(
  "/api/swisspost/status",
  async (_req, res) => {
    try {
      await getSwissPostAccessToken();

      return res.json({
        ok: true,
        provider: "Swiss Post",
        authenticated: true,
      });
    } catch (error: any) {
      console.error(
        "Swiss Post status error:",
        error
      );

      return res.status(500).json({
        ok: false,
        provider: "Swiss Post",
        authenticated: false,
        error: error.message,
      });
    }
  }
);


// ============================================================
// ADDRESS VALIDATION
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
      } = req.body;

      if (
        !firstName ||
        !lastName ||
        !street ||
        !houseNumber ||
        !zip ||
        !city
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Missing address fields",
        });
      }

      const result =
        await validateSwissPostAddress({
          firstName,
          lastName,
          street,
          houseNumber,
          zip,
          city,
        });

      return res.json({
        ok: true,
        provider: "Swiss Post",
        result,
      });
    } catch (error: any) {
      console.error(
        "Address validation error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);


// ============================================================
// TEST LABEL JSON
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
            name1: "Hans Muster",
            street: "Wankdorfallee",
            houseNo: "4",
            zip: "3030",
            city: "Bern",
            country: "CH",
          },

          weightGrams: 1000,
          service: "ECO",
        });

      return res.json({
        ok: true,
        provider: "Swiss Post",
        preview: true,
        identCode:
          result?.item?.identCode ?? null,
        labelDefinition:
          result?.labelDefinition ?? null,
      });
    } catch (error: any) {
      console.error(
        "Label generation error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
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
            name1: "Hans Muster",
            street: "Wankdorfallee",
            houseNo: "4",
            zip: "3030",
            city: "Bern",
            country: "CH",
          },

          weightGrams: 1000,
          service: "ECO",
        });

      const base64Pdf =
        result?.item?.label?.[0];

      if (!base64Pdf) {
        return res.status(500).json({
          ok: false,
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

      return res.status(500).json({
        ok: false,
        error: error.message,
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
        ok: true,
        provider: "Shopify",
        authenticated: true,
        shop: env.shopify.shop,
        apiVersion:
          env.shopify.apiVersion,
      });
    } catch (error: any) {
      console.error(
        "Shopify status error:",
        error
      );

      return res.status(500).json({
        ok: false,
        provider: "Shopify",
        authenticated: false,
        error: error.message,
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
        Number(req.query.limit || 5);

      const limit =
        Math.min(
          Math.max(
            requestedLimit,
            1
          ),
          20
        );

      const orders =
        await getLatestShopifyOrders(
          limit
        );

      return res.json({
        ok: true,
        provider: "Shopify",
        count: orders.length,
        orders,
      });
    } catch (error: any) {
      console.error(
        "Shopify orders endpoint error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);


// ============================================================
// LATEST ORDER ADDRESS VALIDATION
// ============================================================

app.post(
  "/api/shipping/latest-order/validate",
  async (_req, res) => {
    try {
      const orders =
        await getLatestShopifyOrders(1);

      if (orders.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Keine Shopify-Bestellung gefunden.",
        });
      }

      const order =
        orders[0];

      if (!order.shippingAddress) {
        return res.status(400).json({
          ok: false,
          error:
            "Bestellung hat keine Versandadresse.",
        });
      }

      const validation =
        await validateShopifyShippingAddress(
          order.shippingAddress
        );

      return res.json({
        ok: true,

        order: {
          id:
            order.id,

          name:
            order.name,

          financialStatus:
            order.displayFinancialStatus,

          fulfillmentStatus:
            order.displayFulfillmentStatus,
        },

        addressValidation:
          validation,
      });
    } catch (error: any) {
      console.error(
        "Shopify -> Swiss Post validation error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);


// ============================================================
// LATEST ORDER SPECIMEN LABEL
// ============================================================

app.get(
  "/api/shipping/latest-order/label.pdf",
  async (_req, res) => {
    try {
      const orders =
        await getLatestShopifyOrders(1);

      if (orders.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Keine Shopify-Bestellung gefunden.",
        });
      }

      const order =
        orders[0];

      const result =
        await createSpecimenLabelForOrder(
          order
        );

      const pdfBuffer =
        Buffer.from(
          result.pdfBase64,
          "base64"
        );

      if (result.reused) {
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

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="ALO-${String(
          order.name
        ).replace(
          "#",
          ""
        )}-SPECIMEN.pdf"`
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

      return res.status(500).json({
        ok: false,
        error: error.message,
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
        await getLatestShopifyOrders(1);

      if (orders.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Keine Shopify-Bestellung gefunden.",
        });
      }

      const order =
        orders[0];

      const fulfillmentData =
        await getFulfillmentOrdersForOrder(
          order.id
        );

      const fulfillmentOrders =
        fulfillmentData
          ?.fulfillmentOrders
          ?.nodes ?? [];

      return res.json({
        ok: true,

        order: {
          id:
            order.id,

          name:
            order.name,

          financialStatus:
            order.displayFinancialStatus,

          fulfillmentStatus:
            order.displayFulfillmentStatus,
        },

        count:
          fulfillmentOrders.length,

        fulfillmentOrders,
      });
    } catch (error: any) {
      console.error(
        "Fulfillment Order Test Error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);


// ============================================================
// SHOPIFY FULFILLMENT
// ============================================================

app.post(
  "/api/shopify/latest-order/fulfill",
  async (_req, res) => {
    try {
      const orders =
        await getLatestShopifyOrders(1);

      if (orders.length === 0) {
        return res.status(404).json({
          ok: false,
          error:
            "Keine Shopify-Bestellung gefunden.",
        });
      }

      const order =
        orders[0];

      const result =
        await fulfillShopifyOrderWithSwissPostTracking(
          order
        );

      return res.json({
        ok: true,

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

      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }
);


// ============================================================
// SERVER START
// ============================================================

async function startServer() {
  try {
    const database =
      await testDatabaseConnection();

    console.log(
      "PostgreSQL verbunden:",
      database.server_time
    );

    await initializeDatabase();

await recoverPendingShopifyWebhooks();

    app.listen(
      env.port,
      () => {
        console.log(
          `ALO Platform läuft auf http://localhost:${env.port}`
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


startServer();
