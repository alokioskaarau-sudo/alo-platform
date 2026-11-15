import {
  ALO_NOW_DRAFT_RECOVERY_QUERY,
  locateAloNowDraftV325
} from "./aloNowDraftRecovery.v325.js";

type Identity = {
  requestId: string;
  checkoutReference: string;
  expectedTotalCHF: string;
};

type Post = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string,string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

// No imported Shopify client, token provider or mutation transport.
// An actual read requires explicitly injected credentials and HTTP.
export async function readAloNowDraftRecoveryV326(
  identity: Identity,
  dependencies: {
    shop: string;
    getAccessToken: () => Promise<string>;
    post: Post;
  }
) {
  if (!DOMAIN.test(dependencies.shop) ||
      dependencies.shop.length > 253) {
    return {status:"INCONCLUSIVE" as const,reason:"INVALID_SHOP"};
  }

  if (!/^query\s+AloNowDraftRecovery\b/.test(
    ALO_NOW_DRAFT_RECOVERY_QUERY.trim()
  ) ||
      /\bmutation\b/i.test(ALO_NOW_DRAFT_RECOVERY_QUERY)) {
    return {status:"INCONCLUSIVE" as const,reason:"QUERY_NOT_ALLOWED"};
  }

  // Authentication is acquired once per bounded scan.
  let token: string;
  try {
    token = await dependencies.getAccessToken();
    if (typeof token !== "string" ||
        token.length < 10 ||
        /[\r\n]/.test(token)) {
      throw new Error("INVALID_TOKEN");
    }
  } catch {
    return {status:"INCONCLUSIVE" as const,reason:"AUTH_UNAVAILABLE"};
  }

  return locateAloNowDraftV325(identity, async after => {
    const result = await dependencies.post(
      `https://${dependencies.shop.toLowerCase()}/admin/api/2026-07/graphql.json`,
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "X-Shopify-Access-Token":token
        },
        body:JSON.stringify({
          query:ALO_NOW_DRAFT_RECOVERY_QUERY,
          variables:{after}
        }),
        signal:AbortSignal.timeout(12000)
      }
    );

    if (!result.ok || result.status !== 200)
      throw new Error("READ_HTTP_FAILURE");

    const data = await result.json();
    if (!data || typeof data !== "object")
      throw new Error("READ_JSON_FAILURE");

    return data;
  });
}
