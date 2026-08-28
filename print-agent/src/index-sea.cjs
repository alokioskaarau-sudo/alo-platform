const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");

const AGENT_VERSION = "1.1.0";

const DEFAULT_BACKEND_URL =
  "https://alo-platform-production.up.railway.app";

const HEARTBEAT_INTERVAL_MS = 20_000;
const JOB_POLL_INTERVAL_MS = 3_000;


/* =========================================================
   PFADE / KONFIGURATION
========================================================= */

const CONFIG_DIR =
  path.join(
    os.homedir(),
    ".alo-print-connector"
  );

const CONFIG_FILE =
  path.join(
    CONFIG_DIR,
    "device.json"
  );


/* =========================================================
   ENV LADEN
========================================================= */

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content =
    fs.readFileSync(
      filePath,
      "utf8"
    );

  for (
    const rawLine of
    content.split(/\r?\n/)
  ) {
    const line =
      rawLine.trim();

    if (
      !line ||
      line.startsWith("#")
    ) {
      continue;
    }

    const separatorIndex =
      line.indexOf("=");

    if (separatorIndex < 1) {
      continue;
    }

    const key =
      line
        .slice(
          0,
          separatorIndex
        )
        .trim();

    let value =
      line
        .slice(
          separatorIndex + 1
        )
        .trim();

    if (
      (
        value.startsWith('"') &&
        value.endsWith('"')
      ) ||
      (
        value.startsWith("'") &&
        value.endsWith("'")
      )
    ) {
      value =
        value.slice(1, -1);
    }

    if (
      key &&
      process.env[key] ===
        undefined
    ) {
      process.env[key] =
        value;
    }
  }
}

loadEnvFile(
  path.join(
    process.cwd(),
    ".env"
  )
);

loadEnvFile(
  path.join(
    process.cwd(),
    "..",
    ".env"
  )
);


/* =========================================================
   GRUNDWERTE
========================================================= */

const BACKEND_URL =
  (
    process.env
      .ALO_BACKEND_URL ||
    DEFAULT_BACKEND_URL
  ).replace(/\/+$/, "");

const PLATFORM =
  process.platform;

const DEVICE_NAME =
  (
    process.env
      .ALO_DEVICE_NAME ||
    os.hostname()
  ).trim();


/* =========================================================
   LOGGING
========================================================= */

function timestamp() {
  return new Date()
    .toLocaleTimeString(
      "de-CH",
      {
        hour12: false,
      }
    );
}

function log(message) {
  console.log(
    `[${timestamp()}] ${message}`
  );
}

function logError(
  message,
  error
) {
  const detail =
    error instanceof Error
      ? error.message
      : String(error);

  console.error(
    `[${timestamp()}] ${message}: ${detail}`
  );
}


/* =========================================================
   LOKALE GERÄTE-KONFIGURATION
========================================================= */

function ensureConfigDirectory() {
  fs.mkdirSync(
    CONFIG_DIR,
    {
      recursive: true,
    }
  );
}

function loadDeviceConfig() {
  try {
    if (
      !fs.existsSync(
        CONFIG_FILE
      )
    ) {
      return null;
    }

    const content =
      fs.readFileSync(
        CONFIG_FILE,
        "utf8"
      );

    const parsed =
      JSON.parse(content);

    if (
      !parsed ||
      typeof parsed !==
        "object"
    ) {
      return null;
    }

    if (
      typeof parsed.deviceToken !==
        "string" ||
      !parsed.deviceToken.trim()
    ) {
      return null;
    }

    return parsed;
  } catch (error) {
    logError(
      "Gespeicherte Geräte-Konfiguration konnte nicht gelesen werden",
      error
    );

    return null;
  }
}

function saveDeviceConfig(
  config
) {
  ensureConfigDirectory();

  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      config,
      null,
      2
    ),
    {
      encoding: "utf8",
      mode: 0o600,
    }
  );
}


/* =========================================================
   HTTP
========================================================= */

async function requestJson(
  endpoint,
  options = {},
  deviceToken = ""
) {
  const headers = {
    Accept:
      "application/json",
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
    const message =
      data?.error ||
      `HTTP ${response.status}`;

    const error =
      new Error(message);

    error.status =
      response.status;

    throw error;
  }

  return data;
}


/* =========================================================
   PAIRING
========================================================= */

function askQuestion(
  question
) {
  return new Promise(
    (resolve) => {
      const rl =
        readline.createInterface({
          input:
            process.stdin,
          output:
            process.stdout,
        });

      rl.question(
        question,
        (answer) => {
          rl.close();

          resolve(
            answer.trim()
          );
        }
      );
    }
  );
}

async function claimPairingCode(
  code
) {
  return requestJson(
    "/api/printer-pairing/claim",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify({
          code,
          deviceName:
            DEVICE_NAME,
          platform:
            PLATFORM,
          agentVersion:
            AGENT_VERSION,
        }),
    }
  );
}

async function ensurePaired() {
  const existingConfig =
    loadDeviceConfig();

  if (existingConfig) {
    log(
      `Gerät bereits gekoppelt: ${
        existingConfig.deviceName ||
        DEVICE_NAME
      }`
    );

    return existingConfig;
  }

  console.log("");
  console.log(
    "======================================"
  );
  console.log(
    "       ALO CONNECTOR KOPPLUNG"
  );
  console.log(
    "======================================"
  );
  console.log("");
  console.log(
    "Dieses Gerät ist noch nicht mit ALO gekoppelt."
  );
  console.log(
    "Öffne in Shopify:"
  );
  console.log(
    "ALO Platform > Drucker > Drucker verbinden"
  );
  console.log("");
  console.log(
    "Dort wird ein 6-stelliger Kopplungscode angezeigt."
  );
  console.log("");

  while (true) {
    const code =
      await askQuestion(
        "Kopplungscode: "
      );

    if (
      !/^\d{6}$/.test(code)
    ) {
      console.log(
        "Bitte einen gültigen 6-stelligen Code eingeben."
      );

      continue;
    }

    try {
      log(
        "Gerät wird gekoppelt ..."
      );

      const result =
        await claimPairingCode(
          code
        );

      if (
        !result?.ok ||
        !result?.deviceToken
      ) {
        throw new Error(
          "Server hat keinen Geräte-Token zurückgegeben."
        );
      }

      const config = {
        deviceId:
          result.device
            ?.device_id ||
          null,

        deviceName:
          result.device
            ?.device_name ||
          DEVICE_NAME,

        platform:
          result.device
            ?.platform ||
          PLATFORM,

        deviceToken:
          result.deviceToken,

        pairedAt:
          new Date()
            .toISOString(),
      };

      saveDeviceConfig(
        config
      );

      console.log("");
      log(
        "Gerät erfolgreich gekoppelt."
      );
      console.log("");

      return config;
    } catch (error) {
      logError(
        "Kopplung fehlgeschlagen",
        error
      );

      console.log(
        "Bitte in Shopify einen neuen Kopplungscode erzeugen und erneut versuchen."
      );
      console.log("");
    }
  }
}


/* =========================================================
   WINDOWS DRUCKER ERKENNEN
========================================================= */

function runPowerShell(
  command
) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    }
  );
}

function normalizePrinter(
  printer
) {
  return {
    name:
      String(
        printer.Name || ""
      ).trim(),

    displayName:
      String(
        printer.Name || ""
      ).trim(),

    driverName:
      String(
        printer.DriverName || ""
      ).trim(),

    portName:
      String(
        printer.PortName || ""
      ).trim(),

    paperSize:
      null,

    platform:
      "windows",

    status:
      "ONLINE",

    agentVersion:
      AGENT_VERSION,

    deviceName:
      DEVICE_NAME,
  };
}

function getWindowsPrinters() {
  const command =
    [
      "Get-Printer",
      "| Select-Object Name,DriverName,PortName",
      "| ConvertTo-Json -Compress",
    ].join(" ");

  const output =
    runPowerShell(
      command
    ).trim();

  if (!output) {
    return [];
  }

  const parsed =
    JSON.parse(output);

  const list =
    Array.isArray(parsed)
      ? parsed
      : [parsed];

  return list
    .map(
      normalizePrinter
    )
    .filter(
      (printer) =>
        Boolean(
          printer.name
        )
    );
}


/* =========================================================
   DRUCKER AUSWÄHLEN
========================================================= */

function choosePrinter(
  printers
) {
  const configuredName =
    (
      process.env
        .ALO_PRINTER_NAME ||
      ""
    ).trim();

  if (configuredName) {
    const exact =
      printers.find(
        (printer) =>
          printer.name ===
          configuredName
      );

    if (exact) {
      return exact;
    }

    log(
      `Konfigurierter Drucker "${configuredName}" wurde nicht gefunden.`
    );
  }

  const brother =
    printers.find(
      (printer) => {
        const haystack =
          `${printer.name} ${printer.driverName}`
            .toLowerCase();

        return (
          haystack.includes(
            "brother"
          ) &&
          (
            haystack.includes(
              "ql"
            ) ||
            haystack.includes(
              "1110"
            )
          )
        );
      }
    );

  if (brother) {
    return brother;
  }

  if (
    printers.length === 1
  ) {
    return printers[0];
  }

  return null;
}


/* =========================================================
   HEARTBEAT
========================================================= */

async function sendPrinterHeartbeat(
  printer,
  deviceToken
) {
  return requestJson(
    "/api/print-agent/printers/heartbeat",
    {
      method: "POST",

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

async function heartbeatAllPrinters(
  printers,
  deviceToken
) {
  for (
    const printer of printers
  ) {
    try {
      await sendPrinterHeartbeat(
        printer,
        deviceToken
      );
    } catch (error) {
      logError(
        `Heartbeat für "${printer.name}" fehlgeschlagen`,
        error
      );
    }
  }
}


/* =========================================================
   SUMATRA PDF
========================================================= */

function getSumatraCandidates() {
  const candidates = [];

  const local =
    path.join(
      process.cwd(),
      "SumatraPDF.exe"
    );

  candidates.push(local);

  if (
    process.env
      .ProgramFiles
  ) {
    candidates.push(
      path.join(
        process.env
          .ProgramFiles,
        "SumatraPDF",
        "SumatraPDF.exe"
      )
    );
  }

  if (
    process.env[
      "ProgramFiles(x86)"
    ]
  ) {
    candidates.push(
      path.join(
        process.env[
          "ProgramFiles(x86)"
        ],
        "SumatraPDF",
        "SumatraPDF.exe"
      )
    );
  }

  if (
    process.env
      .LOCALAPPDATA
  ) {
    candidates.push(
      path.join(
        process.env
          .LOCALAPPDATA,
        "SumatraPDF",
        "SumatraPDF.exe"
      )
    );

    candidates.push(
      path.join(
        process.env
          .LOCALAPPDATA,
        "Programs",
        "SumatraPDF",
        "SumatraPDF.exe"
      )
    );
  }

  return candidates;
}

function findSumatraPDF() {
  for (
    const candidate of
    getSumatraCandidates()
  ) {
    if (
      candidate &&
      fs.existsSync(
        candidate
      )
    ) {
      return candidate;
    }
  }

  return null;
}


/* =========================================================
   PRINT QUEUE
========================================================= */

async function claimNextJob(
  printerName,
  deviceToken
) {
  return requestJson(
    "/api/print-agent/jobs/next",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify({
          printerName,
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

async function failJob(
  jobId,
  errorMessage,
  deviceToken
) {
  return requestJson(
    `/api/print-agent/jobs/${jobId}/fail`,
    {
      method: "POST",

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
   PDF DRUCKEN
========================================================= */

function createTemporaryPdf(
  job
) {
  const base64 =
    String(
      job.label_pdf_base64 ||
      ""
    );

  if (!base64) {
    throw new Error(
      "Druckauftrag enthält kein PDF."
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
      "Druckauftrag enthält kein gültiges PDF."
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

  const safeJobId =
    String(job.id)
      .replace(
        /[^a-zA-Z0-9_-]/g,
        "_"
      );

  const pdfPath =
    path.join(
      tempDir,
      `alo-label-${safeJobId}.pdf`
    );

  fs.writeFileSync(
    pdfPath,
    buffer
  );

  return pdfPath;
}

function printPdf(
  sumatraPath,
  printerName,
  pdfPath
) {
  execFileSync(
    sumatraPath,
    [
      "-print-to",
      printerName,
      "-silent",
      pdfPath,
    ],
    {
      stdio: "pipe",
      windowsHide: true,
      timeout: 60_000,
    }
  );
}


/* =========================================================
   EINEN JOB VERARBEITEN
========================================================= */

async function processNextJob(
  printer,
  sumatraPath,
  deviceToken
) {
  let job = null;
  let pdfPath = null;

  try {
    const result =
      await claimNextJob(
        printer.name,
        deviceToken
      );

    job =
      result?.job || null;

    if (!job) {
      return false;
    }

    log(
      `Druckauftrag erhalten: ${
        job.shopify_order_name ||
        job.id
      }`
    );

    pdfPath =
      createTemporaryPdf(
        job
      );

    log(
      `Drucke auf "${printer.name}" ...`
    );

    printPdf(
      sumatraPath,
      printer.name,
      pdfPath
    );

    await completeJob(
      job.id,
      deviceToken
    );

    log(
      `Druckauftrag abgeschlossen: ${
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
      "Druckauftrag fehlgeschlagen",
      error
    );

    if (job?.id) {
      try {
        await failJob(
          job.id,
          message,
          deviceToken
        );
      } catch (
        failError
      ) {
        logError(
          "Fehlerstatus konnte nicht an den Server gemeldet werden",
          failError
        );
      }
    }

    return false;
  } finally {
    if (
      pdfPath &&
      fs.existsSync(
        pdfPath
      )
    ) {
      try {
        fs.unlinkSync(
          pdfPath
        );
      } catch {
        // Temporäre Datei wird beim nächsten
        // System-Cleanup entfernt.
      }
    }
  }
}


/* =========================================================
   HILFSFUNKTION
========================================================= */

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}


/* =========================================================
   WINDOWS AGENT
========================================================= */

async function runWindowsAgent(
  deviceConfig
) {
  const deviceToken =
    deviceConfig.deviceToken;

  log(
    "Suche installierte Drucker ..."
  );

  let printers = [];

  try {
    printers =
      getWindowsPrinters();
  } catch (error) {
    logError(
      "Windows-Drucker konnten nicht gelesen werden",
      error
    );

    process.exitCode = 1;
    return;
  }

  if (
    printers.length === 0
  ) {
    log(
      "Keine Windows-Drucker gefunden."
    );

    log(
      "Bitte Brother-Treiber und Drucker installieren."
    );

    process.exitCode = 1;
    return;
  }

  log(
    `${printers.length} Drucker gefunden.`
  );

  for (
    const printer of printers
  ) {
    log(
      `Gefunden: ${printer.name}`
    );
  }

  await heartbeatAllPrinters(
    printers,
    deviceToken
  );

  const selectedPrinter =
    choosePrinter(
      printers
    );

  if (!selectedPrinter) {
    log(
      "Kein eindeutiger ALO-Drucker konnte automatisch ausgewählt werden."
    );

    log(
      "Bitte den Brother QL-1110NWB installieren oder später in ALO Platform auswählen."
    );

    process.exitCode = 1;
    return;
  }

  log(
    `ALO Drucker: ${selectedPrinter.name}`
  );

  const sumatraPath =
    findSumatraPDF();

  if (!sumatraPath) {
    log(
      "SumatraPDF wurde nicht gefunden."
    );

    log(
      "Der Connector kann noch keine PDF-Etiketten drucken."
    );

    process.exitCode = 1;
    return;
  }

  log(
    `PDF-Drucksystem bereit.`
  );

  let lastHeartbeat = 0;

  log(
    "Print Queue gestartet."
  );

  while (true) {
    try {
      const now =
        Date.now();

      if (
        now -
          lastHeartbeat >=
        HEARTBEAT_INTERVAL_MS
      ) {
        printers =
          getWindowsPrinters();

        await heartbeatAllPrinters(
          printers,
          deviceToken
        );

        lastHeartbeat =
          now;
      }

      await processNextJob(
        selectedPrinter,
        sumatraPath,
        deviceToken
      );
    } catch (error) {
      logError(
        "Connector-Schleife fehlgeschlagen",
        error
      );
    }

    await sleep(
      JOB_POLL_INTERVAL_MS
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
    "          ALO PRINT CONNECTOR"
  );
  console.log(
    "======================================"
  );
  console.log(
    `Version:   ${AGENT_VERSION}`
  );
  console.log(
    `Computer:  ${DEVICE_NAME}`
  );
  console.log(
    `Plattform: ${PLATFORM}`
  );
  console.log(
    `Backend:   ${BACKEND_URL}`
  );
  console.log(
    "======================================"
  );
  console.log("");

  if (
    PLATFORM !==
    "win32"
  ) {
    log(
      "Dieser Computer ist kein Windows-PC."
    );

    log(
      "Windows-Druck und Print-Queue werden hier nicht gestartet."
    );

    return;
  }

  const deviceConfig =
    await ensurePaired();

  await runWindowsAgent(
    deviceConfig
  );
}

main().catch(
  (error) => {
    logError(
      "ALO Print Connector konnte nicht gestartet werden",
      error
    );

    process.exitCode = 1;
  }
);
