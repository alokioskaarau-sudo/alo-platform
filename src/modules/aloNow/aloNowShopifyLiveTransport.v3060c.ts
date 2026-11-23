// ALO_NOW_V3060C_LIVE_TRANSPORT
// Real Shopify Draft Order API transport.
// Never retry an uncertain external creation automatically.
// Caller MUST reserve one checkout attempt in DB before invocation.

import {
  buildAloNowDraftGraphqlRequest,
  parseAloNowDraftCreateResponse
} from "./aloNowDraftOrderAdapter.js";

import type {
  DraftTransportResult
} from "./aloNowShopifyCheckoutTransport.js";

type DraftInput = Parameters<
  typeof buildAloNowDraftGraphqlRequest
>[0];

export async function createAloNowShopifyDraftLiveV3060C(
  input: {
    draftInput: DraftInput;
    expectedTotalCHF: string;
    shopDomain: string;
    accessToken: string;
  }
): Promise<DraftTransportResult> {
  // Explicit production release switch.
  if (
    process.env.ALO_NOW_LIVE_DRAFT_CHECKOUT_ENABLED !== "true"
  ) {
    return {
      ok: false,
      reason: "LIVE_CHECKOUT_NOT_ENABLED",
      reconciliationRequired: false
    };
  }

  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(
      input.shopDomain
    ) ||
    typeof input.accessToken !== "string" ||
    input.accessToken.length < 10 ||
    /[\r\n]/.test(input.accessToken) ||
    !/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(
      input.expectedTotalCHF
    )
  ) {
    return {
      ok: false,
      reason: "INVALID_LIVE_SHOPIFY_CONFIGURATION",
      reconciliationRequired: false
    };
  }

  let request: ReturnType<
    typeof buildAloNowDraftGraphqlRequest
  >;

  try {
    // Existing validated GraphQL input and CHF safeguards.
    request = buildAloNowDraftGraphqlRequest(
      input.draftInput
    );
  } catch {
    return {
      ok: false,
      reason: "INVALID_LIVE_DRAFT_INPUT",
      reconciliationRequired: false
    };
  }

  // Once HTTP starts, any uncertain response must be
  // reconciled with Shopify; no automatic second create.
  try {
    const response = await fetch(
      `https://${input.shopDomain}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": input.accessToken
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!response.ok) {
      return {
        ok: false,
        reason: `SHOPIFY_HTTP_${response.status}`,
        reconciliationRequired: true
      };
    }

    const payload: unknown = await response.json();

    const parsed = parseAloNowDraftCreateResponse(
      payload,
      input.expectedTotalCHF
    );

    if (!parsed.ok) {
      return {
        ok: false,
        reason: parsed.reason,
        reconciliationRequired: true
      };
    }

    if (!parsed.invoiceUrl) {
      return {
        ok: false,
        reason: "SHOPIFY_INVOICE_URL_MISSING",
        reconciliationRequired: true
      };
    }

    const url = new URL(parsed.invoiceUrl);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password
    ) {
      return {
        ok: false,
        reason: "SHOPIFY_INVOICE_URL_INVALID",
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
      reason: "SHOPIFY_CREATION_RESULT_UNKNOWN",
      reconciliationRequired: true
    };
  }
}
