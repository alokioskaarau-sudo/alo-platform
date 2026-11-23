/**
 * ALO NOW V2979
 * Structured Swiss delivery contact.
 *
 * No database writes, payment operations or
 * Shopify requests.
 */

export type AloNowDeliveryContact = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address1: string;
  address2: string;
  zip: string;
  city: string;
  countryCode: "CH";
};

export class AloNowDeliveryContactError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AloNowDeliveryContactError";
  }
}

function fail(code: string): never {
  throw new AloNowDeliveryContactError(code);
}

function object(
  value: unknown
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) fail("INVALID_DELIVERY_CONTACT");

  return value as Record<string, unknown>;
}

function field(
  source: Record<string, unknown>,
  name: string,
  max: number,
  required = true
): string {
  const raw = source[name];

  if (
    raw === undefined ||
    raw === null ||
    (!required && raw === "")
  ) {
    if (!required) return "";
    fail("MISSING_DELIVERY_" + name.toUpperCase());
  }

  if (typeof raw !== "string")
    fail("INVALID_DELIVERY_" + name.toUpperCase());

  const value = raw.trim().replace(/\s+/g, " ");

  if (
    (required && !value) ||
    value.length > max ||
    /[\x00-\x1F\x7F]/.test(value)
  ) fail("INVALID_DELIVERY_" + name.toUpperCase());

  return value;
}

export function validateAloNowDeliveryContact(
  input: unknown
): AloNowDeliveryContact {
  const data = object(input);

  const allowed = new Set([
    "firstName",
    "lastName",
    "email",
    "phone",
    "address1",
    "address2",
    "zip",
    "city",
    "countryCode"
  ]);

  if (Object.keys(data).some(key => !allowed.has(key)))
    fail("UNKNOWN_DELIVERY_FIELDS");

  const firstName = field(data, "firstName", 60);
  const lastName = field(data, "lastName", 60);

  const email = field(data, "email", 254).toLowerCase();

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) fail("INVALID_DELIVERY_EMAIL");

  const rawPhone = field(data, "phone", 35);
  const compactPhone = rawPhone.replace(/[\s().-]/g, "");

  if (
    !/^(?:\+41|0041|0)[1-9]\d{8}$/.test(compactPhone)
  ) fail("INVALID_DELIVERY_PHONE");

  const phone = compactPhone.startsWith("0041")
    ? "+" + compactPhone.slice(2)
    : compactPhone.startsWith("0")
      ? "+41" + compactPhone.slice(1)
      : compactPhone;

  const address1 = field(data, "address1", 120);
  const address2 = field(data, "address2", 120, false);
  const zip = field(data, "zip", 4);
  const city = field(data, "city", 80);
  const countryCode = field(data, "countryCode", 2);

  if (!/^[1-9]\d{3}$/.test(zip))
    fail("INVALID_SWISS_POSTCODE");

  if (countryCode !== "CH")
    fail("SWISS_DELIVERY_ONLY");

  if (!/\d+[a-zA-Z]?\b/.test(address1))
    fail("HOUSE_NUMBER_REQUIRED");

  return {
    firstName,
    lastName,
    email,
    phone,
    address1,
    address2,
    zip,
    city,
    countryCode: "CH"
  };
}

export function formatAloNowDeliveryAddress(
  contact: AloNowDeliveryContact
): string {
  const address = [
    contact.address1,
    contact.zip,
    contact.city
  ];

  return `${address[0]}, ${address[1]} ${address[2]}`;
}
