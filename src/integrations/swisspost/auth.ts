import axios from "axios";
import { env } from "../../config/env.js";

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export async function getSwissPostAccessToken(): Promise<string> {
  const now = Date.now();

  // Token noch gültig? Dann wiederverwenden.
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const body = new URLSearchParams();

  body.append("grant_type", "client_credentials");
  body.append("client_id", env.swissPost.clientId);
  body.append("client_secret", env.swissPost.clientSecret);
  body.append(
    "scope",
    "DCAPI_BARCODE_READ DCAPI_ADDRESS_VALIDATE DCAPI_ADDRESS_AUTOCOMPLETE"
  );

  try {
    const response = await axios.post<TokenResponse>(
      env.swissPost.tokenUrl,
      body.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );

    cachedToken = response.data.access_token;

    // Kleiner Sicherheitspuffer, damit wir keinen fast abgelaufenen Token verwenden.
    const expiresIn = response.data.expires_in || 300;
    tokenExpiresAt = Date.now() + Math.max(expiresIn - 20, 30) * 1000;

    return cachedToken;
  } catch (error: any) {
    const status = error.response?.status;
    const data = error.response?.data;

    console.error("Swiss Post OAuth Fehler:", status, data);

    throw new Error(
      `Swiss Post authentication failed${status ? ` (${status})` : ""}`
    );
  }
}
