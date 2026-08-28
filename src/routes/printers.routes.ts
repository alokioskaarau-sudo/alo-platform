import express from "express";

import {
  deletePrinter,
  getDefaultPrinter,
  getPrinterById,
  getPrinters,
  heartbeatPrinter,
  markStalePrintersOffline,
  setDefaultPrinter,
  updatePrinter,
} from "../database/printers.js";

import {
  requirePrintAgentToken,
} from "../middleware/printAgentAuth.js";


export const printersRouter =
  express.Router();

printersRouter.use(
  express.json()
);


// ==========================================================
// ADMIN API: ALLE DRUCKER
// ==========================================================

printersRouter.get(
  "/api/printers",
  async (_req, res) => {
    try {
      // Agent meldet sich später regelmässig.
      // Wenn länger als 60 Sekunden nichts kommt:
      // OFFLINE anzeigen.
      await markStalePrintersOffline(
        60
      );

      const printers =
        await getPrinters();

      const defaultPrinter =
        await getDefaultPrinter();

      return res.json({
        ok: true,

        count:
          printers.length,

        defaultPrinter,

        printers,
      });
    } catch (error: any) {
      console.error(
        "Printers API Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error.message,
        });
    }
  }
);


// ==========================================================
// ADMIN API: EIN DRUCKER
// ==========================================================

printersRouter.get(
  "/api/printers/:id",
  async (req, res) => {
    try {
      const printer =
        await getPrinterById(
          req.params.id
        );

      if (!printer) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Drucker nicht gefunden.",
          });
      }

      return res.json({
        ok: true,
        printer,
      });
    } catch (error: any) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message,
        });
    }
  }
);


// ==========================================================
// ADMIN API: STANDARD-DRUCKER SETZEN
// ==========================================================

printersRouter.post(
  "/api/printers/:id/default",
  async (req, res) => {
    try {
      const printer =
        await setDefaultPrinter(
          req.params.id
        );

      return res.json({
        ok: true,
        printer,
      });
    } catch (error: any) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            error.message,
        });
    }
  }
);


// ==========================================================
// ADMIN API: DRUCKER BEARBEITEN
// ==========================================================

printersRouter.patch(
  "/api/printers/:id",
  async (req, res) => {
    try {
      const displayName =
        typeof req.body
          ?.displayName ===
        "string"
          ? req.body
              .displayName
              .trim()
          : undefined;

      const location =
        typeof req.body
          ?.location ===
        "string"
          ? req.body
              .location
              .trim()
          : undefined;

      const paperSize =
        typeof req.body
          ?.paperSize ===
        "string"
          ? req.body
              .paperSize
              .trim()
          : undefined;

      const printer =
        await updatePrinter(
          req.params.id,
          {
            displayName,
            location,
            paperSize,
          }
        );

      return res.json({
        ok: true,
        printer,
      });
    } catch (error: any) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            error.message,
        });
    }
  }
);


// ==========================================================
// ADMIN API: DRUCKER LÖSCHEN
// ==========================================================

printersRouter.delete(
  "/api/printers/:id",
  async (req, res) => {
    try {
      const deleted =
        await deletePrinter(
          req.params.id
        );

      if (!deleted) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Drucker nicht gefunden.",
          });
      }

      return res.json({
        ok: true,
      });
    } catch (error: any) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message,
        });
    }
  }
);


// ==========================================================
// PRINT AGENT: HEARTBEAT
// ==========================================================
//
// Dieser Endpoint ist NICHT öffentlich.
// Der Windows-Agent muss PRINT_AGENT_TOKEN senden.
//
// Später sendet der Windows-PC etwa alle 15 Sekunden:
//
// {
//   "name": "Brother QL-1110NWB",
//   "displayName": "Versanddrucker Aarau",
//   "location": "Aarau",
//   "platform": "windows",
//   "deviceName": "ALO-SHIPPING-PC",
//   "driverName": "...",
//   "portName": "...",
//   "paperSize": "102mm",
//   "agentVersion": "1.0.0"
// }
// ==========================================================

printersRouter.post(
  "/api/print-agent/printers/heartbeat",

  requirePrintAgentToken,

  async (req, res) => {
    try {
      const name =
        String(
          req.body?.name ?? ""
        ).trim();

      if (!name) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Printer name fehlt.",
          });
      }

      const displayName =
        typeof req.body
          ?.displayName ===
        "string"
          ? req.body
              .displayName
              .trim()
          : undefined;

      const location =
        typeof req.body
          ?.location ===
        "string"
          ? req.body
              .location
              .trim()
          : undefined;

      const platform =
        typeof req.body
          ?.platform ===
        "string"
          ? req.body
              .platform
              .trim()
          : undefined;

      const agentVersion =
        typeof req.body
          ?.agentVersion ===
        "string"
          ? req.body
              .agentVersion
              .trim()
          : undefined;

      const deviceName =
        typeof req.body
          ?.deviceName ===
        "string"
          ? req.body
              .deviceName
              .trim()
          : undefined;

      const driverName =
        typeof req.body
          ?.driverName ===
        "string"
          ? req.body
              .driverName
              .trim()
          : undefined;

      const portName =
        typeof req.body
          ?.portName ===
        "string"
          ? req.body
              .portName
              .trim()
          : undefined;

      const paperSize =
        typeof req.body
          ?.paperSize ===
        "string"
          ? req.body
              .paperSize
              .trim()
          : undefined;

      const capabilities =
        req.body?.capabilities &&
        typeof req.body
          .capabilities ===
          "object"
          ? req.body
              .capabilities
          : undefined;

      const printer =
        await heartbeatPrinter(
          name,
          {
            status:
              "ONLINE",

            agentVersion,

            deviceName,

            driverName,

            portName,

            paperSize,

            capabilities,
          }
        );

      // Felder, die eher Admin-Konfiguration
      // als Hardware-Daten sind,
      // separat aktualisieren.

      let finalPrinter =
        printer;

      if (
        displayName ||
        location ||
        paperSize
      ) {
        finalPrinter =
          await updatePrinter(
            printer.id,
            {
              displayName,

              location,

              paperSize,
            }
          );
      }

      return res.json({
        ok: true,

        printer:
          finalPrinter,
      });
    } catch (error: any) {
      console.error(
        "Printer Heartbeat Error:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error.message,
        });
    }
  }
);


// ==========================================================
// VISUELLE DRUCKER-OBERFLÄCHE
// ==========================================================

printersRouter.get(
  "/printers",
  (_req, res) => {
    res
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

<title>ALO Shipping · Drucker</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  background:
    #f6f6f3;

  color:
    #171717;

  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

.shell {
  width:
    min(
      1240px,
      94%
    );

  margin:
    0 auto;

  padding:
    32px 0 80px;
}

.topbar {
  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  gap:
    20px;

  margin-bottom:
    35px;
}

.brand {
  font-size:
    12px;

  font-weight:
    800;

  letter-spacing:
    .14em;

  text-transform:
    uppercase;

  opacity:
    .48;
}

h1 {
  margin:
    7px 0 0;

  font-size:
    clamp(
      34px,
      6vw,
      64px
    );

  line-height:
    .95;

  letter-spacing:
    -.055em;
}

.back {
  text-decoration:
    none;

  color:
    #171717;

  background:
    white;

  border:
    1px solid #e4e4df;

  padding:
    11px 15px;

  border-radius:
    12px;

  font-size:
    12px;

  font-weight:
    750;
}

.status-panel {
  display:
    grid;

  grid-template-columns:
    1fr 1fr 1fr;

  gap:
    12px;

  margin-bottom:
    22px;
}

.stat {
  background:
    white;

  border:
    1px solid #e4e4df;

  border-radius:
    18px;

  padding:
    19px;
}

.stat-number {
  font-size:
    30px;

  font-weight:
    850;

  letter-spacing:
    -.04em;
}

.stat-label {
  margin-top:
    4px;

  font-size:
    11px;

  font-weight:
    700;

  opacity:
    .45;
}

.section-title {
  margin:
    34px 0 14px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  gap:
    15px;
}

.section-title h2 {
  margin:
    0;

  font-size:
    20px;

  letter-spacing:
    -.025em;
}

.refresh {
  border:
    0;

  border-radius:
    10px;

  padding:
    9px 12px;

  cursor:
    pointer;

  background:
    #171717;

  color:
    white;

  font-size:
    11px;

  font-weight:
    750;
}

.printers {
  display:
    grid;

  grid-template-columns:
    repeat(
      2,
      minmax(
        0,
        1fr
      )
    );

  gap:
    14px;
}

.printer {
  background:
    white;

  border:
    1px solid #e3e3de;

  border-radius:
    22px;

  padding:
    21px;

  position:
    relative;

  overflow:
    hidden;
}

.printer.default {
  border:
    2px solid #171717;
}

.printer-top {
  display:
    flex;

  align-items:
    flex-start;

  gap:
    16px;
}

.icon {
  width:
    62px;

  height:
    62px;

  border-radius:
    18px;

  background:
    #f0f0ec;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  flex:
    0 0 auto;
}

.icon svg {
  width:
    31px;

  height:
    31px;
}

.printer-name {
  font-size:
    18px;

  font-weight:
    850;

  letter-spacing:
    -.02em;
}

.system-name {
  margin-top:
    4px;

  font-size:
    11px;

  opacity:
    .45;

  word-break:
    break-word;
}

.badges {
  display:
    flex;

  flex-wrap:
    wrap;

  gap:
    6px;

  margin-top:
    11px;
}

.badge {
  padding:
    6px 9px;

  border-radius:
    999px;

  background:
    #eeeeea;

  font-size:
    10px;

  font-weight:
    800;
}

.badge.online {
  background:
    #dff3e2;
}

.badge.offline {
  background:
    #ededeb;
}

.badge.error {
  background:
    #ffdede;
}

.badge.default {
  background:
    #171717;

  color:
    white;
}

.details {
  display:
    grid;

  grid-template-columns:
    1fr 1fr;

  gap:
    10px;

  margin-top:
    20px;
}

.detail {
  background:
    #f7f7f4;

  border-radius:
    12px;

  padding:
    11px;
}

.detail-label {
  font-size:
    9px;

  text-transform:
    uppercase;

  letter-spacing:
    .08em;

  opacity:
    .42;

  font-weight:
    800;
}

.detail-value {
  margin-top:
    4px;

  font-size:
    12px;

  font-weight:
    700;

  overflow:
    hidden;

  text-overflow:
    ellipsis;

  white-space:
    nowrap;
}

.actions {
  display:
    flex;

  gap:
    8px;

  margin-top:
    18px;

  flex-wrap:
    wrap;
}

button {
  border:
    0;

  border-radius:
    10px;

  padding:
    10px 12px;

  cursor:
    pointer;

  font-size:
    11px;

  font-weight:
    800;
}

.primary {
  background:
    #171717;

  color:
    white;
}

.secondary {
  background:
    #eeeeea;

  color:
    #171717;
}

.danger {
  background:
    #ffe3e3;

  color:
    #8a1111;
}

.empty {
  grid-column:
    1 / -1;

  padding:
    55px 25px;

  background:
    white;

  border:
    1px solid #e4e4df;

  border-radius:
    22px;

  text-align:
    center;
}

.empty-icon {
  width:
    70px;

  height:
    70px;

  margin:
    0 auto 15px;

  background:
    #f0f0ec;

  border-radius:
    20px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;
}

.empty-title {
  font-size:
    18px;

  font-weight:
    850;
}

.empty-text {
  max-width:
    430px;

  margin:
    8px auto 0;

  font-size:
    12px;

  line-height:
    1.6;

  opacity:
    .55;
}

.setup {
  margin-top:
    24px;

  background:
    #171717;

  color:
    white;

  border-radius:
    22px;

  padding:
    24px;
}

.setup-top {
  font-size:
    11px;

  font-weight:
    800;

  letter-spacing:
    .1em;

  text-transform:
    uppercase;

  opacity:
    .5;
}

.setup h3 {
  margin:
    8px 0 5px;

  font-size:
    23px;

  letter-spacing:
    -.03em;
}

.setup p {
  margin:
    0;

  max-width:
    650px;

  font-size:
    12px;

  line-height:
    1.6;

  opacity:
    .65;
}

.steps {
  margin-top:
    18px;

  display:
    grid;

  grid-template-columns:
    repeat(
      4,
      1fr
    );

  gap:
    8px;
}

.step {
  background:
    rgba(
      255,
      255,
      255,
      .08
    );

  border-radius:
    12px;

  padding:
    12px;

  font-size:
    11px;

  font-weight:
    700;
}

.step-num {
  opacity:
    .4;

  margin-bottom:
    5px;
}

@media(
  max-width: 760px
) {

  .printers {
    grid-template-columns:
      1fr;
  }

  .status-panel {
    grid-template-columns:
      1fr;
  }

  .steps {
    grid-template-columns:
      1fr 1fr;
  }

}

</style>

</head>

<body>

<div class="shell">

  <div class="topbar">

    <div>

      <div class="brand">
        ALO KIOSK · SHIPPING
      </div>

      <h1>
        Drucker.
      </h1>

    </div>

    <a
      class="back"
      href="/shipping"
    >
      ← Versand
    </a>

  </div>


  <div
    class="status-panel"
    id="stats"
  >
  </div>


  <div class="section-title">

    <h2>
      Verbundene Geräte
    </h2>

    <button
      class="refresh"
      onclick="loadPrinters()"
    >
      Aktualisieren
    </button>

  </div>


  <div
    class="printers"
    id="printers"
  >
  </div>


  <div class="setup">

    <div class="setup-top">
      Printer Setup
    </div>

    <h3>
      Neuen Drucker verbinden
    </h3>

    <p>
      Sobald der ALO Print Agent
      auf dem Windows-PC installiert
      wird, erkennt die Plattform die
      dort verfügbaren Drucker und
      zeigt sie automatisch hier an.
    </p>

    <div class="steps">

      <div class="step">
        <div class="step-num">
          01
        </div>
        Print Agent installieren
      </div>

      <div class="step">
        <div class="step-num">
          02
        </div>
        Brother verbinden
      </div>

      <div class="step">
        <div class="step-num">
          03
        </div>
        Testlabel drucken
      </div>

      <div class="step">
        <div class="step-num">
          04
        </div>
        Als Standard setzen
      </div>

    </div>

  </div>

</div>


<script>

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
    );
}


function printerIcon() {
  return \`
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
    >
      <path
        d="M6 9V3h12v6"
      />
      <path
        d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"
      />
      <rect
        x="6"
        y="14"
        width="12"
        height="7"
      />
    </svg>
  \`;
}


function statusBadge(
  status
) {
  const value =
    String(
      status ||
      "OFFLINE"
    ).toUpperCase();

  const cls =
    value === "ONLINE"
      ? "online"
      : value === "ERROR"
        ? "error"
        : "offline";

  return \`
    <span
      class="badge \${cls}"
    >
      \${esc(value)}
    </span>
  \`;
}


function formatDate(
  value
) {
  if (!value) {
    return "Noch nie";
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

  return date
    .toLocaleString(
      "de-CH"
    );
}


async function loadPrinters() {

  const response =
    await fetch(
      "/api/printers"
    );

  const data =
    await response.json();

  if (!data.ok) {
    throw new Error(
      data.error ||
      "Drucker konnten nicht geladen werden."
    );
  }

  const printers =
    data.printers ||
    [];

  const online =
    printers.filter(
      printer =>
        printer.status ===
        "ONLINE"
    ).length;

  const offline =
    printers.length -
    online;

  document
    .getElementById(
      "stats"
    )
    .innerHTML = \`

      <div class="stat">

        <div class="stat-number">
          \${printers.length}
        </div>

        <div class="stat-label">
          Drucker
        </div>

      </div>


      <div class="stat">

        <div class="stat-number">
          \${online}
        </div>

        <div class="stat-label">
          Online
        </div>

      </div>


      <div class="stat">

        <div class="stat-number">
          \${offline}
        </div>

        <div class="stat-label">
          Offline
        </div>

      </div>

    \`;

  renderPrinters(
    printers
  );
}


function renderPrinters(
  printers
) {

  const container =
    document
      .getElementById(
        "printers"
      );

  if (
    !printers.length
  ) {

    container.innerHTML = \`

      <div class="empty">

        <div class="empty-icon">
          \${printerIcon()}
        </div>

        <div class="empty-title">
          Noch kein Drucker verbunden
        </div>

        <div class="empty-text">

          Alles auf der Server-Seite
          ist vorbereitet.

          Sobald der Windows Print
          Agent läuft, erscheint der
          Brother-Drucker automatisch
          hier.

        </div>

      </div>

    \`;

    return;
  }


  container.innerHTML =
    printers
      .map(
        printer => {

          const title =
            printer.display_name ||
            printer.name;

          return \`

            <div
              class="printer \${printer.is_default
                ? "default"
                : ""
              }"
            >

              <div class="printer-top">

                <div class="icon">
                  \${printerIcon()}
                </div>

                <div>

                  <div class="printer-name">
                    \${esc(title)}
                  </div>

                  <div class="system-name">
                    \${esc(printer.name)}
                  </div>

                  <div class="badges">

                    \${statusBadge(
                      printer.status
                    )}

                    \${printer.is_default
                      ? \`
                        <span
                          class="badge default"
                        >
                          STANDARD
                        </span>
                      \`
                      : ""
                    }

                    \${printer.location
                      ? \`
                        <span class="badge">
                          \${esc(
                            printer.location
                          )}
                        </span>
                      \`
                      : ""
                    }

                  </div>

                </div>

              </div>


              <div class="details">

                <div class="detail">

                  <div class="detail-label">
                    Gerät
                  </div>

                  <div class="detail-value">
                    \${esc(
                      printer.device_name ||
                      "—"
                    )}
                  </div>

                </div>


                <div class="detail">

                  <div class="detail-label">
                    Plattform
                  </div>

                  <div class="detail-value">
                    \${esc(
                      printer.platform ||
                      "—"
                    )}
                  </div>

                </div>


                <div class="detail">

                  <div class="detail-label">
                    Treiber
                  </div>

                  <div class="detail-value">
                    \${esc(
                      printer.driver_name ||
                      "—"
                    )}
                  </div>

                </div>


                <div class="detail">

                  <div class="detail-label">
                    Port
                  </div>

                  <div class="detail-value">
                    \${esc(
                      printer.port_name ||
                      "—"
                    )}
                  </div>

                </div>


                <div class="detail">

                  <div class="detail-label">
                    Papier
                  </div>

                  <div class="detail-value">
                    \${esc(
                      printer.paper_size ||
                      "—"
                    )}
                  </div>

                </div>


                <div class="detail">

                  <div class="detail-label">
                    Zuletzt gesehen
                  </div>

                  <div class="detail-value">
                    \${esc(
                      formatDate(
                        printer.last_seen_at
                      )
                    )}
                  </div>

                </div>

              </div>


              <div class="actions">

                \${!printer.is_default
                  ? \`
                    <button
                      class="primary"
                      onclick="makeDefault(
                        '\${printer.id}'
                      )"
                    >
                      Als Standard
                    </button>
                  \`
                  : ""
                }

                <button
                  class="secondary"
                  onclick="editPrinter(
                    '\${printer.id}',
                    '\${esc(
                      printer.display_name ||
                      ""
                    )}',
                    '\${esc(
                      printer.location ||
                      ""
                    )}'
                  )"
                >
                  Bearbeiten
                </button>

                <button
                  class="danger"
                  onclick="removePrinter(
                    '\${printer.id}'
                  )"
                >
                  Entfernen
                </button>

              </div>

            </div>

          \`;

        }
      )
      .join("");
}


async function makeDefault(
  id
) {

  const response =
    await fetch(
      "/api/printers/" +
      id +
      "/default",
      {
        method:
          "POST"
      }
    );

  const data =
    await response.json();

  if (!data.ok) {

    alert(
      data.error ||
      "Standarddrucker konnte nicht gesetzt werden."
    );

    return;
  }

  await loadPrinters();
}


async function editPrinter(
  id,
  currentName,
  currentLocation
) {

  const name =
    prompt(
      "Anzeigename des Druckers:",
      currentName
    );

  if (
    name === null
  ) {
    return;
  }

  const location =
    prompt(
      "Standort:",
      currentLocation
    );

  if (
    location === null
  ) {
    return;
  }

  const response =
    await fetch(
      "/api/printers/" +
      id,
      {
        method:
          "PATCH",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            displayName:
              name,

            location:
              location,
          }),
      }
    );

  const data =
    await response.json();

  if (!data.ok) {

    alert(
      data.error ||
      "Drucker konnte nicht gespeichert werden."
    );

    return;
  }

  await loadPrinters();
}


async function removePrinter(
  id
) {

  const confirmed =
    confirm(
      "Drucker wirklich entfernen?"
    );

  if (!confirmed) {
    return;
  }

  const response =
    await fetch(
      "/api/printers/" +
      id,
      {
        method:
          "DELETE",
      }
    );

  const data =
    await response.json();

  if (!data.ok) {

    alert(
      data.error ||
      "Drucker konnte nicht entfernt werden."
    );

    return;
  }

  await loadPrinters();
}


loadPrinters()
  .catch(
    error => {
      console.error(
        error
      );

      alert(
        error.message
      );
    }
  );


setInterval(
  () => {
    loadPrinters()
      .catch(
        console.error
      );
  },
  15000
);

</script>

</body>

</html>
    `);
  }
);
