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
  shipment_status: string;
  print_status: string;
  print_count: number;
  printer_name: string | null;
  printed_at: string | null;
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
      stats: data.stats,
      jobs: data.labels,
    };
  } catch (error) {
    return {
      connected: false,
      error:
        error instanceof Error
          ? error.message
          : "Unbekannter Verbindungsfehler",
      stats: {
        total: 0,
        ready: 0,
        queued: 0,
        printed: 0,
        failed: 0,
      },
      jobs: [],
    };
  }
};

function formatDate(value: string | null) {
  if (!value) return "–";

  return new Intl.DateTimeFormat("de-CH", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function Queue() {
  const data = useLoaderData<typeof loader>();

  if (!data.connected) {
    return (
      <s-page heading="Warteschlange">
        <s-section heading="Verbindungsfehler">
          <s-paragraph>
            Die Druckwarteschlange konnte Railway nicht erreichen.
          </s-paragraph>

          <s-paragraph>
            Fehler: {data.error || "Unbekannter Fehler"}
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const activeJobs = data.jobs.filter(
    (job) =>
      job.print_status === "QUEUED" ||
      job.print_status === "PROCESSING" ||
      job.print_status === "FAILED",
  );

  return (
    <s-page heading="Warteschlange">
      <s-section heading="Druckstatus">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Warten auf Druck: {data.stats.queued}
          </s-paragraph>

          <s-paragraph>
            Gedruckt: {data.stats.printed}
          </s-paragraph>

          <s-paragraph>
            Fehler: {data.stats.failed}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Aktuelle Druckaufträge">
        {activeJobs.length === 0 ? (
          <s-paragraph>
            Aktuell gibt es keine offenen oder fehlgeschlagenen Druckaufträge.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {activeJobs.map((job) => (
              <s-box
                key={job.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-heading>
                    {job.shopify_order_name}
                  </s-heading>

                  <s-paragraph>
                    Druckstatus: {job.print_status}
                  </s-paragraph>

                  <s-paragraph>
                    Versandstatus: {job.shipment_status}
                  </s-paragraph>

                  <s-paragraph>
                    Drucker: {job.printer_name || "Noch keiner"}
                  </s-paragraph>

                  <s-paragraph>
                    Druckversuche: {job.print_count}
                  </s-paragraph>

                  <s-paragraph>
                    Label-Modus: {job.label_mode}
                  </s-paragraph>

                  <s-paragraph>
                    Erstellt: {formatDate(job.created_at)}
                  </s-paragraph>

                  <s-paragraph>
                    Gedruckt: {formatDate(job.printed_at)}
                  </s-paragraph>

                  {job.error_message && (
                    <s-paragraph>
                      Fehler: {job.error_message}
                    </s-paragraph>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Automatischer Druck">
        <s-paragraph>
          Sobald der Windows Print Agent verbunden ist, holt er wartende
          Druckaufträge automatisch ab und sendet sie an den Standarddrucker.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Status">
        <s-paragraph>
          Railway Backend: Verbunden
        </s-paragraph>

        <s-paragraph>
          Swiss Post: SPECIMEN
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
