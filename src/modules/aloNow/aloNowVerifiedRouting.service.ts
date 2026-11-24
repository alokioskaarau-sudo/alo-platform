/** ALO NOW verified delivery quote V2.
 * Official Swiss GeoAdmin address search; OpenRouteService driving-car routing.
 * Server-side ONLY. No route, credentials or ambiguous address => NO quote.
 * A quote response is informational, NOT an order reservation or checkout permission.
 */
import { calculateAloNowDeliveryQuote } from "./aloNowDeliveryQuote.service.js";

type Workspace = "AARAU" | "OLTEN";
type Coordinates = [number, number]; // [longitude, latitude]
const GEOCODE_URL = "https://api3.geo.admin.ch/rest/services/ech/SearchServer";
const ROUTE_URL = "https://api.heigit.org/openrouteservice/v2/directions/driving-car";

function parseOrigin(workspace: Workspace): Coordinates | null {
  const raw = process.env[`ALO_NOW_${workspace}_ORIGIN_LON_LAT`];
  if (!raw) return null;
  const parts = raw.split(",").map(s => Number(s.trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  const [lon, lat] = parts;
  if (lon < 5.8 || lon > 10.6 || lat < 45.6 || lat > 47.9) return null;
  return [lon, lat];
}

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`UPSTREAM_${response.status}`);
  return await response.json();
}

// V3630: Require one exact Swiss street-address match.
// Similar house numbers must never be treated as equal.
async function resolveSwissStreetAddress(
  address: string
): Promise<Coordinates | null> {
  const match = address.trim().match(
    /^(.+?)\s*,\s*([1-9][0-9]{3})\s+(.+)$/
  );

  if (!match) return null;

  const streetAddress = match[1].trim();
  const zip = match[2];
  const town = match[3].trim();

  if (
    !/^.+\s+[0-9]+[a-z]?(?:\.[0-9]+)?$/i.test(streetAddress)
    || !town
  ) return null;

  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase("de-CH")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const expected = normalize(
    `${streetAddress} ${zip} ${town}`
  );

  const url = new URL(GEOCODE_URL);
  url.searchParams.set("type", "locations");
  url.searchParams.set("origins", "address");
  url.searchParams.set("searchText", address.slice(0, 160));
  url.searchParams.set("limit", "10");
  url.searchParams.set("sr", "4326");

  const payload = await getJson(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" }
  }) as {
    results?: Array<{
      attrs?: {
        lon?: number;
        lat?: number;
        label?: string;
        origin?: string;
      };
    }>;
  };

  const candidates = (payload.results ?? []).filter(item => {
    const a = item.attrs;

    if (
      a?.origin !== "address" ||
      typeof a.lon !== "number" ||
      !Number.isFinite(a.lon) ||
      typeof a.lat !== "number" ||
      !Number.isFinite(a.lat)
    ) return false;

    const label = normalize(String(a.label ?? ""));

    // Allow only an optional two-letter canton suffix.
    const exact =
      label === expected ||
      (
        label.startsWith(expected + " ") &&
        /^[a-z]{2}$/.test(
          label.slice(expected.length + 1)
        )
      );

    return exact;
  });

  // Ambiguous or missing addresses remain blocked.
  if (candidates.length !== 1) return null;

  return [
    candidates[0].attrs!.lon!,
    candidates[0].attrs!.lat!
  ];
}

async function getDrivingKm(origin: Coordinates, target: Coordinates, apiKey: string): Promise<number | null> {
  const result = await getJson(ROUTE_URL, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ coordinates: [origin, target], instructions: false }),
  }) as { routes?: Array<{ summary?: { distance?: number } }> };
  const metres = result.routes?.[0]?.summary?.distance;
  return typeof metres === "number" && Number.isFinite(metres) && metres >= 0 ? metres / 1000 : null;
}

export async function getVerifiedAloNowQuote(address: string, workspace: Workspace) {
  const origin = parseOrigin(workspace);
  const key = process.env.ALO_NOW_ORS_API_KEY;
  if (!origin || !key) return {
    ok: true, status: "ROUTING_NOT_CONFIGURED", checkoutAllowed: false,
    manualReviewRequired: true, deliveryFeeCHF: null, roadDistanceKm: null,
    message: "Lieferstreckenprüfung wird eingerichtet. Noch keine verbindliche Lieferzusage."
  };
  try {
    const target = await resolveSwissStreetAddress(address);
    if (!target) return {
      ok: true, status: "ADDRESS_UNVERIFIED", checkoutAllowed: false,
      manualReviewRequired: true, deliveryFeeCHF: null, roadDistanceKm: null,
      message: "Adresse nicht eindeutig gefunden. Bitte Strasse, Hausnummer, PLZ und Ort prüfen."
    };
    const km = await getDrivingKm(origin, target, key);
    const result = calculateAloNowDeliveryQuote(km);
    if (result.status === "STANDARD") return {
      ok: true, status: "STANDARD", checkoutAllowed: false,
      manualReviewRequired: false, deliveryFeeCHF: result.deliveryFeeCHF,
      roadDistanceKm: Number(result.distanceKm.toFixed(2)),
      message: "Lieferzone geprüft: CHF 9.90 Liefergebühr. Eine Bestellung ist hier noch nicht möglich."
    };
    if (result.status === "MANUAL_APPROVAL") return {
      ok: true, status: "MANUAL_APPROVAL", checkoutAllowed: false,
      manualReviewRequired: true, deliveryFeeCHF: null,
      roadDistanceKm: Number(result.distanceKm.toFixed(2)),
      message: "Über 12 km Fahrstrecke: individuelles Angebot nach Admin-Freigabe erforderlich."
    };
    return { ok: true, status: "ROUTE_UNVERIFIED", checkoutAllowed: false,
      manualReviewRequired: true, deliveryFeeCHF: null, roadDistanceKm: null,
      message: "Fahrstrecke nicht berechenbar. Keine Lieferzusage." };
  } catch (error) {
    console.error("ALO_NOW_VERIFIED_ROUTE_PROVIDER_ERROR", error);
    return { ok: true, status: "ROUTE_UNAVAILABLE", checkoutAllowed: false,
      manualReviewRequired: true, deliveryFeeCHF: null, roadDistanceKm: null,
      message: "Routenprüfung momentan nicht verfügbar. Bitte später erneut versuchen." };
  }
}
