import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const BACKEND_URL = "https://alo-platform-production.up.railway.app";

type ShippingLabel = {
  id: string;
  shopify_order_name: string;
  label_mode: string;
  service: string;
  weight_grams: number;
  address_quality: string | null;
  shipment_status: string;
  print_status: string;
  print_count: number;
  printer_name: string | null;
  tracking_number: string | null;
  error_message: string | null;
  created_at: string;
};

type ShippingDashboard = {
  ok: boolean;
  stats: {
    total: number;
    ready: number;
    queued: number;
    printed: number;
    failed: number;
  };
  labels: ShippingLabel[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const response = await fetch(
      `${BACKEND_URL}/api/shipping/dashboard`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Backend antwortet mit HTTP ${response.status}`);
    }

    const data = (await response.json()) as ShippingDashboard;

    return {
      connected: true,
      error: null,
      dashboard: data,
    };
  } catch (error) {
    return {
      connected: false,
      error:
        error instanceof Error
          ? error.message
          : "Unbekannter Verbindungsfehler",
      dashboard: null,
    };
  }
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("de-CH", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function Shipping() {
  const data = useLoaderData<typeof loader>();

  if (!data.connected || !data.dashboard) {
    return (
      <s-page heading="Versand">
        <s-section heading="Verbindungsfehler">
          <s-paragraph>
            Die ALO Platform konnte das Railway-Versandsystem nicht erreichen.
          </s-paragraph>

          <s-paragraph>
            Fehler: {data.error || "Unbekannter Fehler"}
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const { stats, labels } = data.dashboard;

  return (
    <s-page heading="Versand">
      <s-section heading="Systemstatus">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Railway Backend: Verbunden
          </s-paragraph>

          <s-paragraph>
            Swiss Post: SPECIMEN
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Versandübersicht">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Gesamt: {stats.total}
          </s-paragraph>

          <s-paragraph>
            Bereit: {stats.ready}
          </s-paragraph>

          <s-paragraph>
            Warten auf Druck: {stats.queued}
          </s-paragraph>

          <s-paragraph>
            Gedruckt: {stats.printed}
          </s-paragraph>

          <s-paragraph>
            Fehler: {stats.failed}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Versandetiketten">
        {labels.length === 0 ? (
          <s-paragraph>
            Momentan sind keine Versandetiketten vorhanden.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {labels.map((label) => (
              <s-box
                key={label.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-heading>
                    {label.shopify_order_name}
                  </s-heading>

                  <s-paragraph>
                    Service: {label.service}
                  </s-paragraph>

                  <s-paragraph>
                    Gewicht: {label.weight_grams} g
                  </s-paragraph>

                  <s-paragraph>
                    Label: {label.label_mode}
                  </s-paragraph>

                  <s-paragraph>
                    Versandstatus: {label.shipment_status}
                  </s-paragraph>

                  <s-paragraph>
                    Druckstatus: {label.print_status}
                  </s-paragraph>

                  <s-paragraph>
                    Drucker: {label.printer_name || "Noch keiner"}
                  </s-paragraph>

                  <s-paragraph>
                    Erstellt: {formatDate(label.created_at)}
                  </s-paragraph>

                  {label.error_message && (
                    <s-paragraph>
                      Fehler: {label.error_message}
                    </s-paragraph>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Sicherheitsmodus">
        <s-paragraph>
          Swiss Post bleibt weiterhin im SPECIMEN-Modus.
        </s-paragraph>

        <s-paragraph>
          Es werden noch keine echten Versandetiketten erzeugt.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
