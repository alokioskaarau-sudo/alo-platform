/**
 * ALO_NOW_WORKSPACE_GUARD_V1
 * Temporary, intentionally conservative pilot mapping, NOT a complete
 * delivery-zone or street-level address validation.
 * This must not be used as customer-facing eligibility or quoted ETA.
 */
export type AloNowPilotWorkspace = "AARAU" | "OLTEN";

export function getAloNowWorkspaceFromOrder(order: {
  shippingAddress?: {
    zip?: string | null;
    city?: string | null;
    countryCodeV2?: string | null;
    countryCode?: string | null;
  } | null;
}): AloNowPilotWorkspace | null {
  const address = order?.shippingAddress;
  if (!address) return null;
  const country = String(address.countryCodeV2 ?? address.countryCode ?? "CH").trim().toUpperCase();
  if (country !== "CH") return null;
  const zip = String(address.zip ?? "").trim().toUpperCase().replace(/^CH[-\s]*/, "");
  const city = String(address.city ?? "").trim().toLocaleLowerCase("de-CH").replace(/\s+/g, " ");
  if (zip === "5000" && city === "aarau") return "AARAU";
  if (zip === "4600" && city === "olten") return "OLTEN";
  return null;
}
