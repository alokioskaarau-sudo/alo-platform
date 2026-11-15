import {
  parseAloNowDraftCreateResponse
} from "./aloNowDraftOrderAdapter.js";

// Security: enabling an environment variable CANNOT activate writes.
// A future production release requires an explicit code review.
const REAL_DRAFT_WRITES_ENABLED = false as boolean;

type GraphqlRequest = {
  query: string;
  variables: {
    input: Record<string, unknown>;
  };
};

type HttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type HttpPoster = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<HttpResponse>;

type Result =
  | {
      ok: true;
      draftOrderId: string;
      totalCHF: string;
    }
  | {
      ok: false;
      reason: string;
    };

function shopDomain(raw: string): string {
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(raw) ||
    raw.length > 253
  ) {
    throw new Error("SHOPIFY_DOMAIN_INVALID");
  }
  return raw.toLowerCase();
}

function prepareRequest(request: GraphqlRequest) {
  if (
    !request ||
    typeof request.query !== "string" ||
    !/mutation\s+AloNowCreateDraftOrder\s*\(/.test(
      request.query
    ) ||
    !request.query.includes("draftOrderCreate(input: $input)")
  ) {
    throw new Error("SHOPIFY_MUTATION_NOT_ALLOWED");
  }

  const input = request.variables?.input;

  if (
    !input ||
    input.presentmentCurrencyCode !== "CHF" ||
    input.acceptAutomaticDiscounts !== false ||
    input.allowDiscountCodesInCheckout !== false ||
    !Array.isArray(input.lineItems) ||
    input.lineItems.length < 1
  ) {
    throw new Error("SHOPIFY_INPUT_NOT_ALLOWED");
  }

  const attributes = input.customAttributes;

  if (!Array.isArray(attributes) ||
      attributes.length !== 2) {
    throw new Error("SHOPIFY_IDENTITY_MISSING");
  }

  return JSON.stringify(request);
}

/**
 * Shared HTTP contract for OFFLINE transport tests.
 * No customer route may call this.
 * Invoice links are deliberately not returned.
 */
export async function simulateAloNowDraftHttpV324(
  request: GraphqlRequest,
  expectedTotalCHF: string,
  options: {
    domain: string;
    accessToken: string;
    post: HttpPoster;
  }
): Promise<Result> {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.ALO_RUNTIME_MODE !== "local_test" ||
    process.env.ALO_NOW_DRAFT_SIMULATION_ENABLED !== "true"
  ) {
    return {ok:false,reason:"HTTP_SIMULATION_DISABLED"};
  }

  let body: string;
  let domain: string;

  try {
    body = prepareRequest(request);
    domain = shopDomain(options.domain);

    if (
      typeof options.accessToken !== "string" ||
      options.accessToken.length < 10 ||
      /[\r\n]/.test(options.accessToken)
    ) {
      throw new Error("SHOPIFY_TOKEN_INVALID");
    }
  } catch {
    return {ok:false,reason:"SHOPIFY_REQUEST_REJECTED"};
  }

  try {
    const response = await options.post(
      `https://${domain}/admin/api/2026-07/graphql.json`,
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

    if (!response.ok) {
      return {
        ok:false,
        reason:"SHOPIFY_HTTP_UNCONFIRMED"
      };
    }

    const payload = await response.json();

    const parsed = parseAloNowDraftCreateResponse(
      payload,
      expectedTotalCHF
    );

    if (!parsed.ok) {
      return {
        ok:false,
        reason:"SHOPIFY_DRAFT_REQUIRES_RECONCILIATION"
      };
    }

    return {
      ok:true,
      draftOrderId:parsed.draftOrderId,
      totalCHF:parsed.totalCHF
    };
  } catch {
    return {
      ok:false,
      reason:"SHOPIFY_TRANSPORT_UNCONFIRMED"
    };
  }
}

/**
 * Production entry point:
 * HARDCODED OFF until provenance, shipping address,
 * taxes and crash reconciliation are integrated.
 *
 * Never call Shopify from this function at present.
 */
export async function createAloNowShopifyDraftV324(
  _request: GraphqlRequest,
  _expectedTotalCHF: string
): Promise<Result> {
  if (!REAL_DRAFT_WRITES_ENABLED) {
    return {
      ok:false,
      reason:"SHOPIFY_DRAFT_WRITES_DISABLED"
    };
  }

  return {
    ok:false,
    reason:"SHOPIFY_DRAFT_WRITES_NOT_IMPLEMENTED"
  };
}
