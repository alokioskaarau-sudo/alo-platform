import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";

import {
  useFetcher,
  useLoaderData,
} from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const BACKEND_URL =
  "https://alo-platform-production.up.railway.app";

type Printer = {
  id: string;
  name: string;
  display_name: string | null;
  location: string | null;
  platform: string | null;
  status: string;
  is_default: boolean;
  agent_version: string | null;
  device_name: string | null;
  driver_name: string | null;
  port_name: string | null;
  paper_size: string | null;
  last_error: string | null;
  last_seen_at: string | null;
};

type PrintersResponse = {
  ok: boolean;
  count: number;
  defaultPrinter: Printer | null;
  printers: Printer[];
};

type PairingResponse = {
  ok: boolean;
  code?: string;
  expiresInMinutes?: number;
  error?: string;
};

/* =========================================================
   LOADER
========================================================= */

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const response = await fetch(
      `${BACKEND_URL}/api/printers`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Backend antwortet mit HTTP ${response.status}`,
      );
    }

    const data =
      (await response.json()) as PrintersResponse;

    return {
      connected: true,
      error: null,
      printers: data.printers ?? [],
      defaultPrinter: data.defaultPrinter ?? null,
      count: data.count ?? 0,
    };
  } catch (error) {
    return {
      connected: false,
      error:
        error instanceof Error
          ? error.message
          : "Unbekannter Verbindungsfehler",
      printers: [] as Printer[],
      defaultPrinter: null as Printer | null,
      count: 0,
    };
  }
};

/* =========================================================
   ACTION
========================================================= */

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  try {
    await authenticate.admin(request);

    const formData = await request.formData();

    const intent = String(
      formData.get("intent") ?? "",
    ).trim();

    if (intent !== "create-pairing-code") {
      return {
        ok: false,
        error: "Unbekannte Aktion.",
      } satisfies PairingResponse;
    }

    const response = await fetch(
      `${BACKEND_URL}/api/printer-pairing/create`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    let data: PairingResponse;

    try {
      data =
        (await response.json()) as PairingResponse;
    } catch {
      return {
        ok: false,
        error:
          `Railway hat keine gültige Antwort geliefert ` +
          `(HTTP ${response.status}).`,
      } satisfies PairingResponse;
    }

    if (!response.ok || !data.ok) {
      return {
        ok: false,
        error:
          data.error ||
          `Pairing fehlgeschlagen (HTTP ${response.status}).`,
      } satisfies PairingResponse;
    }

    if (!data.code) {
      return {
        ok: false,
        error:
          "Railway hat keinen Pairing-Code zurückgegeben.",
      } satisfies PairingResponse;
    }

    return {
      ok: true,
      code: data.code,
      expiresInMinutes:
        data.expiresInMinutes ?? 10,
    } satisfies PairingResponse;
  } catch (error) {
    console.error(
      "Printer Pairing Action Error:",
      error,
    );

    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Pairing-Code konnte nicht erzeugt werden.",
    } satisfies PairingResponse;
  }
};

/* =========================================================
   HELPERS
========================================================= */

function formatDate(
  value: string | null,
) {
  if (!value) return "Noch nie";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unbekannt";
  }

  return new Intl.DateTimeFormat(
    "de-CH",
    {
      dateStyle: "short",
      timeStyle: "short",
    },
  ).format(date);
}

function printerStatusLabel(
  status: string,
) {
  switch (
    status.trim().toUpperCase()
  ) {
    case "ONLINE":
      return "Online";

    case "OFFLINE":
      return "Offline";

    case "ERROR":
      return "Fehler";

    default:
      return status || "Unbekannt";
  }
}

/* =========================================================
   PAGE
========================================================= */

export default function Printers() {
  const data =
    useLoaderData<typeof loader>();

  const pairingFetcher =
    useFetcher<typeof action>();

  const pairingData =
    pairingFetcher.data;

  const pairingLoading =
    pairingFetcher.state !== "idle";

  const pairingCode =
    pairingData?.ok
      ? pairingData.code
      : null;

  const pairingError =
    pairingData &&
    !pairingData.ok
      ? pairingData.error
      : null;

  const singlePrinter =
    data.count === 1
      ? data.printers[0]
      : null;

  const effectiveDefaultPrinter =
    data.defaultPrinter ??
    singlePrinter ??
    null;

  function createPairingCode() {
    if (pairingLoading) return;

    pairingFetcher.submit(
      {
        intent: "create-pairing-code",
      },
      {
        method: "post",
      },
    );
  }

  return (
    <s-page heading="Drucker">

      {/* ===================================================
          BACKEND STATUS
      =================================================== */}

      <s-section heading="Druckersystem">
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Railway Backend:{" "}
            {data.connected
              ? "Verbunden"
              : "Nicht erreichbar"}
          </s-paragraph>

          {data.connected ? (
            <>
              <s-paragraph>
                Erkannte Drucker:{" "}
                {data.count}
              </s-paragraph>

              <s-paragraph>
                Automatisch ausgewählt:{" "}
                {effectiveDefaultPrinter?.display_name ||
                  effectiveDefaultPrinter?.name ||
                  "Noch keiner"}
              </s-paragraph>
            </>
          ) : (
            <s-paragraph>
              Fehler:{" "}
              {data.error ||
                "Unbekannter Verbindungsfehler"}
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      {/* ===================================================
          DRUCKER VERBINDEN
      =================================================== */}

      <s-section heading="Drucker verbinden">
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Verbinde einen Computer mit der
            ALO Platform. Dafür wird einmalig
            ein sechsstelliger Verbindungscode
            erzeugt.
          </s-paragraph>

          {!pairingCode && (
            <>
              <s-button
                variant="primary"
                onClick={createPairingCode}
                disabled={pairingLoading}
              >
                {pairingLoading
                  ? "Code wird erstellt..."
                  : "Drucker verbinden"}
              </s-button>
            </>
          )}

          {pairingError && (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="base"
              >
                <s-heading>
                  Verbindung fehlgeschlagen
                </s-heading>

                <s-paragraph>
                  {pairingError}
                </s-paragraph>

                <s-button
                  variant="primary"
                  onClick={createPairingCode}
                  disabled={pairingLoading}
                >
                  Erneut versuchen
                </s-button>
              </s-stack>
            </s-box>
          )}

          {pairingCode && (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack
                direction="block"
                gap="base"
              >
                <s-heading>
                  Verbindungscode
                </s-heading>

                <s-heading>
                  {pairingCode}
                </s-heading>

                <s-paragraph>
                  Dieser Code ist{" "}
                  {pairingData?.expiresInMinutes ??
                    10}{" "}
                  Minuten gültig und kann
                  nur einmal verwendet werden.
                </s-paragraph>

                <s-paragraph>
                  Öffne jetzt den ALO Print
                  Connector auf dem Computer
                  und gib diesen Code dort ein.
                </s-paragraph>

                <s-button
                  onClick={createPairingCode}
                  disabled={pairingLoading}
                >
                  Neuen Code erzeugen
                </s-button>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>

      {/* ===================================================
          KEINE DRUCKER
      =================================================== */}

      {data.connected &&
        data.count === 0 && (
          <s-section
            heading="Noch kein Drucker verbunden"
          >
            <s-stack
              direction="block"
              gap="base"
            >
              <s-paragraph>
                Aktuell ist noch kein Drucker
                mit der ALO Platform verbunden.
              </s-paragraph>

              <s-paragraph>
                Sobald der ALO Print Connector
                gekoppelt ist und einen Drucker
                erkennt, erscheint er
                automatisch hier.
              </s-paragraph>
            </s-stack>
          </s-section>
        )}

      {/* ===================================================
          DRUCKERLISTE
      =================================================== */}

      {data.connected &&
        data.count > 0 && (
          <s-section
            heading="Verfügbare Drucker"
          >
            <s-stack
              direction="block"
              gap="base"
            >
              {data.printers.map(
                (printer) => (
                  <s-box
                    key={printer.id}
                    padding="base"
                    borderWidth="base"
                    borderRadius="base"
                  >
                    <s-stack
                      direction="block"
                      gap="base"
                    >
                      <s-heading>
                        {printer.display_name ||
                          printer.name}
                      </s-heading>

                      <s-paragraph>
                        Status:{" "}
                        {printerStatusLabel(
                          printer.status,
                        )}
                      </s-paragraph>

                      <s-paragraph>
                        Standarddrucker:{" "}
                        {printer.is_default
                          ? "Ja"
                          : "Nein"}
                      </s-paragraph>

                      <s-paragraph>
                        Standort:{" "}
                        {printer.location ||
                          "Noch nicht festgelegt"}
                      </s-paragraph>

                      <s-paragraph>
                        Computer:{" "}
                        {printer.device_name ||
                          "Nicht gemeldet"}
                      </s-paragraph>

                      <s-paragraph>
                        Connector:{" "}
                        {printer.agent_version
                          ? `Version ${printer.agent_version}`
                          : "Nicht gemeldet"}
                      </s-paragraph>

                      <s-paragraph>
                        Plattform:{" "}
                        {printer.platform ||
                          "Nicht gemeldet"}
                      </s-paragraph>

                      <s-paragraph>
                        Treiber:{" "}
                        {printer.driver_name ||
                          "Nicht gemeldet"}
                      </s-paragraph>

                      <s-paragraph>
                        Anschluss:{" "}
                        {printer.port_name ||
                          "Nicht gemeldet"}
                      </s-paragraph>

                      <s-paragraph>
                        Papier:{" "}
                        {printer.paper_size ||
                          "Nicht gemeldet"}
                      </s-paragraph>

                      <s-paragraph>
                        Letzter Kontakt:{" "}
                        {formatDate(
                          printer.last_seen_at,
                        )}
                      </s-paragraph>

                      {printer.last_error && (
                        <s-paragraph>
                          Fehler:{" "}
                          {printer.last_error}
                        </s-paragraph>
                      )}
                    </s-stack>
                  </s-box>
                ),
              )}
            </s-stack>
          </s-section>
        )}

      {/* ===================================================
          AUTO AUSWAHL
      =================================================== */}

      <s-section heading="Automatische Druckerauswahl">
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Die ALO Platform wählt automatisch
            einen verfügbaren Drucker.
          </s-paragraph>

          <s-paragraph>
            Priorität: Online-Standarddrucker,
            danach der einzige verfügbare
            Online-Drucker.
          </s-paragraph>

          <s-paragraph>
            Ist kein Drucker verfügbar, bleibt
            der Auftrag in der Warteschlange,
            bis wieder ein Drucker online ist.
          </s-paragraph>
        </s-stack>
      </s-section>

      {/* ===================================================
          ASIDE
      =================================================== */}

      <s-section
        slot="aside"
        heading="ALO Print Connector"
      >
        <s-stack
          direction="block"
          gap="base"
        >
          <s-paragraph>
            Der Connector verbindet den
            lokalen Computer mit der
            ALO Platform.
          </s-paragraph>

          <s-paragraph>
            Nach der einmaligen Kopplung
            wird der Computer automatisch
            wiedererkannt.
          </s-paragraph>

          <s-paragraph>
            Der lokale Drucker wird über den
            Connector an Railway gemeldet.
          </s-paragraph>

          <s-paragraph>
            Das System ist dadurch unabhängig
            davon, ob die ALO Platform auf
            einem Mac oder Windows-PC geöffnet
            wird.
          </s-paragraph>
        </s-stack>
      </s-section>

    </s-page>
  );
}

/* =========================================================
   SHOPIFY HEADERS
========================================================= */

export const headers: HeadersFunction = (
  headersArgs,
) => {
  return boundary.headers(
    headersArgs,
  );
};
