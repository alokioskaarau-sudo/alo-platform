import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";

const AGENT_VERSION = "1.7.0-mac-direct-urf";

const BACKEND_URL =
  (
    process.env.ALO_BACKEND_URL ||
    "https://alo-platform-production.up.railway.app"
  ).replace(/\/+$/, "");

const DEVICE_NAME =
  (
    process.env.ALO_DEVICE_NAME ||
    os.hostname()
  ).trim();

const CONFIG_FILE =
  path.join(
    os.homedir(),
    ".alo-print-connector",
    "device.json"
  );

/*
  FINALER DRUCKER-AUFBAU

  Brother:
  USB -> Versandlabel

  HP:
  Netzwerk -> Lieferschein / später Rechnung
*/
const LABEL_PRINTER_NAME =
  process.env.ALO_LABEL_PRINTER_NAME ||
  "Brother_QL_1110NWB";

const A4_PRINTER_NAME =
  process.env.ALO_A4_PRINTER_NAME ||
  "ALO_HP_A4";

const POLL_MS = 750;
const HEARTBEAT_MS = 20000;

let activeBrotherJobId = null;


/* =========================================================
   LOGGING
========================================================= */

function timestamp() {
  return new Date().toLocaleTimeString(
    "de-CH",
    { hour12: false }
  );
}

function log(message) {
  console.log(
    `[${timestamp()}] ${message}`
  );
}

function logError(message, error) {
  const detail =
    error instanceof Error
      ? error.message
      : String(error);

  console.error(
    `[${timestamp()}] ${message}: ${detail}`
  );
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


/* =========================================================
   DEVICE CONFIG
========================================================= */

function loadDeviceConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      `Geräte-Konfiguration fehlt: ${CONFIG_FILE}`
    );
  }

  const config =
    JSON.parse(
      fs.readFileSync(
        CONFIG_FILE,
        "utf8"
      )
    );

  if (!config?.deviceToken) {
    throw new Error(
      "deviceToken fehlt in der Geräte-Konfiguration."
    );
  }

  return config;
}


/* =========================================================
   BACKEND REQUEST
========================================================= */

async function requestJson(
  endpoint,
  options = {},
  deviceToken = ""
) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (deviceToken) {
    headers.Authorization =
      `Bearer ${deviceToken}`;
  }

  const response =
    await fetch(
      `${BACKEND_URL}${endpoint}`,
      {
        ...options,
        headers,
        signal:
          AbortSignal.timeout(
            15000
          ),
      }
    );

  let data = null;

  try {
    data =
      await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      data?.error ||
      `HTTP ${response.status}`
    );
  }

  return data;
}


/* =========================================================
   CUPS PRINTER
========================================================= */

function findPrinter(
  printerName,
  driverName
) {
  try {
    const output =
      execFileSync(
        "/usr/bin/lpstat",
        [
          "-p",
          printerName,
        ],
        {
          encoding: "utf8",
          timeout: 10000,
        }
      );

    log(
      `CUPS ${printerName}: ${String(output).trim()}`
    );

    return {
      name:
        printerName,

      displayName:
        printerName,

      driverName,

      portName:
        "",

      paperSize:
        null,

      platform:
        "macos",

      status:
        "ONLINE",

      agentVersion:
        AGENT_VERSION,

      deviceName:
        DEVICE_NAME,
    };

  } catch (error) {
    throw new Error(
      `Drucker "${printerName}" ist in CUPS nicht verfügbar: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }
}


/* =========================================================
   HEARTBEAT
========================================================= */

async function heartbeat(
  printer,
  deviceToken
) {
  return requestJson(
    "/api/print-agent/printers/heartbeat",
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify(
          printer
        ),
    },
    deviceToken
  );
}


/* =========================================================
   PRINT QUEUE API
========================================================= */

async function claimNextJob(
  printerName,
  documentType,
  deviceToken
) {
  return requestJson(
    "/api/print-agent/jobs/next",
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify({
          printerName,
          documentType,
        }),
    },
    deviceToken
  );
}


async function completeJob(
  jobId,
  deviceToken
) {
  return requestJson(
    `/api/print-agent/jobs/${jobId}/complete`,
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify({}),
    },
    deviceToken
  );
}


async function failJob(
  jobId,
  errorMessage,
  retryable,
  deviceToken
) {
  return requestJson(
    `/api/print-agent/jobs/${jobId}/fail`,
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify({
          error:
            errorMessage,
          retryable:
            retryable !== false,
        }),
    },
    deviceToken
  );
}


/* =========================================================
   TEMP PDF
========================================================= */


/* =========================================================
   ORDER ALERT API
========================================================= */

async function claimNextOrderAlert(
  deviceToken
) {
  return requestJson(
    "/api/print-agent/order-alerts/next",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body:
        JSON.stringify({}),
    },
    deviceToken
  );
}


async function completeOrderAlert(
  alertId,
  deviceToken
) {
  return requestJson(
    `/api/print-agent/order-alerts/${alertId}/complete`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
      },
      body:
        JSON.stringify({}),
    },
    deviceToken
  );
}


/* =========================================================
   MAC ORDER ALERT
========================================================= */

function runDetached(
  command,
  args
) {
  const child =
    spawn(
      command,
      args,
      {
        detached: true,
        stdio: "ignore",
      }
    );

  child.unref();
}


function getAlertSound(
  total
) {
  const candidates =
    total >= 200
      ? [
          "/System/Library/Sounds/Sosumi.aiff",
          "/System/Library/Sounds/Hero.aiff",
          "/System/Library/Sounds/Glass.aiff",
        ]
      : total >= 100
        ? [
            "/System/Library/Sounds/Hero.aiff",
            "/System/Library/Sounds/Glass.aiff",
            "/System/Library/Sounds/Ping.aiff",
          ]
        : [
            "/System/Library/Sounds/Glass.aiff",
            "/System/Library/Sounds/Ping.aiff",
          ];

  return (
    candidates.find(
      sound =>
        fs.existsSync(sound)
    ) || null
  );
}


let previousOutputVolume = null;
let previousOutputMuted = null;
let restoreVolumeTimer = null;


function getMacVolumeState() {
  try {
    const volume =
      execFileSync(
        "/usr/bin/osascript",
        [
          "-e",
          "output volume of (get volume settings)",
        ],
        {
          encoding: "utf8",
          timeout: 5000,
        }
      )
        .trim();

    const muted =
      execFileSync(
        "/usr/bin/osascript",
        [
          "-e",
          "output muted of (get volume settings)",
        ],
        {
          encoding: "utf8",
          timeout: 5000,
        }
      )
        .trim();

    return {
      volume:
        Math.max(
          0,
          Math.min(
            100,
            Number(volume) || 0
          )
        ),

      muted:
        muted === "true",
    };

  } catch (error) {
    logError(
      "Mac Lautstärke konnte nicht gelesen werden",
      error
    );

    return null;
  }
}


function forceMaximumAlertVolume() {
  try {
    if (
      previousOutputVolume === null
    ) {
      const state =
        getMacVolumeState();

      if (state) {
        previousOutputVolume =
          state.volume;

        previousOutputMuted =
          state.muted;
      }
    }

    execFileSync(
      "/usr/bin/osascript",
      [
        "-e",
        "set volume output muted false",
        "-e",
        "set volume output volume 100",
      ],
      {
        encoding: "utf8",
        timeout: 5000,
      }
    );

    if (restoreVolumeTimer) {
      clearTimeout(
        restoreVolumeTimer
      );
    }

    restoreVolumeTimer =
      setTimeout(
        () => {
          try {
            if (
              previousOutputVolume !==
              null
            ) {
              execFileSync(
                "/usr/bin/osascript",
                [
                  "-e",
                  `set volume output volume ${previousOutputVolume}`,
                  "-e",
                  `set volume output muted ${
                    previousOutputMuted
                      ? "true"
                      : "false"
                  }`,
                ],
                {
                  encoding: "utf8",
                  timeout: 5000,
                }
              );
            }
          } catch (error) {
            logError(
              "Mac Lautstärke konnte nicht zurückgesetzt werden",
              error
            );
          } finally {
            previousOutputVolume =
              null;

            previousOutputMuted =
              null;

            restoreVolumeTimer =
              null;
          }
        },
        9000
      );

  } catch (error) {
    logError(
      "Maximale Alarm-Lautstärke konnte nicht gesetzt werden",
      error
    );
  }
}


function playSoundFile(
  soundName,
  delay
) {
  const sound =
    `/System/Library/Sounds/${soundName}.aiff`;

  if (
    !fs.existsSync(sound)
  ) {
    return;
  }

  setTimeout(
    () => {
      runDetached(
        "/usr/bin/afplay",
        [sound]
      );
    },
    delay
  );
}


function speakOrderAlert(
  orderName,
  total,
  currency
) {
  const cleanOrderName =
    String(orderName)
      .replace("#", "")
      .trim();

  const spokenText =
    total >= 100
      ? `Achtung. Grosse A L O Bestellung. Nummer ${cleanOrderName}. ${total.toFixed(2)} ${currency}.`
      : `Neue A L O Bestellung. Nummer ${cleanOrderName}. ${total.toFixed(2)} ${currency}.`;

  setTimeout(
    () => {
      runDetached(
        "/usr/bin/say",
        [
          "-r",
          "185",
          spokenText,
        ]
      );
    },
    total >= 100
      ? 3600
      : 2200
  );
}


function playOrderSound(
  total,
  orderName = "",
  currency = "CHF"
) {
  forceMaximumAlertVolume();

  /*
    NORMAL:
    bereits klar hörbarer Doppelalarm.

    100+:
    kräftige Alarm-Sequenz.

    200+:
    maximale Aufmerksamkeit.
  */

  if (total >= 200) {
    playSoundFile(
      "Basso",
      0
    );

    playSoundFile(
      "Sosumi",
      700
    );

    playSoundFile(
      "Hero",
      1400
    );

    playSoundFile(
      "Sosumi",
      2300
    );

    playSoundFile(
      "Basso",
      3100
    );

    playSoundFile(
      "Hero",
      3900
    );

  } else if (total >= 100) {
    playSoundFile(
      "Sosumi",
      0
    );

    playSoundFile(
      "Hero",
      750
    );

    playSoundFile(
      "Sosumi",
      1550
    );

    playSoundFile(
      "Hero",
      2350
    );

  } else {
    playSoundFile(
      "Glass",
      0
    );

    playSoundFile(
      "Sosumi",
      700
    );

    playSoundFile(
      "Ping",
      1400
    );
  }

  speakOrderAlert(
    orderName,
    total,
    currency
  );
}


function normalizeAlertItems(
  rawItems
) {
  let items =
    rawItems;

  if (
    typeof items === "string"
  ) {
    try {
      items =
        JSON.parse(items);
    } catch {
      items = [];
    }
  }

  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map(
      item => ({
        name:
          String(
            item?.name ||
            "Artikel"
          ).trim(),

        quantity:
          Math.max(
            1,
            Number(
              item?.quantity ||
              1
            ) || 1
          ),
      })
    )
    .filter(
      item =>
        item.name
    );
}


function formatOrderAlert(
  alert
) {
  const total =
    Number(
      alert?.total_amount ||
      0
    ) || 0;

  const currency =
    String(
      alert?.currency_code ||
      "CHF"
    );

  const orderName =
    String(
      alert?.shopify_order_name ||
      "Bestellung"
    );

  const items =
    normalizeAlertItems(
      alert?.items
    );

  const totalQuantity =
    items.reduce(
      (sum, item) =>
        sum + item.quantity,
      0
    );

  const title =
    total >= 200
      ? `🚨🚨 ${orderName} · ${currency} ${total.toFixed(2)} 🚨🚨`
      : total >= 100
        ? `🚨 ${orderName} · ${currency} ${total.toFixed(2)} 🚨`
        : `🔔 ${orderName} · ${currency} ${total.toFixed(2)}`;

  const itemLines =
    items
      .slice(0, 10)
      .map(
        item =>
          `${item.quantity}× ${item.name}`
      );

  if (items.length > 10) {
    itemLines.push(
      `+ ${items.length - 10} weitere Positionen`
    );
  }

  const amount =
    `${currency} ${total.toFixed(2)}`;

  const headline =
    total >= 200
      ? "🚨 MEGA BESTELLUNG 🚨"
      : total >= 100
        ? "🔥 GROSSE BESTELLUNG 🔥"
        : "🔔 NEUE BESTELLUNG";

  const message = [
    headline,
    "",
    `BESTELLNUMMER: ${orderName}`,
    `BETRAG: ${amount}`,
    "",
    "──────────────",
    "",
    ...itemLines,
    "",
    "──────────────",
    "",
    `${totalQuantity} Artikel insgesamt`,
  ].join("\n");

  return {
    total,
    title,
    message,
    orderName,
    amount,
  };
}


function showMacNotification(
  title,
  message
) {
  const script = `
on run argv
  set alertTitle to item 1 of argv
  set alertMessage to item 2 of argv
  display notification alertMessage with title alertTitle
end run
`;

  runDetached(
    "/usr/bin/osascript",
    [
      "-e",
      script,
      title,
      message,
    ]
  );
}


function showMacOrderWindow(
  title,
  message
) {
  const script = `
on run argv
  set alertTitle to item 1 of argv
  set alertMessage to item 2 of argv
  display dialog alertMessage with title alertTitle buttons {"OK"} default button "OK" giving up after 20
end run
`;

  runDetached(
    "/usr/bin/osascript",
    [
      "-e",
      script,
      title,
      message,
    ]
  );
}


async function processNextOrderAlert(
  deviceToken
) {
  let alert = null;

  try {
    const result =
      await claimNextOrderAlert(
        deviceToken
      );

    alert =
      result?.alert ||
      null;

    if (!alert) {
      return false;
    }

    const formatted =
      formatOrderAlert(
        alert
      );

    log(
      `ORDER ALERT: ${formatted.orderName} · ${formatted.amount}`
    );

    playOrderSound(
      formatted.total,
      formatted.orderName,
      String(
        alert?.currency_code ||
        "CHF"
      )
    );

    showMacNotification(
      formatted.title,
      `${formatted.orderName} · ${formatted.amount}`
    );

    showMacOrderWindow(
      formatted.title,
      formatted.message
    );

    await completeOrderAlert(
      alert.id,
      deviceToken
    );

    log(
      `ORDER ALERT angezeigt: ${formatted.orderName}`
    );

    return true;

  } catch (error) {
    logError(
      "ORDER ALERT fehlgeschlagen",
      error
    );

    return false;
  }
}


function createTemporaryPdf(
  job,
  documentType
) {
  /*
    Neues Backend:
      pdf_base64

    Alter Fallback:
      label_pdf_base64
  */
  const base64 =
    String(
      job.pdf_base64 ||
      job.label_pdf_base64 ||
      ""
    );

  if (!base64) {
    throw new Error(
      `${documentType}: Druckauftrag enthält kein PDF.`
    );
  }

  const buffer =
    Buffer.from(
      base64,
      "base64"
    );

  if (
    buffer.length < 4 ||
    buffer
      .subarray(0, 4)
      .toString("ascii") !==
      "%PDF"
  ) {
    throw new Error(
      `${documentType}: ungültiges PDF.`
    );
  }

  const tempDir =
    path.join(
      os.tmpdir(),
      "alo-print-agent"
    );

  fs.mkdirSync(
    tempDir,
    {
      recursive: true,
    }
  );

  const safeId =
    String(job.id)
      .replace(
        /[^a-zA-Z0-9_-]/g,
        "_"
      );

  const safeType =
    String(documentType)
      .toLowerCase()
      .replace(
        /[^a-z0-9_-]/g,
        "_"
      );

  const pdfPath =
    path.join(
      tempDir,
      `alo-${safeType}-${safeId}.pdf`
    );

  fs.writeFileSync(
    pdfPath,
    buffer
  );

  return pdfPath;
}


/* =========================================================
   BROTHER VERSANDLABEL
========================================================= */

const BROTHER_IPP_URI =
  process.env.ALO_BROTHER_IPP_URI ||
  "ipp://localhost:631/printers/Brother_QL_1110NWB";

function sleepSync(seconds) {
  execFileSync(
    "/bin/sleep",
    [String(seconds)],
    {
      stdio: "ignore",
      timeout:
        Math.max(
          5000,
          Number(seconds) * 2000
        ),
    }
  );
}

function getBrotherIppStatus() {
  const testFile =
    path.join(
      os.tmpdir(),
      "alo-brother-status.test"
    );

  fs.writeFileSync(
    testFile,
`{
  NAME "ALO Brother Status"
  OPERATION Get-Printer-Attributes
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR naturalLanguage attributes-natural-language de
  ATTR uri printer-uri ${BROTHER_IPP_URI}
  ATTR keyword requested-attributes printer-state,printer-state-reasons,queued-job-count,printer-is-accepting-jobs
  STATUS successful-ok
}
`
  );

  const output =
    execFileSync(
      "/usr/bin/ipptool",
      [
        "-tv",
        BROTHER_IPP_URI,
        testFile,
      ],
      {
        encoding: "utf8",
        timeout: 15000,
      }
    );

  const text =
    String(output || "");

  return {
    raw: text,

    idle:
      /printer-state \(enum\) = idle/.test(
        text
      ),

    accepting:
      /printer-is-accepting-jobs \(boolean\) = true/.test(
        text
      ),

    spoolFull:
      /spool-area-full/.test(
        text
      ),

    queuedJobs:
      Number(
        (
          text.match(
            /queued-job-count \(integer\) = (\d+)/
          ) || []
        )[1] || 0
      ),
  };
}

function clearStuckBrotherIppJobs() {
  const jobsFile =
    path.join(
      os.tmpdir(),
      "alo-brother-jobs.test"
    );

  fs.writeFileSync(
    jobsFile,
`{
  NAME "ALO Brother Jobs"
  OPERATION Get-Jobs
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR naturalLanguage attributes-natural-language en
  ATTR uri printer-uri ${BROTHER_IPP_URI}
  ATTR boolean my-jobs false
  ATTR keyword requested-attributes job-id,job-state,job-state-reasons
  STATUS successful-ok
}
`
  );

  const output =
    execFileSync(
      "/usr/bin/ipptool",
      [
        "-tv",
        BROTHER_IPP_URI,
        jobsFile,
      ],
      {
        encoding: "utf8",
        timeout: 15000,
      }
    );

  const text =
    String(output || "");

  const blocks =
    text.split(
      /(?=\s*job-id \(integer\) =)/
    );

  let cancelled = 0;

  for (const block of blocks) {
    const idMatch =
      block.match(
        /job-id \(integer\) = (\d+)/
      );

    if (!idMatch) {
      continue;
    }

    const isProcessing =
      /job-state \(enum\) = processing/.test(
        block
      );

    const isIncoming =
      /job-state-reasons \(keyword\) = job-incoming/.test(
        block
      );

    if (
      !isProcessing ||
      !isIncoming
    ) {
      continue;
    }

    const jobId =
      Number(idMatch[1]);

    if (
      activeBrotherJobId !== null &&
      jobId === activeBrotherJobId
    ) {
      log(
        `Brother-Recovery: aktiver Job ${jobId} wird nicht gelöscht.`
      );
      continue;
    }

    const cancelFile =
      path.join(
        os.tmpdir(),
        `alo-brother-cancel-${jobId}.test`
      );

    fs.writeFileSync(
      cancelFile,
`{
  NAME "Cancel Brother Job ${jobId}"
  OPERATION Cancel-Job
  GROUP operation-attributes-tag
  ATTR charset attributes-charset utf-8
  ATTR naturalLanguage attributes-natural-language en
  ATTR uri printer-uri ${BROTHER_IPP_URI}
  ATTR integer job-id ${jobId}
  STATUS successful-ok
}
`
    );

    execFileSync(
      "/usr/bin/ipptool",
      [
        "-tv",
        BROTHER_IPP_URI,
        cancelFile,
      ],
      {
        encoding: "utf8",
        timeout: 15000,
      }
    );

    cancelled += 1;

    log(
      `Brother-Recovery: internen festhängenden IPP-Job ${jobId} gelöscht.`
    );
  }

  return cancelled;
}

function recoverBrotherPrinter() {
  log(
    "Brother-Recovery: starte lokale Queue-Reparatur ..."
  );

  /*
    Der eigentliche Labeldruck läuft direkt per IPP.
    Diese Schritte reparieren die lokale macOS/CUPS-Seite,
    falls dort alte oder blockierte Jobs hängen.
  */

  try {
    const queue =
      execFileSync(
        "/usr/bin/lpstat",
        [
          "-o",
          LABEL_PRINTER_NAME,
        ],
        {
          encoding: "utf8",
          timeout: 10000,
        }
      );

    if (
      String(queue || "").trim()
    ) {
      log(
        "Brother-Recovery: alte CUPS-Jobs gefunden – bereinige Queue."
      );

      try {
        execFileSync(
          "/usr/bin/cancel",
          [
            "-a",
            LABEL_PRINTER_NAME,
          ],
          {
            stdio: "ignore",
            timeout: 10000,
          }
        );
      } catch (error) {
        log(
          "Brother-Recovery: CUPS-Jobs konnten nicht vollständig gelöscht werden."
        );
      }
    }
  } catch {
    // Keine lokale Queue oder keine Jobs ist hier kein Fehler.
  }

  try {
    execFileSync(
      "/usr/sbin/cupsenable",
      [
        LABEL_PRINTER_NAME,
      ],
      {
        stdio: "ignore",
        timeout: 10000,
      }
    );

    log(
      "Brother-Recovery: CUPS-Drucker aktiviert."
    );
  } catch (error) {
    log(
      "Brother-Recovery: cupsenable nicht erfolgreich – fahre mit IPP-Prüfung fort."
    );
  }

  try {
    execFileSync(
      "/usr/sbin/cupsaccept",
      [
        LABEL_PRINTER_NAME,
      ],
      {
        stdio: "ignore",
        timeout: 10000,
      }
    );

    log(
      "Brother-Recovery: CUPS nimmt Jobs wieder an."
    );
  } catch (error) {
    log(
      "Brother-Recovery: cupsaccept nicht erfolgreich – fahre mit IPP-Prüfung fort."
    );
  }

  /*
    Brother kurz Zeit geben, Queue/Cutter/Rollenmechanik
    wieder in einen stabilen Zustand zu bringen.
  */
  sleepSync(3);

  try {
    const status =
      getBrotherIppStatus();

    if (
      status.accepting &&
      !status.spoolFull &&
      status.queuedJobs === 0
    ) {
      log(
        "Brother-Recovery erfolgreich: Drucker ist wieder bereit."
      );

      return true;
    }

    if (
      status.spoolFull ||
      !status.accepting
    ) {
      log(
        "Brother-Recovery: interner IPP-Spool blockiert – prüfe festhängende Jobs ..."
      );

      try {
        const cancelled =
          clearStuckBrotherIppJobs();

        if (cancelled > 0) {
          sleepSync(3);

          const recoveredStatus =
            getBrotherIppStatus();

          if (
            recoveredStatus.accepting &&
            !recoveredStatus.spoolFull &&
            recoveredStatus.queuedJobs === 0
          ) {
            log(
              "Brother-Recovery erfolgreich: interner IPP-Spool wurde automatisch freigegeben."
            );
            return true;
          }
        }
      } catch (error) {
        logError(
          "Brother-Recovery: interne IPP-Queue konnte nicht bereinigt werden",
          error
        );
      }
    }

    log(
      "Brother-Recovery durchgeführt, Drucker ist per IPP aber noch nicht vollständig bereit."
    );
  } catch (error) {
    log(
      "Brother-Recovery durchgeführt, IPP-Status ist momentan noch nicht erreichbar."
    );
  }

  return false;
}


function waitForBrotherReady(
  timeoutMs = 180000
) {
  const started =
    Date.now();

  let recoveryAttempted =
    false;

  while (
    Date.now() - started <
    timeoutMs
  ) {
    try {
      const status =
        getBrotherIppStatus();

      if (
        status.accepting &&
        !status.spoolFull &&
        status.queuedJobs === 0
      ) {
        return;
      }

      /*
        Sofort recovern, wenn Brother keine Jobs annimmt
        oder einen vollen Spool meldet.

        Bei normalem "processing" geben wir ihm zuerst
        etwas Zeit, damit ein legitimer Druckjob fertig wird.
      */
      const elapsed =
        Date.now() - started;

      if (
        !recoveryAttempted &&
        elapsed >= 30000
      ) {
        recoveryAttempted =
          true;

        log(
          "Brother nicht druckbereit – starte automatische Recovery ..."
        );

        recoverBrotherPrinter();

        continue;
      }

      log(
        "Brother noch beschäftigt – warte vor nächstem Label ..."
      );

    } catch (error) {
      const elapsed =
        Date.now() - started;

      if (
        !recoveryAttempted &&
        elapsed >= 5000
      ) {
        recoveryAttempted =
          true;

        log(
          "Brother-Status nicht erreichbar – starte automatische Recovery ..."
        );

        recoverBrotherPrinter();

        continue;
      }

      log(
        "Brother-Status noch nicht bereit – neuer Versuch ..."
      );
    }

    sleepSync(2);
  }

  throw new Error(
    "Brother wurde trotz automatischer Recovery innerhalb von 180 Sekunden nicht druckbereit."
  );
}

function waitForCupsJobDone(
  printerName,
  cupsJobId,
  timeoutMs = 180000
) {
  const started =
    Date.now();

  while (
    Date.now() - started <
    timeoutMs
  ) {
    let queue = "";

    try {
      queue =
        execFileSync(
          "/usr/bin/lpstat",
          [
            "-o",
            printerName,
          ],
          {
            encoding: "utf8",
            timeout: 10000,
          }
        );
    } catch {
      queue = "";
    }

    if (
      !String(queue).includes(
        cupsJobId
      )
    ) {
      return;
    }

    log(
      `Brother-CUPS-Job ${cupsJobId} läuft noch – warte ...`
    );

    sleepSync(2);
  }

  throw new Error(
    `Brother-CUPS-Job ${cupsJobId} wurde nicht innerhalb von 180 Sekunden abgeschlossen.`
  );
}

function printShippingLabel(
  printerName,
  pdfPath
) {
  const targetPrinter =
    printerName ||
    LABEL_PRINTER_NAME ||
    "Brother_QL_1110NWB";

  log(
    `Brother: sende Versandlabel direkt via CUPS an ${targetPrinter} ...`
  );

  let accepted = false;

  try {
    const output =
      execFileSync(
        "/usr/bin/lp",
        [
          "-d",
          targetPrinter,
          "-o",
          "PageSize=Custom.103x148mm",
          "-o",
          "fit-to-page",
          "-o",
          "CutMedia=EndOfPage",
          pdfPath,
        ],
        {
          encoding: "utf8",
          timeout: 60000,
        }
      );

    accepted = true;

    const text =
      String(output || "").trim();

    log(
      `Brother: CUPS-Druckjob angenommen: ${text}`
    );

    return text ||
      `Brother CUPS job an ${targetPrinter}`;

  } catch (error) {
    const protectedError =
      error instanceof Error
        ? error
        : new Error(String(error));

    if (accepted) {
      protectedError.retryable = false;
      protectedError.message =
        "NICHT AUTOMATISCH WIEDERHOLEN – CUPS hat den Druckjob bereits angenommen. " +
        protectedError.message;
    }

    throw protectedError;
  }
}


/* =========================================================
   HP A4
========================================================= */

function printA4Document(
  printerName,
  pdfPath
) {
  const output =
    execFileSync(
      "/usr/bin/lp",
      [
        "-d",
        printerName,

        "-o",
        "media=A4",

        "-o",
        "fit-to-page",

        pdfPath,
      ],
      {
        encoding:
          "utf8",

        timeout:
          60000,
      }
    );

  return String(
    output || ""
  ).trim();
}


/* =========================================================
   EINEN JOB VERARBEITEN
========================================================= */

async function processNextJob(
  printer,
  documentType,
  deviceToken
) {
  let job = null;
  let pdfPath = null;
  let printSubmitted = false;

  try {
    const result =
      await claimNextJob(
        printer.name,
        documentType,
        deviceToken
      );

    job =
      result?.job ||
      null;

    if (!job) {
      return false;
    }

    log(
      `${documentType} erhalten: ${
        job.shopify_order_name ||
        job.id
      }`
    );

    pdfPath =
      createTemporaryPdf(
        job,
        documentType
      );

    log(
      `${documentType} PDF: ${
        fs.statSync(pdfPath).size
      } Bytes`
    );

    let printResult = "";

    if (
      documentType ===
      "SHIPPING_LABEL"
    ) {
      log(
        `Versandlabel -> ${printer.name}`
      );

      printResult =
        printShippingLabel(
          printer.name,
          pdfPath
        );

    } else if (
      documentType ===
      "PACKING_SLIP"
    ) {
      log(
        `Lieferschein -> ${printer.name}`
      );

      printResult =
        printA4Document(
          printer.name,
          pdfPath
        );

    } else if (
      documentType ===
      "INVOICE"
    ) {
      log(
        `Rechnung -> ${printer.name}`
      );

      printResult =
        printA4Document(
          printer.name,
          pdfPath
        );

    } else {
      throw new Error(
        `Nicht unterstützter Dokumenttyp: ${documentType}`
      );
    }

    printSubmitted = true;

    if (printResult) {
      log(
        `CUPS: ${printResult}`
      );
    }

    await completeJob(
      job.id,
      deviceToken
    );

    log(
      `${documentType} erfolgreich abgeschlossen: ${
        job.shopify_order_name ||
        job.id
      }`
    );

    return true;

  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    /*
      Zwei Schutzfälle gegen Doppelprints:

      1. printShippingLabel() hat selbst retryable=false gesetzt,
         weil Brother den Job bereits mit successful-ok angenommen hat.

      2. Der eigentliche Druck-Aufruf war bereits erfolgreich,
         aber z.B. completeJob() / Netzwerk / Backend schlägt danach fehl.

      In beiden Fällen KEIN automatischer Wiederholungsdruck.
    */
    const retryable =
      error?.retryable !== false &&
      !printSubmitted;

    logError(
      `${documentType} fehlgeschlagen`,
      error
    );

    if (job?.id) {
      try {
        await failJob(
          job.id,
          message,
          retryable,
          deviceToken
        );
      } catch (failError) {
        logError(
          `Fehlerstatus für Job ${job.id} konnte nicht gespeichert werden`,
          failError
        );
      }
    }

    return false;

  } finally {
    if (
      pdfPath &&
      fs.existsSync(pdfPath)
    ) {
      try {
        fs.unlinkSync(
          pdfPath
        );
      } catch {
        // Temp-Datei wird notfalls vom System entfernt.
      }
    }
  }
}


/* =========================================================
   MAC AGENT
========================================================= */

async function runMacAgent(
  deviceConfig
) {
  const deviceToken =
    deviceConfig.deviceToken;

  const labelPrinter =
    findPrinter(
      LABEL_PRINTER_NAME,
      "Brother QL-1110NWB / CUPS"
    );

  const a4Printer =
    findPrinter(
      A4_PRINTER_NAME,
      "HP Color Laser MFP 178nw / CUPS"
    );

  log(
    `Versandlabel-Drucker: ${labelPrinter.name}`
  );

  log(
    `A4-Drucker: ${a4Printer.name}`
  );

  log(
    "Teste Railway-Verbindung und Geräte-Token ..."
  );

  await heartbeat(
    labelPrinter,
    deviceToken
  );

  await heartbeat(
    a4Printer,
    deviceToken
  );

  log(
    "Railway + Geräte-Token OK."
  );

  let lastHeartbeat =
    Date.now();

  log(
    "Print + Order Alert Queue aktiv – Polling 750 ms."
  );

  while (true) {
    try {
      const now =
        Date.now();

      if (
        now - lastHeartbeat >=
        HEARTBEAT_MS
      ) {
        const currentLabel =
          findPrinter(
            LABEL_PRINTER_NAME,
            "Brother QL-1110NWB / CUPS"
          );

        const currentA4 =
          findPrinter(
            A4_PRINTER_NAME,
            "HP Color Laser MFP 178nw / CUPS"
          );

        await heartbeat(
          currentLabel,
          deviceToken
        );

        await heartbeat(
          currentA4,
          deviceToken
        );

        lastHeartbeat =
          now;
      }

      const orderAlertShown =
        await processNextOrderAlert(
          deviceToken
        );

      const printedLabel =
        await processNextJob(
          labelPrinter,
          "SHIPPING_LABEL",
          deviceToken
        );

      const printedPackingSlip =
        await processNextJob(
          a4Printer,
          "PACKING_SLIP",
          deviceToken
        );

      const printedInvoice =
        await processNextJob(
          a4Printer,
          "INVOICE",
          deviceToken
        );

      /*
        Wenn etwas gedruckt wurde,
        sofort erneut Queue prüfen.
      */
      if (
        orderAlertShown ||
        printedLabel ||
        printedPackingSlip ||
        printedInvoice
      ) {
        continue;
      }

    } catch (error) {
      logError(
        "Agent-Schleife fehlgeschlagen",
        error
      );
    }

    await sleep(
      POLL_MS
    );
  }
}


/* =========================================================
   START
========================================================= */

async function main() {
  console.log("");
  console.log(
    "======================================"
  );
  console.log(
    "       ALO MAC PRINT AGENT"
  );
  console.log(
    "======================================"
  );
  console.log(
    `Version:    ${AGENT_VERSION}`
  );
  console.log(
    `Computer:   ${DEVICE_NAME}`
  );
  console.log(
    `Brother:    ${LABEL_PRINTER_NAME}`
  );
  console.log(
    `HP A4:      ${A4_PRINTER_NAME}`
  );
  console.log(
    `Backend:    ${BACKEND_URL}`
  );
  console.log(
    "======================================"
  );
  console.log("");

  const deviceConfig =
    loadDeviceConfig();

  log(
    "Geräte-Kopplung gefunden."
  );

  await runMacAgent(
    deviceConfig
  );
}


main().catch(
  (error) => {
    logError(
      "ALO Mac Print Agent konnte nicht gestartet werden",
      error
    );

    process.exitCode =
      1;
  }
);
