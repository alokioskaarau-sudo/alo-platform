import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export const env = {
  port: Number(process.env.PORT || 3000),

  swissPost: {
    clientId: requireEnv("POST_CLIENT_ID"),
    clientSecret: requireEnv("POST_CLIENT_SECRET"),
    frankingLicense: requireEnv("POST_FRANKING_LICENSE"),

    tokenUrl: "https://api.post.ch/OAuth/token",
    barcodeBaseUrl: "https://dcapi.apis.post.ch/barcode/v1",
    addressBaseUrl: "https://dcapi.apis.post.ch/address/v1",
  },

  shopify: {
    shop: requireEnv("SHOPIFY_SHOP"),
    clientId: requireEnv("SHOPIFY_CLIENT_ID"),
    clientSecret: requireEnv("SHOPIFY_CLIENT_SECRET"),
    apiVersion: "2026-07",
  },
};
