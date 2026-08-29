const os = require("os");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

const VERSION = "2.0.1";
const DEFAULT_BACKEND = "https://alo-platform-production.up.railway.app";
const PORT = 17891;
const HEARTBEAT_INTERVAL = 15000;

const DEVICE_DIR = path.join(
  os.homedir(),
  ".alo-print-connector"
);

const DEVICE_FILE = path.join(
  DEVICE_DIR,
  "device.json"
);

function run(command) {
  return new Promise((resolve) => {
    exec(
      command,
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            stdout: stdout || "",
            stderr: stderr || error.message,
          });
          return;
        }

        resolve({
          ok: true,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

function loadDevice() {
  try {
    if (!fs.existsSync(DEVICE_FILE)) {
      return null;
    }

    const device = JSON.parse(
      fs.readFileSync(DEVICE_FILE, "utf8")
    );

    return device;
  } catch (error) {
    console.error(
      "Device-Konfiguration konnte nicht gelesen werden:",
      error.message
    );

    return null;
  }
}

function getBackend(device) {
  let backend =
    device?.backendUrl ||
    DEFAULT_BACKEND;

  // Falls die URL durch Kopieren als Markdown gespeichert wurde,
  // sauber auf die echte URL reduzieren.
  const markdownMatch = String(backend).match(
    /^\[.*?\]\((https?:\/\/[^)]+)\)$/
  );

  if (markdownMatch) {
    backend = markdownMatch[1];
  }

  return String(backend).replace(/\/+$/, "");
}

function getToken(device) {
  return String(
    device?.deviceToken || ""
  ).trim();
}

async function getPrinters() {
  if (process.platform === "win32") {
    return getWindowsPrinters();
  }

  if (process.platform === "darwin") {
    return getMacPrinters();
  }

  return [];
}

/* =========================================================
   WINDOWS
========================================================= */

async function getWindowsPrinters() {
  const result = await run(
    'powershell -NoProfile -Command "Get-Printer | Select-Object Name,Default,PrinterStatus,PortName,DriverName | ConvertTo-Json -Compress"'
  );

  if (!result.ok) {
    console.error(
      "Windows-Druckererkennung fehlgeschlagen:",
      result.stderr
    );

    return [];
  }

  if (!result.stdout.trim()) {
    return [];
  }

  try {
    let printers = JSON.parse(result.stdout);

    if (!Array.isArray(printers)) {
      printers = [printers];
    }

    return printers.map((printer) => ({
      name: printer.Name || "Unbekannter Drucker",
      isDefault: printer.Default === true,
      status: String(
        printer.PrinterStatus || ""
      ),
      portName:
        printer.PortName || null,
      driverName:
        printer.DriverName || null,
    }));
  } catch (error) {
    console.error(
      "Windows-Druckerdaten konnten nicht gelesen werden:",
      error.message
    );

    return [];
  }
}

/* =========================================================
   MAC
========================================================= */

async function getMacPrinters() {
  const result = await run("lpstat -p -d");

  if (!result.ok) {
    console.error(
      "Mac-Druckererkennung fehlgeschlagen:",
      result.stderr
    );

    return [];
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const defaultLine = lines.find((line) =>
    line.startsWith(
      "system default destination:"
    )
  );

  const defaultPrinterName =
    defaultLine
      ? defaultLine
          .replace(
            "system default destination:",
            ""
          )
          .trim()
      : null;

  const printers = [];

  for (const line of lines) {
    if (!line.startsWith("printer ")) {
      continue;
    }

    const match = line.match(
      /^printer\s+(.+?)\s+(is|disabled)\s+(.+)$/
    );

    if (!match) {
      continue;
    }

    const name = match[1];

    const isDisabled =
      line.includes(" is disabled ");

    printers.push({
      name,
      isDefault:
        name === defaultPrinterName,
      status:
        isDisabled
          ? "OFFLINE"
          : "ONLINE",
      portName: null,
      driverName: null,
    });
  }

  return printers;
}

/* =========================================================
   HEARTBEAT
========================================================= */

async function sendHeartbeat(printer) {
  const device = loadDevice();

  if (!device) {
    console.log(
      "⚠ Keine Device-Konfiguration gefunden."
    );
    return {
      ok: false,
      error: "device.json fehlt",
    };
  }

  const token = getToken(device);

  if (!token) {
    console.log(
      "⚠ Kein Device-Token vorhanden."
    );
    return {
      ok: false,
      error: "deviceToken fehlt",
    };
  }

  if (!printer?.name) {
    console.log(
      "⚠ Kein Drucker vorhanden – Heartbeat wird übersprungen."
    );
    return {
      ok: false,
      error: "Kein Drucker",
    };
  }

  const backend = getBackend(device);

  const body = JSON.stringify({
    name: printer.name,
    displayName:
      printer.name,
    location:
      "ALO Versand",
    platform:
      process.platform === "darwin"
        ? "macos"
        : process.platform,
    deviceName:
      device.deviceName ||
      os.hostname(),
    driverName:
      printer.driverName ||
      undefined,
    portName:
      printer.portName ||
      undefined,
    paperSize:
      "102mm",
    agentVersion:
      device.agentVersion ||
      VERSION,
    capabilities: {
      localPrinting: true,
      automaticPrinting: true,
      platform:
        process.platform,
    },
  });

  return new Promise((resolve) => {
    const url = new URL(
      "/api/print-agent/printers/heartbeat",
      backend
    );

    const request = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port:
          url.port ||
          (url.protocol === "https:"
            ? 443
            : 80),
        path:
          url.pathname,
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          "Content-Length":
            Buffer.byteLength(body),
          Authorization:
            `Bearer ${token}`,
          "X-Print-Agent-Token":
            token,
        },
      },
      (response) => {
        let data = "";

        response.on(
          "data",
          (chunk) => {
            data += chunk;
          }
        );

        response.on(
          "end",
          () => {
            if (
              response.statusCode >= 200 &&
              response.statusCode < 300
            ) {
              console.log(
                `✓ Heartbeat OK: ${printer.name}`
              );

              try {
                const parsed =
                  JSON.parse(data);

                if (parsed.printer) {
                  console.log(
                    `  Backend-Drucker: ${parsed.printer.display_name || parsed.printer.name}`
                  );

                  console.log(
                    `  Status: ${parsed.printer.status}`
                  );
                }
              } catch {
                // Antwort muss nicht zwingend JSON sein.
              }

              resolve({
                ok: true,
                status:
                  response.statusCode,
                data,
              });

              return;
            }

            console.error(
              `✗ Heartbeat fehlgeschlagen: HTTP ${response.statusCode}`
            );

            console.error(data);

            resolve({
              ok: false,
              status:
                response.statusCode,
              data,
            });
          }
        );
      }
    );

    request.setTimeout(
      10000,
      () => {
        request.destroy(
          new Error(
            "Heartbeat Timeout"
          )
        );
      }
    );

    request.on(
      "error",
      (error) => {
        console.error(
          "✗ Heartbeat Netzwerkfehler:",
          error.message
        );

        resolve({
          ok: false,
          error: error.message,
        });
      }
    );

    request.write(body);
    request.end();
  });
}

/* =========================================================
   CONNECTOR STATUS
========================================================= */

async function checkAndHeartbeat() {
  const printers =
    await getPrinters();

  console.log("");
  console.log(
    `Erkannte Drucker: ${printers.length}`
  );

  if (printers.length === 0) {
    console.log(
      "- Kein Drucker gefunden"
    );
    console.log("");
    return;
  }

  for (const printer of printers) {
    console.log(
      "-",
      printer.name,
      printer.isDefault
        ? "(STANDARD)"
        : "",
      printer.status
        ? `[${printer.status}]`
        : ""
    );
  }

  const defaultPrinter =
    printers.find(
      (printer) =>
        printer.isDefault
    ) ||
    printers.find(
      (printer) =>
        printer.status ===
        "ONLINE"
    ) ||
    printers[0];

  if (
    defaultPrinter &&
    defaultPrinter.status !==
      "OFFLINE"
  ) {
    await sendHeartbeat(
      defaultPrinter
    );
  }

  console.log("");
}

/* =========================================================
   LOCAL HEALTH API
========================================================= */

const server =
  http.createServer(
    async (req, res) => {
      if (
        req.url ===
        "/health"
      ) {
        const printers =
          await getPrinters();

        const device =
          loadDevice();

        res.writeHead(200, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify({
            ok: true,
            version: VERSION,
            computer:
              os.hostname(),
            platform:
              process.platform,
            architecture:
              process.arch,
            backend:
              getBackend(device),
            paired:
              Boolean(
                getToken(device)
              ),
            printers,
            printerCount:
              printers.length,
          })
        );

        return;
      }

      if (
        req.url ===
        "/printers"
      ) {
        const printers =
          await getPrinters();

        res.writeHead(200, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify({
            ok: true,
            count:
              printers.length,
            printers,
          })
        );

        return;
      }

      res.writeHead(404, {
        "Content-Type":
          "application/json",
      });

      res.end(
        JSON.stringify({
          ok: false,
          error:
            "Not found",
        })
      );
    }
  );

/* =========================================================
   START
========================================================= */

async function main() {
  const device =
    loadDevice();

  console.log(
    "================================="
  );
  console.log(
    "       ALO PRINT CONNECTOR"
  );
  console.log(
    "================================="
  );
  console.log(
    "Version:",
    VERSION
  );
  console.log(
    "Computer:",
    os.hostname()
  );
  console.log(
    "Platform:",
    process.platform
  );
  console.log(
    "Architecture:",
    process.arch
  );
  console.log(
    "Backend:",
    getBackend(device)
  );
  console.log(
    "Gekoppelt:",
    getToken(device)
      ? "JA"
      : "NEIN"
  );
  console.log(
    "---------------------------------"
  );
  console.log(
    "Print Agent gestartet."
  );
  console.log(
    "---------------------------------"
  );

  server.listen(
    PORT,
    "127.0.0.1",
    () => {
      console.log(
        `Local connector status: http://127.0.0.1:${PORT}/health`
      );

      console.log(
        `Local printer API: http://127.0.0.1:${PORT}/printers`
      );
    }
  );

  await checkAndHeartbeat();

  setInterval(
    checkAndHeartbeat,
    HEARTBEAT_INTERVAL
  );
}

main().catch(
  (error) => {
    console.error(
      "ALO Print Connector konnte nicht gestartet werden:",
      error
    );

    process.exitCode = 1;
  }
);
