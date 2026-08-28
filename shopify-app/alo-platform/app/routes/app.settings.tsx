import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Settings() {
  return (
    <s-page heading="Einstellungen">
      <s-section heading="Versand">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Versanddienstleister: Swiss Post
          </s-paragraph>

          <s-paragraph>
            Label-Modus: SPECIMEN
          </s-paragraph>

          <s-paragraph>
            Verpackungsgewicht: 250 g
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Automatischer Etikettendruck">
        <s-paragraph>
          Neue bezahlte Bestellungen sollen automatisch verarbeitet und nach
          erfolgreicher Label-Erstellung an den Standarddrucker gesendet werden.
        </s-paragraph>
      </s-section>

      <s-section heading="Standarddrucker">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Drucker: Noch nicht ausgewählt
          </s-paragraph>

          <s-paragraph>
            Print Agent: Noch nicht verbunden
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Standorte">
        <s-paragraph>
          Die Zuordnung der ALO-Kiosk-Standorte zu Druckern und
          Versandprozessen wird hier verwaltet.
        </s-paragraph>
      </s-section>

      <s-section heading="Sicherheit">
        <s-paragraph>
          Verwaltungsfunktionen werden nur innerhalb der authentifizierten
          ALO Platform im Shopify Admin freigegeben.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
