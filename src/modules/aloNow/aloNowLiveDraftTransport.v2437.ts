import {
  ALO_NOW_DRAFT_CREATE_MUTATION,
  buildAloNowDraftGraphqlRequest,
  parseAloNowDraftCreateResponse
} from "./aloNowDraftOrderAdapter.js";

type GraphqlRequest =
  ReturnType<typeof buildAloNowDraftGraphqlRequest>;

type ShopifyResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type Sender = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<ShopifyResponse>;

export type LiveDraftResult =
  | {
      ok: true;
      draftOrderId: string;
      totalCHF: string;
      shopifyResponse: unknown;
      invoiceUrl: string | null;
    }
  | {
      ok: false;
      reason: string;
    };

const DOMAIN =
  /^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$/i;

export async function sendAloNowLiveDraftV2437(
  request: GraphqlRequest,
  expectedTotalCHF: string,
  options: {
    domain: string;
    accessToken: string;
    send: Sender;
  }
): Promise<LiveDraftResult> {

  // No live writes without a deliberate deployment release.
  if (
    process.env.ALO_NOW_REAL_DRAFT_WRITES_ENABLED !== "true" ||
    process.env.ALO_RUNTIME_MODE !== "production" ||
    process.env.NODE_ENV !== "production"
  ) {
    return { ok: false, reason: "LIVE_DRAFT_DISABLED" };
  }

  if (
    !request ||
    typeof options?.domain !== "string" ||
    !DOMAIN.test(options.domain) ||
    typeof options.accessToken !== "string" ||
    options.accessToken.length < 10 ||
    /[\x0d\x0a]/.test(options.accessToken) ||
    typeof options.send !== "function"
  ) {
    return { ok: false, reason: "INVALID_DRAFT_REQUEST" };
  }

  let body: string;

  try {
    // Exact mutation allowlist, not a substring check.
    if (
      request.query.trim() !==
      ALO_NOW_DRAFT_CREATE_MUTATION.trim()
    ) {
      throw new Error("MUTATION_NOT_ALLOWED");
    }

    const input = request.variables?.input;

    const canonical = buildAloNowDraftGraphqlRequest(
      input as Parameters<
        typeof buildAloNowDraftGraphqlRequest
      >[0]
    );

    // Includes currency, variant IDs, quantities,
    // checkout identity and discount restrictions.
    if (
      JSON.stringify(request.variables.input) !==
      JSON.stringify(canonical.variables.input)
    ) {
      throw new Error("NONCANONICAL_DRAFT");
    }

    body = JSON.stringify(canonical);

  } catch {
    return { ok: false, reason: "INVALID_DRAFT_REQUEST" };
  }

  try {
    const response = await options.send(
      "https://" + options.domain.toLowerCase() +
      "/admin/api/2026-07/graphql.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": options.accessToken
        },
        body,
        signal: AbortSignal.timeout(12000)
      }
    );

    // A failed HTTP response can still represent
    // an uncertain Shopify creation outcome.
    if (!response.ok) {
      return {
        ok: false,
        reason: "SHOPIFY_OUTCOME_UNCERTAIN"
      };
    }

    const rawResponse = await response.json();

    const parsed = parseAloNowDraftCreateResponse(
      rawResponse,
      expectedTotalCHF
    );

    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }

    // Required by recordAloNowDraftOutcome.
    // Never expose this raw response to the browser.
    return {
      ok: true,
      draftOrderId: parsed.draftOrderId,
      totalCHF: parsed.totalCHF,
      shopifyResponse: rawResponse,
      invoiceUrl: parsed.invoiceUrl
    };

  } catch {
    // Never retry an uncertain Shopify mutation automatically.
    return {
      ok: false,
      reason: "SHOPIFY_OUTCOME_UNCERTAIN"
    };
  }
}
