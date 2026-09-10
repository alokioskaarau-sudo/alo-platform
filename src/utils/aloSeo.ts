const ALO_SEO_SUFFIX =
  " | ALO Kiosk Schweiz";

function cleanSeoBase(
  value: unknown
): string {
  let text =
    typeof value === "string"
      ? value.trim()
      : "";

  /*
   * Alte / abweichende ALO-Suffixe entfernen,
   * damit niemals doppelte Endungen entstehen.
   */
  const suffixPattern =
    /\s*(?:\||-|–|—)?\s*ALO\s*Kiosk(?:\s+Schweiz)?\s*$/i;

  while (
    text &&
    suffixPattern.test(text)
  ) {
    text =
      text.replace(
        suffixPattern,
        ""
      ).trim();
  }

  return text;
}

export function normalizeAloSeoTitle(
  value: unknown,
  fallbackTitle: unknown
): string {
  const preferred =
    cleanSeoBase(value);

  const fallback =
    cleanSeoBase(
      fallbackTitle
    );

  const base =
    preferred ||
    fallback ||
    "ALO Kiosk";

  return `${base}${ALO_SEO_SUFFIX}`;
}

export function normalizeAloSeoDescription(
  value: unknown,
  fallbackTitle: unknown
): string {
  const existing =
    typeof value === "string"
      ? value.trim()
      : "";

  if (existing) {
    return existing;
  }

  const productTitle =
    cleanSeoBase(
      fallbackTitle
    ) || "Produkt";

  return `Entdecke ${productTitle} jetzt online bei ALO Kiosk Schweiz und bestelle bequem in der Schweiz.`;
}
