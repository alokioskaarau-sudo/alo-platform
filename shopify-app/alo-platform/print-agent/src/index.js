const os = require("os");
const http = require("http");

const VERSION = "1.0.0";
const BACKEND = "https://alo-platform-production.up.railway.app";

console.log("=================================");
console.log("       ALO PRINT CONNECTOR");
console.log("=================================");
console.log("Version:", VERSION);
console.log("Computer:", os.hostname());
console.log("Platform:", process.platform);
console.log("Architecture:", process.arch);
console.log("Backend:", BACKEND);
console.log("---------------------------------");
console.log("Print Agent gestartet.");
console.log("---------------------------------");

function getPrinters() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve([]);
      return;
    }

    const { exec } = require("child_process");

    exec(
      'powershell -NoProfile -Command "Get-Printer | Select-Object Name,Default,PrinterStatus,PortName,DriverName | ConvertTo-Json -Compress"',
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.error("Druckererkennung fehlgeschlagen:", error.message);
          resolve([]);
          return;
        }

        try {
          if (!stdout.trim()) {
            resolve([]);
            return;
          }

          let printers = JSON.parse(stdout);

          if (!Array.isArray(printers)) {
            printers = [printers];
          }

          resolve(
            printers.map((printer) => ({
              name: printer.Name || "Unbekannter Drucker",
              isDefault: printer.Default === true,
              status: String(printer.PrinterStatus || ""),
              portName: printer.PortName || null,
              driverName: printer.DriverName || null
            }))
          );
        } catch (e) {
          console.error("Druckerdaten konnten nicht gelesen werden.");
          resolve([]);
        }
      }
    );
  });
}

async function showPrinters() {
  const printers = await getPrinters();

  console.log("");
  console.log("Erkannte Drucker:", printers.length);

  for (const printer of printers) {
    console.log(
      "-",
      printer.name,
      printer.isDefault ? "(STANDARD)" : "",
      printer.driverName ? `[${printer.driverName}]` : ""
    );
  }

  console.log("");
}

showPrinters();

setInterval(showPrinters, 30000);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        ok: true,
        version: VERSION,
        computer: os.hostname(),
        platform: process.platform
      })
    );

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(17891, "127.0.0.1", () => {
  console.log("Local connector status: http://127.0.0.1:17891/health");
});
