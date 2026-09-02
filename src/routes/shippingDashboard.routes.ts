import express from "express";

import {
  requirePrintAgentToken,
} from "../middleware/printAgentAuth.js";

import {
  getShippingDashboardLabels,
  getShippingLabelPdf,
  getPackingSlipPdf,
  getInvoicePdf,
  getOrderDashboard,
  archiveOrderAsTest,
  restoreArchivedOrder,
  createPrintJob,
  claimNextPrintJob,
  completePrintJob,
  failPrintJob,
} from "../database/shippingDashboard.js";

import {
  requireShippingDashboardAuth,
  verifyDashboardCode,
  createDashboardSession,
  clearDashboardSession,
} from "../middleware/shippingDashboardAuth.js";


export const shippingDashboardRouter =
  express.Router();



/*
 * ==========================================================
 * ALO BESTELLZENTRALE – BROWSER AUTH
 *
 * Geschützt werden ausschließlich:
 *   /shipping
 *   /api/shipping/*
 *
 * /api/print-agent/* bleibt bei seiner bestehenden
 * Device-/Token-Authentifizierung.
 * ==========================================================
 */
shippingDashboardRouter.use(
  express.json()
);


// ==========================================================
// ALO BESTELLZENTRALE LOGIN
// ==========================================================

shippingDashboardRouter.get(
  "/shipping/login",
  (_req, res) => {

    return res
      .type("html")
      .send(`
<!DOCTYPE html>
<html lang="de">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>
ALO Bestellzentrale
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  min-height: 100vh;

  display: grid;

  place-items: center;

  background:
    #f3f3f1;

  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  color:
    #111;
}

.login {
  width:
    min(
      420px,
      calc(100% - 30px)
    );

  background:
    white;

  border:
    1px solid #e2e2dd;

  border-radius:
    26px;

  padding:
    32px;

  box-shadow:
    0 24px 70px
    rgba(0,0,0,.08);
}

.brand {
  font-size:
    11px;

  font-weight:
    800;

  letter-spacing:
    .15em;

  opacity:
    .45;
}

h1 {
  margin:
    9px 0 8px;

  font-size:
    36px;

  letter-spacing:
    -.05em;
}

p {
  margin:
    0 0 24px;

  color:
    #777;

  font-size:
    13px;
}

input {
  width:
    100%;

  height:
    66px;

  border:
    1px solid #d4d4ce;

  border-radius:
    15px;

  outline:
    none;

  background:
    #f8f8f6;

  text-align:
    center;

  font-size:
    30px;

  font-weight:
    900;

  letter-spacing:
    .32em;
}

input:focus {
  border-color:
    #111;

  background:
    white;
}

button {
  width:
    100%;

  margin-top:
    12px;

  border:
    0;

  border-radius:
    15px;

  background:
    #111;

  color:
    white;

  padding:
    16px;

  font-size:
    14px;

  font-weight:
    850;

  cursor:
    pointer;
}

#error {
  min-height:
    20px;

  margin-top:
    12px;

  text-align:
    center;

  color:
    #b42318;

  font-size:
    12px;

  font-weight:
    700;
}

</style>

</head>


<body>

<div class="login">

  <div class="brand">
    ALO KIOSK · INTERN
  </div>

  <h1>
    Bestellzentrale
  </h1>

  <p>
    Zugangscode eingeben
  </p>

  <form id="loginForm">

    <input
      id="code"
      type="password"
      inputmode="numeric"
      pattern="[0-9]*"
      maxlength="4"
      placeholder="••••"
      autofocus
    >

    <button type="submit">
      Öffnen
    </button>

    <div id="error"></div>

  </form>

</div>


<script>

const form =
  document.getElementById(
    "loginForm"
  );

const code =
  document.getElementById(
    "code"
  );

const error =
  document.getElementById(
    "error"
  );


form.addEventListener(
  "submit",
  async event => {

    event.preventDefault();

    error.textContent =
      "";

    try {

      const response =
        await fetch(
          "/api/shipping/login",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                code:
                  code.value,
              }),
          }
        );

      const data =
        await response.json();

      if (
        response.ok &&
        data.ok
      ) {

        window.location.replace(
          "/shipping"
        );

        return;
      }

      error.textContent =
        "Code falsch";

      code.value =
        "";

      code.focus();

    } catch {

      error.textContent =
        "Verbindung fehlgeschlagen";
    }
  }
);

</script>

</body>

</html>
      `);
  }
);


shippingDashboardRouter.post(
  "/api/shipping/login",
  (req, res) => {

    const code =
      String(
        req.body?.code ||
        ""
      ).trim();

    if (
      !verifyDashboardCode(
        code
      )
    ) {

      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Code falsch",
        });
    }

    createDashboardSession(
      res
    );

    return res.json({
      ok: true,
    });
  }
);


shippingDashboardRouter.post(
  "/api/shipping/logout",
  (_req, res) => {

    clearDashboardSession(
      res
    );

    return res.json({
      ok: true,
    });
  }
);


// ==========================================================
// DASHBOARD SCHUTZ
// ==========================================================

shippingDashboardRouter.use(
  (
    req,
    res,
    next
  ) => {

    if (
      req.path === "/shipping" ||
      (
        req.path.startsWith(
          "/api/shipping/"
        ) &&
        req.path !==
          "/api/shipping/login"
      )
    ) {

      return requireShippingDashboardAuth(
        req,
        res,
        next
      );
    }

    return next();
  }
);


// ==========================================================
// API: ALLE LABELS
// ==========================================================

shippingDashboardRouter.get(
  "/api/shipping/dashboard",

  async (_req, res) => {
    try {
      const labels =
        await getShippingDashboardLabels(
          200
        );

      const stats = {
        total:
          labels.length,

        ready:
          labels.filter(
            (label) =>
              label.status ===
              "COMPLETED"
          ).length,

        queued:
          labels.filter(
            (label) =>
              label.print_status ===
                "QUEUED" ||
              label.print_status ===
                "PRINTING"
          ).length,

        printed:
          labels.filter(
            (label) =>
              label.print_status ===
              "PRINTED"
          ).length,

        failed:
          labels.filter(
            (label) =>
              label.status ===
                "FAILED" ||
              label.print_status ===
                "FAILED"
          ).length,
      };

      return res.json({
        ok: true,
        stats,
        labels,
      });

    } catch (error: any) {
      console.error(
        "Shipping Dashboard Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Dashboard Fehler",
        });
    }
  }
);


// ==========================================================
// API: UNIFIED BESTELLUNGEN
//
// Eine Shopify-Bestellung erscheint hier genau einmal.
// Versandlabel, Lieferschein und Rechnung werden anhand
// der Shopify Order ID zusammengeführt.
// ==========================================================

shippingDashboardRouter.get(
  "/api/shipping/orders",
  async (_req, res) => {
    try {

      const orders =
        await getOrderDashboard(
          500
        );

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

      return res.json({
        ok: true,
        stats,
        orders,
      });

    } catch (error: any) {

      console.error(
        "Order Dashboard Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Bestellübersicht konnte nicht geladen werden.",
        });
    }
  }
);



// ==========================================================
// API: BESTELLUNG INS TESTARCHIV
//
// Es werden KEINE Dokumente gelöscht.
// Es wird ausschließlich die Dashboard-Markierung geändert.
// ==========================================================

shippingDashboardRouter.post(
  "/api/shipping/orders/archive",

  async (req, res) => {

    try {

      const orderId =
        String(
          req.body?.shopifyOrderId ??
          ""
        ).trim();

      if (!orderId) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Shopify Order ID fehlt.",
          });
      }

      const orders =
        await getOrderDashboard(
          1000
        );

      const exists =
        orders.some(
          (order) =>
            order.shopify_order_id ===
            orderId
        );

      if (!exists) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Bestellung nicht gefunden.",
          });
      }

      await archiveOrderAsTest(
        orderId
      );

      return res.json({
        ok: true,
        shopify_order_id:
          orderId,
        status:
          "ARCHIVED",
        is_test:
          true,
      });

    } catch (error: any) {

      console.error(
        "Order Archive Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Bestellung konnte nicht archiviert werden.",
        });
    }
  }
);


// ==========================================================
// API: BESTELLUNG AUS ARCHIV WIEDERHERSTELLEN
//
// is_archived UND is_test werden dabei zurückgesetzt.
// Dokumente bleiben unverändert.
// ==========================================================

shippingDashboardRouter.post(
  "/api/shipping/orders/restore",

  async (req, res) => {

    try {

      const orderId =
        String(
          req.body?.shopifyOrderId ??
          ""
        ).trim();

      if (!orderId) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Shopify Order ID fehlt.",
          });
      }

      const orders =
        await getOrderDashboard(
          1000
        );

      const order =
        orders.find(
          (item) =>
            item.shopify_order_id ===
            orderId
        );

      if (!order) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Bestellung nicht gefunden.",
          });
      }

      if (!order.is_archived) {

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "Bestellung ist nicht archiviert.",
          });
      }

      await restoreArchivedOrder(
        orderId
      );

      return res.json({
        ok: true,
        shopify_order_id:
          orderId,
        status:
          "RESTORED",
        is_archived:
          false,
        is_test:
          false,
      });

    } catch (error: any) {

      console.error(
        "Order Restore Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Bestellung konnte nicht wiederhergestellt werden.",
        });
    }
  }
);


// ==========================================================
// API: LIEFERSCHEIN PDF
// ==========================================================

shippingDashboardRouter.get(
  "/api/shipping/packing-slips/:id/pdf",
  async (req, res) => {
    try {

      const slip =
        await getPackingSlipPdf(
          req.params.id
        );

      if (!slip) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Lieferschein PDF nicht gefunden.",
          });
      }

      const pdf =
        Buffer.from(
          slip.pdfBase64,
          "base64"
        );

      const safeOrderName =
        slip.orderName
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
        `inline; filename="${safeOrderName}-lieferschein.pdf"`
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res.send(pdf);

    } catch (error: any) {

      console.error(
        "Packing Slip PDF Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Lieferschein PDF Fehler",
        });
    }
  }
);


// ==========================================================
// API: RECHNUNG PDF AUS ARCHIV
//
// Es wird ausschließlich das bereits archivierte PDF
// ausgeliefert. Die Rechnung wird NICHT neu erzeugt.
// ==========================================================

shippingDashboardRouter.get(
  "/api/shipping/invoices/:id/pdf",
  async (req, res) => {
    try {

      const invoice =
        await getInvoicePdf(
          req.params.id
        );

      if (!invoice) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Rechnung PDF nicht gefunden.",
          });
      }

      const pdf =
        Buffer.from(
          invoice.pdfBase64,
          "base64"
        );

      const safeInvoiceNumber =
        invoice.invoiceNumber
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
        `inline; filename="${safeInvoiceNumber}.pdf"`
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res.send(pdf);

    } catch (error: any) {

      console.error(
        "Invoice PDF Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Rechnung PDF Fehler",
        });
    }
  }
);


// ==========================================================
// API: LABEL PDF
// ==========================================================

shippingDashboardRouter.get(
  "/api/shipping/labels/:id/pdf",

  async (req, res) => {
    try {
      const label =
        await getShippingLabelPdf(
          req.params.id
        );

      if (!label) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Label PDF nicht gefunden.",
          });
      }

      const pdf =
        Buffer.from(
          label.pdfBase64,
          "base64"
        );

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${label.orderName}-label.pdf"`
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res.send(
        pdf
      );

    } catch (error: any) {
      console.error(
        "Label PDF Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "PDF Fehler",
        });
    }
  }
);


// ==========================================================
// API: PRINT JOB ERSTELLEN
//
// Diese Route kommt vom internen Dashboard.
// Der eigentliche Print Agent wird separat geschützt.
// ==========================================================

shippingDashboardRouter.post(
  "/api/shipping/labels/:id/print",

  async (req, res) => {
    try {
      const printerName =
        typeof req.body?.printerName ===
        "string"
          ? req.body.printerName.trim()
          : undefined;

      const result =
        await createPrintJob(
          req.params.id,
          printerName ||
            undefined
        );

      return res.json({
        ok: true,
        ...result,
      });

    } catch (error: any) {
      console.error(
        "Print Queue Error:",
        error
      );

      return res
        .status(400)
        .json({
          ok: false,
          error:
            error?.message ??
            "Print Queue Fehler",
        });
    }
  }
);


// ==========================================================
// PRINT AGENT AUTH
//
// ALLE /api/print-agent/... Endpunkte benötigen jetzt
// PRINT_AGENT_TOKEN.
// ==========================================================

shippingDashboardRouter.use(
  "/api/print-agent",
  requirePrintAgentToken
);


// ==========================================================
// PRINT AGENT: NÄCHSTEN JOB HOLEN
// ==========================================================

shippingDashboardRouter.post(
  "/api/print-agent/jobs/next",

  async (req, res) => {
    try {
      const printerName =
        String(
          req.body?.printerName ??
          ""
        ).trim();

      const documentType =
        String(
          req.body?.documentType ??
          "SHIPPING_LABEL"
        ).trim().toUpperCase();

      if (!printerName) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "printerName fehlt.",
          });
      }

      if (
        documentType !==
          "SHIPPING_LABEL" &&
        documentType !==
          "PACKING_SLIP" &&
        documentType !==
          "INVOICE"
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Ungültiger documentType.",
          });
      }

      const job =
        await claimNextPrintJob(
          printerName,
          documentType
        );

      return res.json({
        ok: true,
        job,
      });

    } catch (error: any) {
      console.error(
        "Print Agent Claim Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Print Agent Fehler",
        });
    }
  }
);


// ==========================================================
// PRINT AGENT: JOB ERFOLGREICH
// ==========================================================

shippingDashboardRouter.post(
  "/api/print-agent/jobs/:id/complete",

  async (req, res) => {
    try {
      const job =
        await completePrintJob(
          req.params.id
        );

      return res.json({
        ok: true,
        job,
      });

    } catch (error: any) {
      console.error(
        "Print Agent Complete Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Print Complete Fehler",
        });
    }
  }
);


// ==========================================================
// PRINT AGENT: JOB FEHLER
// ==========================================================

shippingDashboardRouter.post(
  "/api/print-agent/jobs/:id/fail",

  async (req, res) => {
    try {
      const message =
        String(
          req.body?.error ??
          "Unbekannter Druckfehler"
        ).trim();

      const job =
        await failPrintJob(
          req.params.id,
          message ||
            "Unbekannter Druckfehler"
        );

      return res.json({
        ok: true,
        job,
      });

    } catch (error: any) {
      console.error(
        "Print Agent Fail Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Print Fail Fehler",
        });
    }
  }
);


// ==========================================================
// ALO SHIPPING DASHBOARD
// ==========================================================

// ==========================================================
// ALO BESTELLZENTRALE
// ==========================================================

shippingDashboardRouter.get(
  "/shipping",

  (_req, res) => {

    return res
      .type("html")
      .send(`
<!DOCTYPE html>

<html lang="de">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<meta
  name="robots"
  content="noindex,nofollow"
>

<title>
  ALO Bestellzentrale
</title>

<style>

:root {
  --bg: #f4f4f1;
  --surface: #ffffff;
  --surface-soft: #f8f8f6;
  --text: #111111;
  --muted: #777773;
  --line: #e5e5df;
  --black: #111111;
  --green: #16794b;
  --green-bg: #e9f7ef;
  --red: #b42318;
  --red-bg: #fff0ee;
  --orange: #9a5b00;
  --orange-bg: #fff5df;
  --blue: #2456a6;
  --blue-bg: #edf4ff;
  --purple: #6e3db8;
  --purple-bg: #f3edff;
  --shadow:
    0 18px 50px
    rgba(0,0,0,.055);
}

* {
  box-sizing: border-box;
}

html {
  min-height: 100%;
}

body {
  margin: 0;
  min-height: 100vh;

  background:
    radial-gradient(
      circle at top right,
      rgba(0,0,0,.035),
      transparent 34%
    ),
    var(--bg);

  color:
    var(--text);

  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  -webkit-font-smoothing:
    antialiased;
}

button,
input {
  font:
    inherit;
}

button,
a {
  -webkit-tap-highlight-color:
    transparent;
}

.shell {
  width:
    min(1540px, calc(100% - 40px));

  margin:
    0 auto;

  padding:
    34px 0 80px;
}


/* ==========================================================
   HEADER
========================================================== */

.header {
  display:
    flex;

  justify-content:
    space-between;

  align-items:
    flex-end;

  gap:
    24px;

  margin-bottom:
    25px;
}

.eyebrow {
  display:
    flex;

  align-items:
    center;

  gap:
    8px;

  margin-bottom:
    8px;

  color:
    var(--muted);

  font-size:
    11px;

  font-weight:
    850;

  letter-spacing:
    .16em;

  text-transform:
    uppercase;
}

.live-dot {
  width:
    8px;

  height:
    8px;

  border-radius:
    999px;

  background:
    #20a464;

  box-shadow:
    0 0 0 5px
    rgba(32,164,100,.11);
}

h1 {
  margin:
    0;

  font-size:
    clamp(36px, 5vw, 66px);

  line-height:
    .94;

  letter-spacing:
    -.06em;
}

.subtitle {
  max-width:
    720px;

  margin-top:
    13px;

  color:
    var(--muted);

  font-size:
    14px;

  line-height:
    1.55;
}

.header-side {
  display:
    flex;

  align-items:
    center;

  gap:
    10px;
}

.refresh {
  border:
    1px solid var(--line);

  background:
    var(--surface);

  border-radius:
    13px;

  padding:
    11px 14px;

  color:
    var(--text);

  font-size:
    13px;

  font-weight:
    750;

  cursor:
    pointer;

  transition:
    transform .15s ease,
    background .15s ease;
}

.refresh:hover {
  background:
    #fafafa;

  transform:
    translateY(-1px);
}

.refresh:disabled {
  opacity:
    .5;

  cursor:
    wait;

  transform:
    none;
}

.secure {
  display:
    inline-flex;

  align-items:
    center;

  gap:
    7px;

  border-radius:
    999px;

  padding:
    10px 13px;

  background:
    var(--black);

  color:
    white;

  font-size:
    11px;

  font-weight:
    850;

  letter-spacing:
    .04em;
}


/* ==========================================================
   KPI CARDS
========================================================== */

.stats {
  display:
    grid;

  grid-template-columns:
    repeat(5, minmax(0, 1fr));

  gap:
    11px;

  margin-bottom:
    17px;
}

.stat {
  position:
    relative;

  overflow:
    hidden;

  min-height:
    112px;

  border:
    1px solid var(--line);

  border-radius:
    20px;

  background:
    var(--surface);

  padding:
    18px 19px;

  box-shadow:
    0 4px 20px
    rgba(0,0,0,.018);

  cursor:
    pointer;

  transition:
    transform .17s ease,
    box-shadow .17s ease,
    border-color .17s ease;
}

.stat:hover {
  transform:
    translateY(-2px);

  box-shadow:
    var(--shadow);
}

.stat.active {
  border-color:
    #111;
}

.stat::after {
  content:
    "";

  position:
    absolute;

  right:
    -28px;

  bottom:
    -38px;

  width:
    105px;

  height:
    105px;

  border-radius:
    999px;

  background:
    rgba(0,0,0,.025);
}

.stat-number {
  position:
    relative;

  z-index:
    1;

  font-size:
    34px;

  font-weight:
    900;

  letter-spacing:
    -.055em;
}

.stat-label {
  position:
    relative;

  z-index:
    1;

  margin-top:
    6px;

  color:
    var(--muted);

  font-size:
    12px;

  font-weight:
    760;
}

.stat[data-filter="CURRENT"] .stat-number {
  color:
    var(--blue);
}

.stat[data-filter="COMPLETED"] .stat-number {
  color:
    var(--green);
}

.stat[data-filter="ERROR"] .stat-number {
  color:
    var(--red);
}

.stat[data-filter="ARCHIVED"] .stat-number {
  color:
    var(--purple);
}


/* ==========================================================
   MAIN PANEL
========================================================== */

.panel {
  overflow:
    hidden;

  border:
    1px solid var(--line);

  border-radius:
    24px;

  background:
    var(--surface);

  box-shadow:
    var(--shadow);
}

.toolbar {
  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  gap:
    16px;

  padding:
    16px;

  border-bottom:
    1px solid var(--line);
}

.tabs {
  display:
    flex;

  gap:
    6px;

  overflow-x:
    auto;

  scrollbar-width:
    none;
}

.tabs::-webkit-scrollbar {
  display:
    none;
}

.tab {
  flex:
    0 0 auto;

  border:
    0;

  border-radius:
    11px;

  background:
    transparent;

  padding:
    10px 13px;

  color:
    #777;

  font-size:
    12px;

  font-weight:
    820;

  cursor:
    pointer;

  transition:
    .15s ease;
}

.tab:hover {
  background:
    #f4f4f1;

  color:
    #111;
}

.tab.active {
  background:
    #111;

  color:
    #fff;
}

.search-wrap {
  position:
    relative;

  width:
    min(360px, 100%);
}

.search {
  width:
    100%;

  border:
    1px solid var(--line);

  border-radius:
    12px;

  background:
    var(--surface-soft);

  padding:
    11px 13px 11px 38px;

  outline:
    none;

  font-size:
    13px;

  transition:
    border-color .15s ease,
    background .15s ease;
}

.search:focus {
  border-color:
    #aaa;

  background:
    #fff;
}

.search-icon {
  position:
    absolute;

  left:
    13px;

  top:
    50%;

  transform:
    translateY(-50%);

  opacity:
    .42;

  pointer-events:
    none;
}


/* ==========================================================
   TABLE
========================================================== */

.table-wrap {
  overflow-x:
    auto;
}

table {
  width:
    100%;

  border-collapse:
    collapse;

  min-width:
    1180px;
}

thead {
  background:
    #fafaf8;
}

th {
  padding:
    12px 15px;

  border-bottom:
    1px solid var(--line);

  color:
    #8a8a85;

  text-align:
    left;

  font-size:
    10px;

  font-weight:
    850;

  letter-spacing:
    .075em;

  text-transform:
    uppercase;

  white-space:
    nowrap;
}

td {
  padding:
    15px;

  border-bottom:
    1px solid #eeeeea;

  vertical-align:
    middle;

  font-size:
    13px;
}

tbody tr {
  transition:
    background .13s ease;
}

tbody tr:hover {
  background:
    #fafaf8;
}

tbody tr:last-child td {
  border-bottom:
    0;
}

.order-number {
  font-size:
    14px;

  font-weight:
    880;

  letter-spacing:
    -.02em;
}

.order-date {
  margin-top:
    4px;

  color:
    var(--muted);

  font-size:
    11px;
}

.money {
  font-weight:
    850;

  white-space:
    nowrap;
}

.muted {
  color:
    var(--muted);
}


/* ==========================================================
   BADGES
========================================================== */

.badge {
  display:
    inline-flex;

  align-items:
    center;

  gap:
    6px;

  border-radius:
    999px;

  padding:
    6px 9px;

  font-size:
    10px;

  font-weight:
    850;

  white-space:
    nowrap;
}

.badge.current {
  background:
    var(--blue-bg);

  color:
    var(--blue);
}

.badge.completed {
  background:
    var(--green-bg);

  color:
    var(--green);
}

.badge.error {
  background:
    var(--red-bg);

  color:
    var(--red);
}

.badge.archived {
  background:
    var(--purple-bg);

  color:
    var(--purple);
}

.badge.pickup {
  background:
    var(--orange-bg);

  color:
    var(--orange);
}

.badge.shipping {
  background:
    #f0f0ed;

  color:
    #555;
}

.dot {
  width:
    6px;

  height:
    6px;

  border-radius:
    999px;

  background:
    currentColor;
}


/* ==========================================================
   DOCUMENTS
========================================================== */

.docs {
  display:
    flex;

  flex-wrap:
    wrap;

  gap:
    6px;
}

.doc {
  display:
    inline-flex;

  align-items:
    center;

  gap:
    5px;

  min-height:
    31px;

  border:
    1px solid #deded9;

  border-radius:
    9px;

  background:
    white;

  padding:
    7px 9px;

  color:
    #222;

  text-decoration:
    none;

  font-size:
    10px;

  font-weight:
    820;

  white-space:
    nowrap;

  transition:
    background .13s ease,
    border-color .13s ease,
    transform .13s ease;
}

.doc:hover {
  border-color:
    #aaa;

  background:
    #f7f7f4;

  transform:
    translateY(-1px);
}

.doc.invoice {
  border-color:
    #d8c8f4;

  background:
    #faf7ff;

  color:
    var(--purple);
}

.doc.disabled {
  opacity:
    .34;

  pointer-events:
    none;
}


/* ==========================================================
   PROCESS
========================================================== */

.process {
  display:
    flex;

  align-items:
    center;

  gap:
    5px;
}

.process-step {
  width:
    25px;

  height:
    7px;

  border-radius:
    999px;

  background:
    #e8e8e4;
}

.process-step.done {
  background:
    #249661;
}

.process-step.failed {
  background:
    #d73d32;
}

.process-label {
  margin-top:
    5px;

  color:
    var(--muted);

  font-size:
    10px;
}


/* ==========================================================
   ACTIONS
========================================================== */

.actions {
  display:
    flex;

  align-items:
    center;

  gap:
    6px;
}

.action {
  border:
    1px solid var(--line);

  border-radius:
    9px;

  background:
    white;

  padding:
    7px 9px;

  color:
    #555;

  font-size:
    10px;

  font-weight:
    820;

  cursor:
    pointer;

  white-space:
    nowrap;

  transition:
    .13s ease;
}

.action:hover {
  border-color:
    #aaa;

  color:
    #111;
}

.action.restore {
  border-color:
    #d9cdf0;

  color:
    var(--purple);
}

.action:disabled {
  opacity:
    .45;

  cursor:
    wait;
}


/* ==========================================================
   ERROR
========================================================== */

.error-message {
  max-width:
    260px;

  margin-top:
    7px;

  color:
    var(--red);

  font-size:
    10px;

  line-height:
    1.35;
}


/* ==========================================================
   EMPTY / LOADING
========================================================== */

.state {
  display:
    flex;

  min-height:
    340px;

  align-items:
    center;

  justify-content:
    center;

  padding:
    40px;

  text-align:
    center;
}

.state-icon {
  width:
    54px;

  height:
    54px;

  display:
    grid;

  place-items:
    center;

  margin:
    0 auto 14px;

  border-radius:
    18px;

  background:
    #f2f2ef;

  font-size:
    23px;
}

.state-title {
  font-size:
    17px;

  font-weight:
    880;
}

.state-text {
  margin-top:
    6px;

  color:
    var(--muted);

  font-size:
    12px;
}


/* ==========================================================
   FOOTER
========================================================== */

.footer {
  display:
    flex;

  justify-content:
    space-between;

  gap:
    20px;

  margin-top:
    13px;

  padding:
    0 4px;

  color:
    #8a8a85;

  font-size:
    10px;
}

#lastUpdate {
  white-space:
    nowrap;
}


/* ==========================================================
   TOAST
========================================================== */

.toast {
  position:
    fixed;

  right:
    22px;

  bottom:
    22px;

  z-index:
    1000;

  max-width:
    360px;

  border:
    1px solid var(--line);

  border-radius:
    14px;

  background:
    #111;

  color:
    #fff;

  padding:
    13px 15px;

  box-shadow:
    0 18px 50px
    rgba(0,0,0,.22);

  font-size:
    12px;

  font-weight:
    720;

  opacity:
    0;

  transform:
    translateY(10px);

  pointer-events:
    none;

  transition:
    opacity .18s ease,
    transform .18s ease;
}

.toast.show {
  opacity:
    1;

  transform:
    translateY(0);
}

.toast.error {
  background:
    #9d2118;
}


/* ==========================================================
   RESPONSIVE
========================================================== */

@media (
  max-width: 1000px
) {

  .stats {
    grid-template-columns:
      repeat(3, 1fr);
  }

  .header {
    align-items:
      flex-start;

    flex-direction:
      column;
  }

  .toolbar {
    align-items:
      stretch;

    flex-direction:
      column;
  }

  .search-wrap {
    width:
      100%;

    max-width:
      none;
  }
}

@media (
  max-width: 650px
) {

  .shell {
    width:
      min(100% - 22px, 1540px);

    padding-top:
      20px;
  }

  .stats {
    grid-template-columns:
      repeat(2, 1fr);
  }

  .stat {
    min-height:
      95px;

    padding:
      15px;
  }

  .stat-number {
    font-size:
      29px;
  }

  .header-side {
    width:
      100%;
  }

  .refresh {
    flex:
      1;
  }

  .secure {
    display:
      none;
  }

  h1 {
    font-size:
      43px;
  }

  .footer {
    flex-direction:
      column;

    gap:
      4px;
  }
}

</style>

</head>


<body>

<div class="shell">

  <header class="header">

    <div>

      <div class="eyebrow">

        <span class="live-dot"></span>

        ALO KIOSK · INTERN

      </div>

      <h1>
        Bestellzentrale
      </h1>

      <div class="subtitle">
        Bestellungen, Versanddokumente und Rechnungsarchiv
        an einem Ort.
      </div>

    </div>


    <div class="header-side">

      <button
        class="refresh"
        id="refreshButton"
        type="button"
      >
        ↻ Aktualisieren
      </button>

      <div class="secure">
        🔒 Geschützt
      </div>

    </div>

  </header>


  <section
    class="stats"
    id="stats"
  >

    <button
      class="stat active"
      data-filter="CURRENT"
      type="button"
    >
      <div
        class="stat-number"
        id="statCurrent"
      >
        —
      </div>

      <div class="stat-label">
        Aktuell
      </div>
    </button>


    <button
      class="stat"
      data-filter="COMPLETED"
      type="button"
    >
      <div
        class="stat-number"
        id="statCompleted"
      >
        —
      </div>

      <div class="stat-label">
        Erledigt
      </div>
    </button>


    <button
      class="stat"
      data-filter="ERROR"
      type="button"
    >
      <div
        class="stat-number"
        id="statError"
      >
        —
      </div>

      <div class="stat-label">
        Fehler
      </div>
    </button>


    <button
      class="stat"
      data-filter="ARCHIVED"
      type="button"
    >
      <div
        class="stat-number"
        id="statArchived"
      >
        —
      </div>

      <div class="stat-label">
        Test / Archiv
      </div>
    </button>


    <button
      class="stat"
      data-filter="ALL"
      type="button"
    >
      <div
        class="stat-number"
        id="statTotal"
      >
        —
      </div>

      <div class="stat-label">
        Alle
      </div>
    </button>

  </section>


  <main class="panel">

    <div class="toolbar">

      <div
        class="tabs"
        id="tabs"
      >

        <button
          class="tab active"
          data-filter="CURRENT"
          type="button"
        >
          Aktuell
        </button>

        <button
          class="tab"
          data-filter="COMPLETED"
          type="button"
        >
          Erledigt
        </button>

        <button
          class="tab"
          data-filter="ERROR"
          type="button"
        >
          Fehler
        </button>

        <button
          class="tab"
          data-filter="ARCHIVED"
          type="button"
        >
          Test / Archiv
        </button>

        <button
          class="tab"
          data-filter="ALL"
          type="button"
        >
          Alle
        </button>

      </div>


      <div class="search-wrap">

        <span class="search-icon">
          ⌕
        </span>

        <input
          class="search"
          id="search"
          type="search"
          placeholder="Bestellung, Rechnung, Tracking suchen …"
          autocomplete="off"
        >

      </div>

    </div>


    <div id="content">

      <div class="state">

        <div>

          <div class="state-icon">
            …
          </div>

          <div class="state-title">
            Bestellungen werden geladen
          </div>

        </div>

      </div>

    </div>

  </main>


  <div class="footer">

    <span>
      ALO KIOSK · Zielempgasse 17 · 4600 Olten
    </span>

    <span id="lastUpdate">
      Noch nicht aktualisiert
    </span>

  </div>

</div>


<div
  class="toast"
  id="toast"
></div>


<script>

(() => {

  "use strict";


  let orders = [];

  let activeFilter =
    "CURRENT";

  let searchValue =
    "";

  let loading =
    false;


  const content =
    document.getElementById(
      "content"
    );

  const search =
    document.getElementById(
      "search"
    );

  const refreshButton =
    document.getElementById(
      "refreshButton"
    );

  const toast =
    document.getElementById(
      "toast"
    );


  function escapeHtml(
    value
  ) {

    return String(
      value ?? ""
    )
      .replaceAll(
        "&",
        "&amp;"
      )
      .replaceAll(
        "<",
        "&lt;"
      )
      .replaceAll(
        ">",
        "&gt;"
      )
      .replaceAll(
        '"',
        "&quot;"
      )
      .replaceAll(
        "'",
        "&#039;"
      );
  }


  function showToast(
    message,
    isError = false
  ) {

    toast.textContent =
      message;

    toast.classList.toggle(
      "error",
      isError
    );

    toast.classList.add(
      "show"
    );

    window.clearTimeout(
      showToast.timer
    );

    showToast.timer =
      window.setTimeout(
        () => {

          toast.classList.remove(
            "show"
          );

        },
        2600
      );
  }


  function formatDate(
    value
  ) {

    if (!value) {
      return "—";
    }

    const date =
      new Date(
        value
      );

    if (
      Number.isNaN(
        date.getTime()
      )
    ) {
      return "—";
    }

    return new Intl.DateTimeFormat(
      "de-CH",
      {
        day:
          "2-digit",

        month:
          "2-digit",

        year:
          "numeric",

        hour:
          "2-digit",

        minute:
          "2-digit",
      }
    ).format(
      date
    );
  }


  function statusBadge(
    order
  ) {

    const status =
      order.dashboard_status;

    if (
      status ===
      "COMPLETED"
    ) {
      return \`
        <span class="badge completed">
          <span class="dot"></span>
          Erledigt
        </span>
      \`;
    }

    if (
      status ===
      "ERROR"
    ) {
      return \`
        <span class="badge error">
          <span class="dot"></span>
          Fehler
        </span>
      \`;
    }

    if (
      status ===
      "ARCHIVED"
    ) {
      return \`
        <span class="badge archived">
          <span class="dot"></span>
          \${order.is_test
            ? "Test / Archiv"
            : "Archiv"}
        </span>
      \`;
    }

    return \`
      <span class="badge current">
        <span class="dot"></span>
        Aktuell
      </span>
    \`;
  }


  function shippingBadge(
    order
  ) {

    if (
      order.label_mode ===
      "PICKUP"
    ) {
      return \`
        <span class="badge pickup">
          Abholung
        </span>
      \`;
    }

    const service =
      order.service
        ? escapeHtml(
            order.service
          )
        : "Versand";

    return \`
      <span class="badge shipping">
        \${service}
      </span>
    \`;
  }


  function documentButton(
    url,
    label,
    extraClass = ""
  ) {

    if (!url) {

      return \`
        <span
          class="doc disabled \${extraClass}"
        >
          \${label}
        </span>
      \`;
    }

    return \`
      <a
        class="doc \${extraClass}"
        href="\${url}"
        target="_blank"
        rel="noopener"
      >
        ↗ \${label}
      </a>
    \`;
  }


  function documents(
    order
  ) {

    const labelUrl =
      order.label_id
        ? "/api/shipping/labels/"
          + encodeURIComponent(
              order.label_id
            )
          + "/pdf"
        : null;

    const slipUrl =
      order.packing_slip_id
        ? "/api/shipping/packing-slips/"
          + encodeURIComponent(
              order.packing_slip_id
            )
          + "/pdf"
        : null;

    const invoiceUrl =
      order.invoice_id
        ? "/api/shipping/invoices/"
          + encodeURIComponent(
              order.invoice_id
            )
          + "/pdf"
        : null;

    return \`
      <div class="docs">

        \${documentButton(
          labelUrl,
          "Label"
        )}

        \${documentButton(
          slipUrl,
          "Lieferschein"
        )}

        \${documentButton(
          invoiceUrl,
          order.invoice_number
            ? escapeHtml(
                order.invoice_number
              )
            : "Rechnung",
          "invoice"
        )}

      </div>
    \`;
  }


  function processStepClass(
    status,
    printStatus
  ) {

    if (
      status === "FAILED" ||
      printStatus === "FAILED"
    ) {
      return "failed";
    }

    if (
      status === "COMPLETED" &&
      printStatus === "PRINTED"
    ) {
      return "done";
    }

    return "";
  }


  function processHtml(
    order
  ) {

    const label =
      processStepClass(
        order.label_status,
        order.label_print_status
      );

    let slip =
      processStepClass(
        order.packing_slip_status,
        order.packing_slip_print_status
      );

    let invoice =
      processStepClass(
        order.invoice_status,
        order.invoice_print_status
      );

    if (
      order.label_mode ===
      "PICKUP" &&
      label === "done"
    ) {
      slip =
        "done";

      invoice =
        "done";
    }

    return \`
      <div>

        <div class="process">

          <span
            class="process-step \${label}"
            title="Versandlabel"
          ></span>

          <span
            class="process-step \${slip}"
            title="Lieferschein"
          ></span>

          <span
            class="process-step \${invoice}"
            title="Rechnung"
          ></span>

        </div>

        <div class="process-label">
          Label · Lieferschein · Rechnung
        </div>

      </div>
    \`;
  }


  function errorHtml(
    order
  ) {

    const error =
      order.label_error_message ||
      order.packing_slip_error_message ||
      order.invoice_error_message;

    if (!error) {
      return "";
    }

    return \`
      <div class="error-message">
        \${escapeHtml(
          error
        )}
      </div>
    \`;
  }


  function moneyHtml(
    order
  ) {

    if (
      order.total_amount === null ||
      order.total_amount === undefined
    ) {
      return \`
        <span class="muted">
          —
        </span>
      \`;
    }

    return \`
      <span class="money">
        \${escapeHtml(
          order.total_amount
        )}
        \${escapeHtml(
          order.currency || ""
        )}
      </span>
    \`;
  }


  function actionHtml(
    order
  ) {

    const encoded =
      encodeURIComponent(
        order.shopify_order_id
      );

    if (
      order.is_archived
    ) {
      return \`
        <div class="actions">

          <button
            class="action restore"
            type="button"
            data-action="restore"
            data-id="\${encoded}"
            data-order="\${escapeHtml(
              order.shopify_order_name
            )}"
          >
            Wiederherstellen
          </button>

        </div>
      \`;
    }

    return \`
      <div class="actions">

        <button
          class="action"
          type="button"
          data-action="archive"
          data-id="\${encoded}"
          data-order="\${escapeHtml(
            order.shopify_order_name
          )}"
        >
          Archivieren
        </button>

      </div>
    \`;
  }


  function filteredOrders() {

    const query =
      searchValue
        .trim()
        .toLowerCase();

    return orders.filter(
      order => {

        if (
          activeFilter !==
            "ALL" &&
          order.dashboard_status !==
            activeFilter
        ) {
          return false;
        }

        if (!query) {
          return true;
        }

        const haystack = [
          order.shopify_order_name,
          order.invoice_number,
          order.tracking_number,
          order.swisspost_ident_code,
          order.service,
          order.total_amount,
          order.currency,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(
          query
        );
      }
    );
  }


  function updateStats() {

    const current =
      orders.filter(
        x =>
          x.dashboard_status ===
          "CURRENT"
      ).length;

    const completed =
      orders.filter(
        x =>
          x.dashboard_status ===
          "COMPLETED"
      ).length;

    const error =
      orders.filter(
        x =>
          x.dashboard_status ===
          "ERROR"
      ).length;

    const archived =
      orders.filter(
        x =>
          x.dashboard_status ===
          "ARCHIVED"
      ).length;

    document.getElementById(
      "statCurrent"
    ).textContent =
      String(current);

    document.getElementById(
      "statCompleted"
    ).textContent =
      String(completed);

    document.getElementById(
      "statError"
    ).textContent =
      String(error);

    document.getElementById(
      "statArchived"
    ).textContent =
      String(archived);

    document.getElementById(
      "statTotal"
    ).textContent =
      String(
        orders.length
      );
  }


  function updateActiveControls() {

    document
      .querySelectorAll(
        "[data-filter]"
      )
      .forEach(
        element => {

          element.classList.toggle(
            "active",
            element.dataset.filter ===
              activeFilter
          );
        }
      );
  }


  function render() {

    updateStats();
    updateActiveControls();

    const visible =
      filteredOrders();

    if (
      visible.length === 0
    ) {

      let title =
        "Keine Bestellungen";

      let text =
        "Für diese Ansicht gibt es momentan keine Einträge.";

      if (
        activeFilter ===
        "CURRENT"
      ) {
        title =
          "Alles erledigt";

        text =
          "Momentan gibt es keine offenen Bestellungen.";
      }

      if (
        activeFilter ===
        "ERROR"
      ) {
        title =
          "Keine Fehler";

        text =
          "Aktuell sind keine problematischen Bestellungen vorhanden.";
      }

      if (
        activeFilter ===
        "ARCHIVED"
      ) {
        title =
          "Archiv ist leer";

        text =
          "Es wurden noch keine Bestellungen archiviert.";
      }

      if (
        searchValue.trim()
      ) {
        title =
          "Keine Treffer";

        text =
          "Keine Bestellung passt zu deiner Suche.";
      }

      content.innerHTML = \`
        <div class="state">

          <div>

            <div class="state-icon">
              ✓
            </div>

            <div class="state-title">
              \${title}
            </div>

            <div class="state-text">
              \${text}
            </div>

          </div>

        </div>
      \`;

      return;
    }


    const rows =
      visible
        .map(
          order => {

            const date =
              order.order_created_at ||
              order.latest_created_at;

            return \`
              <tr>

                <td>

                  <div class="order-number">
                    \${escapeHtml(
                      order.shopify_order_name
                    )}
                  </div>

                  <div class="order-date">
                    \${escapeHtml(
                      formatDate(
                        date
                      )
                    )}
                  </div>

                </td>


                <td>

                  \${statusBadge(
                    order
                  )}

                  \${errorHtml(
                    order
                  )}

                </td>


                <td>
                  \${shippingBadge(
                    order
                  )}
                </td>


                <td>
                  \${processHtml(
                    order
                  )}
                </td>


                <td>
                  \${documents(
                    order
                  )}
                </td>


                <td>
                  \${moneyHtml(
                    order
                  )}
                </td>


                <td>

                  <div>
                    \${order.invoice_number
                      ? escapeHtml(
                          order.invoice_number
                        )
                      : '<span class="muted">—</span>'}
                  </div>

                </td>


                <td>
                  \${actionHtml(
                    order
                  )}
                </td>

              </tr>
            \`;
          }
        )
        .join("");


    content.innerHTML = \`

      <div class="table-wrap">

        <table>

          <thead>

            <tr>

              <th>
                Bestellung
              </th>

              <th>
                Status
              </th>

              <th>
                Versand
              </th>

              <th>
                Prozess
              </th>

              <th>
                Dokumente
              </th>

              <th>
                Betrag
              </th>

              <th>
                Rechnung
              </th>

              <th>
                Aktion
              </th>

            </tr>

          </thead>

          <tbody>
            \${rows}
          </tbody>

        </table>

      </div>
    \`;
  }


  async function loadOrders(
    silent = false
  ) {

    if (loading) {
      return;
    }

    loading =
      true;

    refreshButton.disabled =
      true;

    if (!silent) {

      refreshButton.textContent =
        "↻ Lädt …";
    }

    try {

      const response =
        await fetch(
          "/api/shipping/orders",
          {
            cache:
              "no-store",
          }
        );

      if (!response.ok) {

        throw new Error(
          "HTTP " +
          response.status
        );
      }

      const data =
        await response.json();

      if (
        !data.ok ||
        !Array.isArray(
          data.orders
        )
      ) {

        throw new Error(
          data.error ||
          "Ungültige API-Antwort"
        );
      }

      orders =
        data.orders;

      render();

      document.getElementById(
        "lastUpdate"
      ).textContent =
        "Aktualisiert: " +
        new Intl.DateTimeFormat(
          "de-CH",
          {
            hour:
              "2-digit",

            minute:
              "2-digit",

            second:
              "2-digit",
          }
        ).format(
          new Date()
        );

    } catch (error) {

      console.error(
        error
      );

      if (
        orders.length === 0
      ) {

        content.innerHTML = \`
          <div class="state">

            <div>

              <div class="state-icon">
                !
              </div>

              <div class="state-title">
                Bestellzentrale nicht erreichbar
              </div>

              <div class="state-text">
                Daten konnten nicht geladen werden.
              </div>

            </div>

          </div>
        \`;
      }

      showToast(
        "Bestellungen konnten nicht geladen werden.",
        true
      );

    } finally {

      loading =
        false;

      refreshButton.disabled =
        false;

      refreshButton.textContent =
        "↻ Aktualisieren";
    }
  }


  async function changeArchiveStatus(
    button
  ) {

    const action =
      button.dataset.action;

    const encodedId =
      button.dataset.id;

    const orderName =
      button.dataset.order ||
      "Bestellung";

    if (
      !action ||
      !encodedId
    ) {
      return;
    }

    const isArchive =
      action ===
      "archive";

    const question =
      isArchive
        ? orderName +
          " ins Test/Archiv verschieben?"
        : orderName +
          " wieder in die aktive Übersicht holen?";

    if (
      !window.confirm(
        question
      )
    ) {
      return;
    }

    button.disabled =
      true;

    const endpoint =
      isArchive
        ? "/api/shipping/orders/archive"
        : "/api/shipping/orders/restore";

    try {

      const response =
        await fetch(
          endpoint,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                shopifyOrderId:
                  decodeURIComponent(
                    encodedId
                  ),
              }),
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data.ok
      ) {

        throw new Error(
          data.error ||
          "Aktion fehlgeschlagen"
        );
      }

      showToast(
        isArchive
          ? orderName +
            " wurde archiviert."
          : orderName +
            " wurde wiederhergestellt."
      );

      await loadOrders(
        true
      );

    } catch (error) {

      console.error(
        error
      );

      showToast(
        error?.message ||
        "Aktion fehlgeschlagen.",
        true
      );

      button.disabled =
        false;
    }
  }


  document
    .querySelectorAll(
      "[data-filter]"
    )
    .forEach(
      element => {

        element.addEventListener(
          "click",
          () => {

            activeFilter =
              element.dataset.filter ||
              "CURRENT";

            render();
          }
        );
      }
    );


  search.addEventListener(
    "input",
    () => {

      searchValue =
        search.value;

      render();
    }
  );


  refreshButton.addEventListener(
    "click",
    () => {

      loadOrders();
    }
  );


  content.addEventListener(
    "click",
    event => {

      const button =
        event.target.closest(
          "[data-action]"
        );

      if (!button) {
        return;
      }

      changeArchiveStatus(
        button
      );
    }
  );


  loadOrders();


  window.setInterval(
    () => {

      loadOrders(
        true
      );

    },
    30000
  );

})();

</script>

</body>

</html>
      `);
  }
);
