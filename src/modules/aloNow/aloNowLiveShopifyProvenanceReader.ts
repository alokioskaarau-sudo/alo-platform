/**
 * Internal authenticated Shopify Admin provenance reader.
 * Read-only. Does not authorize payment or delivery.
 */
import {
  readAloNowShopifyProvenanceGraphQL
} from "../../integrations/shopify/orders.js";
import {
  createAloNowShopifyProvenanceReader
} from "./aloNowShopifyProvenanceReader.js";

export const readAloNowLiveShopifyProvenance =
  createAloNowShopifyProvenanceReader(
    readAloNowShopifyProvenanceGraphQL
  );
