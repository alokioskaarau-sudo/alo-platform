import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="ALO Platform">
      <s-section heading="Versand & Fulfillment">
        <s-paragraph>
          Zentrale Steuerung für Bestellungen, Versandetiketten,
          Drucker und Fulfillment von ALO Kiosk.
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <s-button href="/app/shipping" variant="primary">
            Versand öffnen
          </s-button>

          <s-button href="/app/printers">
            Drucker verwalten
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Systemstatus">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Shopify: Verbunden
          </s-paragraph>

          <s-paragraph>
            Versandplattform: Wird verbunden
          </s-paragraph>

          <s-paragraph>
            Swiss Post: SPECIMEN-Modus
          </s-paragraph>

          <s-paragraph>
            Drucksystem: Einrichtung ausstehend
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="ALO Shipping">
        <s-paragraph>
          Zentrale Versand- und Drucksteuerung für ALO Kiosk.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
