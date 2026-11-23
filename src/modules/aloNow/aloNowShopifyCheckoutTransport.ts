import {
  buildAloNowDraftGraphqlRequest,
  parseAloNowDraftCreateResponse
} from "./aloNowDraftOrderAdapter.js";

type Input = Parameters<
  typeof buildAloNowDraftGraphqlRequest
>[0];

type HttpResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type HttpPost = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string,string>;
    body: string;
  }
) => Promise<HttpResponse>;

export type DraftTransportResult =
  | {
      ok: true;
      draftOrderId: string;
      invoiceUrl: string;
      totalCHF: string;
    }
  | {
      ok: false;
      reason: string;
      reconciliationRequired: boolean;
    };

/**
 * V2968 – Offline Shopify Checkout Transport.
 *
 * Production writes deliberately unavailable.
 * Calls an injected fake HTTP client only in local_test.
 *
 * Any uncertain external create response requires
 * reconciliation; never retry automatically.
 */
export async function simulateAloNowShopifyDraftCreate(
  input: Input,
  expectedTotalCHF: string,
  options: {
    shopDomain: string;
    accessToken: string;
    post: HttpPost;
  }
): Promise<DraftTransportResult> {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.ALO_RUNTIME_MODE !== "local_test" ||
    process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED !== "true"
  ) {
    return {
      ok: false,
      reason: "SHOPIFY_DRAFT_SIMULATION_DISABLED",
      reconciliationRequired: false
    };
  }

  let request: ReturnType<
    typeof buildAloNowDraftGraphqlRequest
  >;

  try {
    request = buildAloNowDraftGraphqlRequest(input);

    if (
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(
        options.shopDomain
      ) ||
      !options.accessToken ||
      options.accessToken.length < 10 ||
      /[\r\n]/.test(options.accessToken) ||
      !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(
        expectedTotalCHF
      )
    ) {
      throw new Error("INVALID_SHOPIFY_CONFIGURATION");
    }
  } catch {
    return {
      ok: false,
      reason: "DRAFT_INPUT_REJECTED",
      reconciliationRequired: false
    };
  }

  try {
    const response = await options.post(
      `https://${options.shopDomain}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": options.accessToken
        },
        body: JSON.stringify(request)
      }
    );

    if (!response.ok) {
      return {
        ok: false,
        reason: "SHOPIFY_RESPONSE_UNCONFIRMED",
        reconciliationRequired: true
      };
    }

    const payload = await response.json();

    const parsed = parseAloNowDraftCreateResponse(
      payload,
      expectedTotalCHF
    );

    if (!parsed.ok || !parsed.invoiceUrl) {
      return {
        ok: false,
        reason: "SHOPIFY_DRAFT_RECONCILIATION_REQUIRED",
        reconciliationRequired: true
      };
    }

    return {
      ok: true,
      draftOrderId: parsed.draftOrderId,
      invoiceUrl: parsed.invoiceUrl,
      totalCHF: parsed.totalCHF
    };
  } catch {
    return {
      ok: false,
      reason: "SHOPIFY_NETWORK_RESULT_UNKNOWN",
      reconciliationRequired: true
    };
  }
}
