import type { Config } from "@react-router/dev/config";

export default {
  allowedActionOrigins: [
    "admin.shopify.com",
    "alo-kiosk.myshopify.com",
    "localhost:8080",
    "daring-acceptance-production-049e.up.railway.app",
  ],
} satisfies Config;
