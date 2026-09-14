import { validateSwissPostAddress } from "../../integrations/swisspost/address.js";

type ShopifyShippingAddress = {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
  countryCodeV2?: string | null;
};

export function splitSwissStreetAddress(address1: string) {
  const cleaned = address1.trim().replace(/\s+/g, " ");

  const match = cleaned.match(
    /^(.+?)\s+(\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?)$/
  );

  if (!match) {
    throw new Error(
      `Hausnummer konnte aus Adresse nicht erkannt werden: ${address1}`
    );
  }

  return {
    street: match[1].trim(),
    houseNumber: match[2].trim(),
  };
}

export async function validateShopifyShippingAddress(
  address: ShopifyShippingAddress
) {
  if (!address.firstName) {
    throw new Error("Vorname fehlt in Shopify.");
  }

  if (!address.lastName) {
    throw new Error("Nachname fehlt in Shopify.");
  }

  if (!address.address1) {
    throw new Error("Strasse fehlt in Shopify.");
  }

  if (!address.zip) {
    throw new Error("PLZ fehlt in Shopify.");
  }

  if (!address.city) {
    throw new Error("Ort fehlt in Shopify.");
  }

  if (
    address.countryCodeV2 &&
    address.countryCodeV2.toUpperCase() !== "CH"
  ) {
    throw new Error(
      `Momentan sind nur Schweizer Adressen unterstützt. Land: ${address.countryCodeV2}`
    );
  }

  const address1 = address.address1.trim();
  const address2 = address.address2?.trim() ?? "";

  const address2IsHouseNumber =
    /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$/.test(address2);

  const streetAddress =
    address2IsHouseNumber
      ? `${address1} ${address2}`
      : address1;

  const { street, houseNumber } =
    splitSwissStreetAddress(streetAddress);

  const result = await validateSwissPostAddress({
    firstName: address.firstName,
    lastName: address.lastName,
    street,
    houseNumber,
    zip: address.zip,
    city: address.city,
  });

  return {
    input: {
      firstName: address.firstName,
      lastName: address.lastName,
      street,
      houseNumber,
      zip: address.zip,
      city: address.city,
    },

    swissPost: result,
  };
}
