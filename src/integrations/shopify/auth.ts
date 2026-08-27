import axios from "axios";
import { env } from "../../config/env.js";

type ShopifyTokenResponse = {
  access_token: string;
  scope?: string;
  expires_in: number;
};

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function normalizeShop(shop: string): string {
  return shop
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");
}

export async function getShopifyAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const shop = normalizeShop(env.shopify.shop);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.shopify.clientId,
    client_secret: env.shopify.clientSecret,
  });

  try {
    const response = await axios.post<ShopifyTokenResponse>(
      `https://${shop}.myshopify.com/admin/oauth/access_token`,
      body.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 15000,
      }
    );

    cachedToken = response.data.access_token;

    const expiresIn = response.data.expires_in || 86399;

    tokenExpiresAt = Date.now() + expiresIn * 1000;

    return cachedToken;
  } catch (error: any) {
    console.error(
      "Shopify authentication error:",
      error.response?.status,
      error.response?.data
    );

    throw new Error(
      `Shopify authentication failed${
        error.response?.status
          ? ` (${error.response.status})`
          : ""
      }`
    );
  }
}
