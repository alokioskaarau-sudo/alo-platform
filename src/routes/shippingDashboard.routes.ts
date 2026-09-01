import express from "express";

import {
  requirePrintAgentToken,
} from "../middleware/printAgentAuth.js";

import {
  getShippingDashboardLabels,
  getShippingLabelPdf,
  createPrintJob,
  claimNextPrintJob,
  completePrintJob,
  failPrintJob,
} from "../database/shippingDashboard.js";


export const shippingDashboardRouter =
  express.Router();


shippingDashboardRouter.use(
  express.json()
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
          "PACKING_SLIP"
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

<title>
  ALO Shipping
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  background:
    #f3f3f1;

  color:
    #151515;

  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

.shell {
  width:
    min(1500px, 96%);

  margin:
    0 auto;

  padding:
    32px 0 70px;
}

.top {
  display:
    flex;

  justify-content:
    space-between;

  align-items:
    flex-end;

  gap:
    20px;

  margin-bottom:
    26px;
}

.brand {
  font-size:
    13px;

  font-weight:
    800;

  letter-spacing:
    .18em;

  text-transform:
    uppercase;

  opacity:
    .5;
}

h1 {
  font-size:
    clamp(
      32px,
      5vw,
      60px
    );

  line-height:
    .95;

  margin:
    7px 0 0;

  letter-spacing:
    -.055em;
}

.mode {
  background:
    #151515;

  color:
    #fff;

  border-radius:
    999px;

  padding:
    10px 15px;

  font-size:
    12px;

  font-weight:
    800;
}

.stats {
  display:
    grid;

  grid-template-columns:
    repeat(
      5,
      1fr
    );

  gap:
    12px;

  margin-bottom:
    18px;
}

.card {
  background:
    #fff;

  border:
    1px solid #e5e5e1;

  border-radius:
    18px;

  padding:
    19px;
}

.stat-value {
  font-size:
    31px;

  font-weight:
    850;

  letter-spacing:
    -.04em;
}

.stat-name {
  margin-top:
    4px;

  font-size:
    12px;

  opacity:
    .5;

  font-weight:
    700;
}

.panel {
  background:
    #fff;

  border:
    1px solid #e4e4df;

  border-radius:
    22px;

  overflow:
    hidden;
}

.toolbar {
  display:
    flex;

  gap:
    10px;

  padding:
    17px;

  border-bottom:
    1px solid #ecece8;
}

.search {
  width:
    100%;

  max-width:
    420px;

  border:
    1px solid #deded9;

  border-radius:
    12px;

  padding:
    12px 14px;

  font-size:
    14px;

  outline:
    none;
}

.table-wrap {
  overflow-x:
    auto;
}

table {
  width:
    100%;

  border-collapse:
    collapse;
}

th {
  padding:
    13px 16px;

  text-align:
    left;

  font-size:
    11px;

  letter-spacing:
    .08em;

  text-transform:
    uppercase;

  opacity:
    .45;

  white-space:
    nowrap;
}

td {
  padding:
    15px 16px;

  border-top:
    1px solid #eeeeea;

  font-size:
    13px;

  vertical-align:
    middle;
}

.order {
  font-weight:
    850;
}

.small {
  margin-top:
    3px;

  font-size:
    11px;

  opacity:
    .55;
}

.badge {
  display:
    inline-flex;

  border-radius:
    999px;

  padding:
    7px 9px;

  background:
    #eeeeea;

  font-size:
    10px;

  font-weight:
    850;

  white-space:
    nowrap;
}

.badge.good {
  background:
    #daf2dd;
}

.badge.wait {
  background:
    #fff0ca;
}

.badge.bad {
  background:
    #ffdcdc;
}

.actions {
  display:
    flex;

  gap:
    7px;

  white-space:
    nowrap;
}

button,
.action {
  appearance:
    none;

  text-decoration:
    none;

  border:
    0;

  border-radius:
    10px;

  padding:
    9px 11px;

  background:
    #151515;

  color:
    #fff;

  cursor:
    pointer;

  font-size:
    11px;

  font-weight:
    800;
}

.action.secondary {
  background:
    #eeeeea;

  color:
    #151515;
}

.empty {
  padding:
    50px;

  text-align:
    center;

  opacity:
    .45;
}

@media (
  max-width: 850px
) {
  .stats {
    grid-template-columns:
      repeat(
        2,
        1fr
      );
  }

  .top {
    align-items:
      flex-start;

    flex-direction:
      column;
  }
}

</style>

</head>


<body>

<div class="shell">

  <div class="top">

    <div>

      <div class="brand">
        ALO KIOSK · SHIPPING CONTROL
      </div>

      <h1>
        Versand.
      </h1>

    </div>

    <div class="mode">
      SPECIMEN MODE
    </div>

  </div>


  <div
    class="stats"
    id="stats"
  ></div>


  <div class="panel">

    <div class="toolbar">

      <input
        class="search"
        id="search"
        placeholder="Bestellung oder Tracking suchen..."
      >

    </div>


    <div class="table-wrap">

      <table>

        <thead>

          <tr>
            <th>Bestellung</th>
            <th>Post</th>
            <th>Gewicht</th>
            <th>Tracking</th>
            <th>Label</th>
            <th>Druck</th>
            <th>Aktionen</th>
          </tr>

        </thead>


        <tbody
          id="rows"
        ></tbody>

      </table>

    </div>

  </div>

</div>


<script>

let allLabels = [];


function esc(
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
    );
}


function badge(
  text,
  type
) {
  return (
    '<span class="badge ' +
    esc(type || "") +
    '">' +
    esc(text) +
    '</span>'
  );
}


async function load() {
  const response =
    await fetch(
      "/api/shipping/dashboard"
    );

  const data =
    await response.json();

  if (!data.ok) {
    throw new Error(
      data.error ||
      "Dashboard konnte nicht geladen werden."
    );
  }

  allLabels =
    data.labels ||
    [];

  renderStats(
    data.stats
  );

  renderRows(
    allLabels
  );
}


function renderStats(
  stats
) {
  const values = [
    [
      "Labels",
      stats.total
    ],

    [
      "Bereit",
      stats.ready
    ],

    [
      "Queue",
      stats.queued
    ],

    [
      "Gedruckt",
      stats.printed
    ],

    [
      "Fehler",
      stats.failed
    ]
  ];

  document
    .getElementById(
      "stats"
    )
    .innerHTML =
      values
        .map(
          function (
            item
          ) {
            return (
              '<div class="card">' +
                '<div class="stat-value">' +
                  esc(item[1]) +
                '</div>' +

                '<div class="stat-name">' +
                  esc(item[0]) +
                '</div>' +
              '</div>'
            );
          }
        )
        .join("");
}


function renderRows(
  labels
) {
  const rows =
    document.getElementById(
      "rows"
    );

  if (
    !labels.length
  ) {
    rows.innerHTML =
      '<tr>' +
        '<td colspan="7" class="empty">' +
          'Noch keine Versandlabels vorhanden.' +
        '</td>' +
      '</tr>';

    return;
  }


  rows.innerHTML =
    labels
      .map(
        function (
          label
        ) {
          const tracking =
            label.tracking_number ||
            label.swisspost_ident_code ||
            "—";


          let printType =
            "";

          if (
            label.print_status ===
            "PRINTED"
          ) {
            printType =
              "good";
          }

          if (
            label.print_status ===
              "QUEUED" ||
            label.print_status ===
              "PRINTING"
          ) {
            printType =
              "wait";
          }

          if (
            label.print_status ===
            "FAILED"
          ) {
            printType =
              "bad";
          }


          let labelType =
            "wait";

          if (
            label.status ===
            "COMPLETED"
          ) {
            labelType =
              "good";
          }

          if (
            label.status ===
            "FAILED"
          ) {
            labelType =
              "bad";
          }


          const weight =
            label.weight_grams
              ? esc(
                  label.weight_grams
                ) +
                " g"
              : "—";


          return (
            '<tr>' +

              '<td>' +
                '<div class="order">' +
                  esc(
                    label.shopify_order_name
                  ) +
                '</div>' +

                '<div class="small">' +
                  esc(
                    label.label_mode
                  ) +
                '</div>' +
              '</td>' +


              '<td>' +
                badge(
                  label.service,
                  ""
                ) +
              '</td>' +


              '<td>' +
                weight +
              '</td>' +


              '<td>' +
                '<div>' +
                  esc(
                    tracking
                  ) +
                '</div>' +
              '</td>' +


              '<td>' +
                badge(
                  label.status,
                  labelType
                ) +
              '</td>' +


              '<td>' +
                badge(
                  label.print_status,
                  printType
                ) +

                '<div class="small">' +
                  esc(
                    label.print_count
                  ) +
                  ' Druck(e)' +
                '</div>' +
              '</td>' +


              '<td>' +

                '<div class="actions">' +

                  '<a ' +
                    'class="action secondary" ' +
                    'target="_blank" ' +
                    'href="/api/shipping/labels/' +
                    encodeURIComponent(
                      label.id
                    ) +
                    '/pdf">' +
                    'PDF' +
                  '</a>' +

                  '<button ' +
                    'data-print-id="' +
                    esc(
                      label.id
                    ) +
                    '">' +
                    'Drucken' +
                  '</button>' +

                '</div>' +

              '</td>' +

            '</tr>'
          );
        }
      )
      .join("");


  document
    .querySelectorAll(
      "[data-print-id]"
    )
    .forEach(
      function (
        button
      ) {
        button.addEventListener(
          "click",

          function () {
            const id =
              button.getAttribute(
                "data-print-id"
              );

            if (id) {
              queuePrint(
                id
              );
            }
          }
        );
      }
    );
}


async function queuePrint(
  id
) {
  const response =
    await fetch(
      "/api/shipping/labels/" +
      encodeURIComponent(
        id
      ) +
      "/print",

      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(
            {}
          )
      }
    );


  const data =
    await response.json();


  if (!data.ok) {
    alert(
      data.error ||
      "Druckauftrag fehlgeschlagen."
    );

    return;
  }


  if (
    data.created
  ) {
    alert(
      "Druckauftrag erstellt."
    );
  } else {
    alert(
      "Dieser Druckauftrag wartet bereits."
    );
  }


  await load();
}


document
  .getElementById(
    "search"
  )
  .addEventListener(
    "input",

    function (
      event
    ) {
      const target =
        event.target;

      const value =
        String(
          target.value ||
          ""
        )
          .toLowerCase()
          .trim();


      const filtered =
        allLabels.filter(
          function (
            label
          ) {
            const haystack =
              [
                label.shopify_order_name,
                label.swisspost_ident_code,
                label.tracking_number,
                label.service
              ]
                .join(" ")
                .toLowerCase();


            return haystack.includes(
              value
            );
          }
        );


      renderRows(
        filtered
      );
    }
  );


load()
  .catch(
    function (
      error
    ) {
      console.error(
        error
      );

      alert(
        error.message
      );
    }
  );


setInterval(
  function () {
    load()
      .catch(
        console.error
      );
  },
  10000
);

</script>

</body>

</html>
      `);
  }
);
