import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const AGENT_VERSION = "1.3.0-mac-dual";

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
        }),
    },
    deviceToken
  );
}


/* =========================================================
   TEMP PDF
========================================================= */

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

function printShippingLabel(
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
        "landscape",

        "-o",
        "orientation-requested=4",

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

    } else {
      throw new Error(
        `Nicht unterstützter Dokumenttyp: ${documentType}`
      );
    }

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

    logError(
      `${documentType} fehlgeschlagen`,
      error
    );

    if (job?.id) {
      try {
        await failJob(
          job.id,
          message,
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
    "Dual Print Queue aktiv – Polling 750 ms."
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

      /*
        Wenn etwas gedruckt wurde,
        sofort erneut Queue prüfen.
      */
      if (
        printedLabel ||
        printedPackingSlip
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
