/**
 * ALO NOW payment evidence reader using the existing
 * authenticated Shopify Admin GraphQL transport.
 *
 * Internal server use only.
 * Does not create orders, charge money or dispatch drivers.
 */
import {
  readAloNowShopifyPaymentGraphQL
} from "../../integrations/shopify/orders.js";
import {
  createAloNowShopifyAdminPaymentReader
} from "./aloNowShopifyAdminPaymentReader.js";

export const readAloNowLiveShopifyPayment =
  createAloNowShopifyAdminPaymentReader(
    readAloNowShopifyPaymentGraphQL
  );
