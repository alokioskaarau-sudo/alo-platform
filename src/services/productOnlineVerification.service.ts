import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const nullableString = {
  type: ["string", "null"],
} as const;

const verificationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "evidence"],
  properties: {
    status: {
      type: "string",
      enum: [
        "confirmed",
        "not_confirmed",
        "unknown",
      ],
    },
    evidence: {
      type: ["string", "null"],
    },
  },
} as const;

const productSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "brand",
    "productName",
    "flavor",
    "barcode",
    "unitSize",
    "netWeight",
    "country",
    "manufacturer",
    "category",
    "subcategory",
    "shortDescription",
    "descriptionHtml",
    "ingredients",
    "allergens",
    "traces",
    "nutritionPer100",
    "servingSize",
    "servingRecommendation",
    "dietary",
    "caffeine",
    "tags",
    "searchKeywords",
    "seoTitle",
    "seoDescription",
    "vendor",
    "productType",
    "confidence",
    "fieldConfidence",
    "warnings",
  ],
  properties: {
    title: { type: "string" },
    brand: nullableString,
    productName: nullableString,
    flavor: nullableString,
    barcode: nullableString,
    unitSize: nullableString,
    netWeight: nullableString,
    country: nullableString,
    manufacturer: nullableString,
    category: nullableString,
    subcategory: nullableString,
    shortDescription: nullableString,
    descriptionHtml: nullableString,
    ingredients: nullableString,
    allergens: {
      type: "array",
      items: { type: "string" },
    },
    traces: {
      type: "array",
      items: { type: "string" },
    },
    nutritionPer100: {
      type: "object",
      additionalProperties: false,
      required: [
        "basis",
        "energyKj",
        "energyKcal",
        "fat",
        "saturatedFat",
        "carbohydrates",
        "sugars",
        "protein",
        "fiber",
        "salt",
      ],
      properties: {
        basis: nullableString,
        energyKj: nullableString,
        energyKcal: nullableString,
        fat: nullableString,
        saturatedFat: nullableString,
        carbohydrates: nullableString,
        sugars: nullableString,
        protein: nullableString,
        fiber: nullableString,
        salt: nullableString,
      },
    },
    servingSize: nullableString,
    servingRecommendation: nullableString,
    dietary: {
      type: "object",
      additionalProperties: false,
      required: [
        "vegan",
        "vegetarian",
        "halal",
        "kosher",
        "glutenFree",
        "lactoseFree",
      ],
      properties: {
        vegan: verificationSchema,
        vegetarian: verificationSchema,
        halal: verificationSchema,
        kosher: verificationSchema,
        glutenFree: verificationSchema,
        lactoseFree: verificationSchema,
      },
    },
    caffeine: {
      type: "object",
      additionalProperties: false,
      required: [
        "containsCaffeine",
        "amount",
      ],
      properties: {
        containsCaffeine: {
          type: "string",
          enum: [
            "confirmed",
            "not_confirmed",
            "unknown",
          ],
        },
        amount: nullableString,
      },
    },
    tags: {
      type: "array",
      items: { type: "string" },
    },
    searchKeywords: {
      type: "array",
      items: { type: "string" },
    },
    seoTitle: nullableString,
    seoDescription: nullableString,
    vendor: nullableString,
    productType: nullableString,
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    fieldConfidence: {
      type: "object",
      additionalProperties: false,
      required: [
        "identity",
        "foodData",
        "nutrition",
        "dietary",
        "shopContent",
      ],
      properties: {
        identity: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        foodData: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        nutrition: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        dietary: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        shopContent: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

const onlineVerificationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "identityStatus",
    "verifiedDraft",
    "sources",
    "conflicts",
    "summary",
  ],
  properties: {
    identityStatus: {
      type: "string",
      enum: [
        "confirmed",
        "probable",
        "not_confirmed",
      ],
    },
    verifiedDraft: productSchema,
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "url",
          "sourceType",
        ],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          sourceType: {
            type: "string",
            enum: [
              "manufacturer",
              "official",
              "retailer",
              "database",
              "other",
            ],
          },
        },
      },
    },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "field",
          "currentValue",
          "onlineValue",
          "reason",
        ],
        properties: {
          field: { type: "string" },
          currentValue: {
            type: ["string", "null"],
          },
          onlineValue: {
            type: ["string", "null"],
          },
          reason: { type: "string" },
        },
      },
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: [
        "checkedFields",
        "foundFields",
        "conflictCount",
      ],
      properties: {
        checkedFields: { type: "number" },
        foundFields: { type: "number" },
        conflictCount: { type: "number" },
      },
    },
  },
} as const;

export type ProductOnlineVerificationResult = {
  identityStatus:
    | "confirmed"
    | "probable"
    | "not_confirmed";
  verifiedDraft: any;
  sources: Array<{
    title: string;
    url: string;
    sourceType:
      | "manufacturer"
      | "official"
      | "retailer"
      | "database"
      | "other";
  }>;
  conflicts: Array<{
    field: string;
    currentValue: string | null;
    onlineValue: string | null;
    reason: string;
  }>;
  summary: {
    checkedFields: number;
    foundFields: number;
    conflictCount: number;
  };
};

export async function verifyProductOnline(input: {
  draft?: any;
  barcode?: string | null;
}): Promise<ProductOnlineVerificationResult> {
  const currentDraft =
    input.draft &&
    typeof input.draft === "object"
      ? input.draft
      : {};

  const barcode =
    typeof input.barcode === "string"
      ? input.barcode.trim()
      : typeof currentDraft?.barcode === "string"
        ? currentDraft.barcode.trim()
        : "";

  const brand =
    typeof currentDraft?.brand === "string"
      ? currentDraft.brand.trim()
      : "";

  const title =
    typeof currentDraft?.title === "string"
      ? currentDraft.title.trim()
      : "";

  const unitSize =
    typeof currentDraft?.unitSize === "string"
      ? currentDraft.unitSize.trim()
      : "";

  if (!barcode && !title && !brand) {
    throw new Error(
      "Für den Online-Abgleich fehlen Barcode und Produktidentität."
    );
  }

  const response =
    await openai.responses.create({
      model: "gpt-5.6-terra",
      store: false,
      reasoning: {
        effort: "low",
      },
      tools: [
        {
          type: "web_search",
          search_context_size: "medium",
        },
      ],
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `
Du bist ALO VERIFY, das Online-Verifikationssystem
für einen Schweizer Snack-, Getränke- und
Süsswarenhandel.

Du erhältst einen bereits per Verpackungsfoto
erzeugten Product Draft.

DEINE AUFGABE:

1. Identifiziere zuerst exakt das Produkt.
2. Recherchiere aktuelle und belastbare
   Produktinformationen im Web.
3. Recherchiere systematisch in dieser Reihenfolge:

   A) SWEETS.CH
   - Suche zuerst gezielt nach dem exakten Produkt
     auf sweets.ch.
   - Suche nach Barcode/EAN sowie nach
     Marke + Produkt + Geschmack + Packungsgrösse.
   - Wenn dort die exakte Variante gefunden wird,
     nutze die Seite als wichtige Schweizer
     Handelsquelle.

   B) HERSTELLER / MARKE
   - Suche danach auf offiziellen Herstellerseiten,
     offiziellen Markenwebseiten und offiziellen
     Produktdatenquellen.
   - Diese Quellen haben für Rezeptur und
     Produktidentität hohe Priorität.

   C) SCHWEIZER QUELLEN
   - Seriöse Schweizer Händler und
     Produktdatenbanken ergänzend prüfen.
   - Bevorzuge Seiten, welche exakt dieselbe
     EAN, Variante und Packungsgrösse führen.

   D) INTERNATIONALE QUELLEN
   - Nur verwenden, wenn es nachweislich dieselbe
     Produkt- und Marktvariante ist.
   - US-, EU-, UK-, Japan- oder andere Varianten
     dürfen NICHT miteinander vermischt werden.

4. Verwende mehrere Quellen, wenn verfügbar.
   Übernimm Food Data nicht allein deshalb,
   weil irgendeine Seite einen passenden Namen hat.

5. Barcode/EAN ist das stärkste Identitätsmerkmal.

6. Zusätzlich müssen soweit verfügbar abgeglichen
   werden:
   - Marke
   - Produktname
   - Geschmack / Variante
   - Packungsgrösse
   - Verpackungsart
   - Markt-/Ländervariante

7. Eine Quelle darf für Food Data nur verwendet
   werden, wenn sie mit der identifizierten
   Produktvariante kompatibel ist.

8. Wenn Packungsgrösse, Variante, Marktversion
   oder Barcode widersprechen, darf die Quelle
   NICHT zur automatischen Befüllung verwendet
   werden.

9. Wenn mehrere belastbare Quellen vorhanden sind,
   vergleiche sie aktiv miteinander.

10. Bei Widersprüchen gilt:
    - sichtbare Originalverpackung ist die stärkste
      Quelle für genau das physisch gescannte Produkt
    - exakte EAN + exakte Variante + exakte Grösse
      haben Vorrang vor bloßer Namensähnlichkeit
    - offizielle Herstellerdaten haben Vorrang vor
      allgemeinen Händlertexten, sofern dieselbe
      Marktvariante gemeint ist
    - Konflikte müssen in conflicts gemeldet werden
    - widersprüchliche Food Data niemals raten oder
      zu einem Mischdatensatz kombinieren

WICHTIGE REGELN:

- Keine erfundenen Fakten.
- Zutaten nicht schätzen.
- Allergene nicht schätzen.
- Nährwerte nicht schätzen.
- Gewicht nicht aus Volumen berechnen.
- 355 ml darf niemals zu 355 g werden.
- netWeight nur bei echtem Gewicht in g/kg.
- unitSize darf Volumen oder Gewicht enthalten.
- HALAL/KOSHER niemals allein anhand Zutaten
  bestätigen.
- Wenn eine Information nicht sicher gefunden
  wird: null / unknown / leeres Array.
- Widersprüche zwischen aktuellem Draft und
  Onlinequelle in conflicts melden.
- Konflikte NICHT eigenmächtig auflösen.
- Bestehende Produktidentität nicht durch ein
  ähnlich klingendes Produkt ersetzen.

IDENTITY STATUS:

confirmed:
Barcode oder mehrere starke Merkmale stimmen
eindeutig überein.

probable:
Produkt scheint korrekt, aber eindeutige
Bestätigung fehlt.

not_confirmed:
Recherche deutet auf ein anderes Produkt,
andere Grösse oder andere Variante.

VERIFIED DRAFT:

Gib einen vollständigen Draft exakt nach dem
ALO Product Schema zurück.

Bereits vorhandene sichere Werte dürfen im
verifiedDraft wiederholt werden.

Neue Food-Daten nur eintragen, wenn sie durch
die gefundenen Quellen belastbar sind.

SPRACHE / ZUTATEN:

- ingredients im verifiedDraft immer auf Deutsch ausgeben.

- Wenn eine belastbare Zutatenliste nur auf Englisch
  oder in einer anderen Sprache verfügbar ist,
  vollständig und sinngenau ins Deutsche übersetzen.

- Den sachlichen Inhalt dabei niemals ergänzen,
  verkürzen oder verändern.

- E-Nummern, Prozentangaben, Mengenangaben,
  Zusatzstoffnummern und Klammerstrukturen erhalten.

- Marken- und Produktnamen nicht unnötig übersetzen.

- allergens auf Deutsch ausgeben.

- traces auf Deutsch ausgeben.

- Eine Übersetzung darf niemals verwendet werden,
  um fehlende Zutaten oder Allergene herzuleiten.

- Wenn für exakt diese Produktvariante keine
  belastbare Zutatenliste gefunden wird,
  ingredients null lassen.

- Fehlt ingredients im aktuellen Draft,
  gezielt nach Zutaten suchen.

- Dafür zuerst SWEETS.CH prüfen,
  danach Hersteller-/Markenquelle
  und anschließend weitere belastbare Quellen
  derselben Produktvariante.

Versuche für das exakt identifizierte Produkt
insbesondere vollständig zu ermitteln:

- ingredients
- allergens
- traces
- nutritionPer100.basis
- nutritionPer100.energyKj
- nutritionPer100.energyKcal
- nutritionPer100.fat
- nutritionPer100.saturatedFat
- nutritionPer100.carbohydrates
- nutritionPer100.sugars
- nutritionPer100.protein
- nutritionPer100.fiber
- nutritionPer100.salt
- servingSize
- country
- manufacturer
- unitSize
- netWeight
- flavor
- category
- subcategory

Prüfe jedes dieser Felder einzeln.

Fehlt ein einzelner Nährwert online, lasse genau
dieses Feld null, statt andere Nährwerte zu
verwerfen oder einen Wert zu schätzen.

Allergene nur übernehmen, wenn sie explizit aus
Verpackung oder belastbarer Quelle hervorgehen.

traces ausschließlich bei expliziten
May-contain-/Kann-Spuren-enthalten-Angaben.

Zutatenlisten unterschiedlicher Länder- oder
Packungsvarianten niemals miteinander mischen.

QUELLEN:

Gib die wichtigsten tatsächlich verwendeten
Webquellen zurück.

CONFLICTS:

Melde insbesondere Konflikte bei:
- Barcode
- Produktvariante
- Geschmack
- unitSize
- netWeight
- Zutaten
- Allergenen
- Nährwerten
- Herkunft

SEO und Beschreibung dürfen nur auf der
verifizierten Produktidentität beruhen.
`,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `
ALO CURRENT PRODUCT DRAFT:

${JSON.stringify(
  currentDraft,
  null,
  2
)}

IDENTITY HINTS:

Barcode: ${barcode || "unbekannt"}
Marke: ${brand || "unbekannt"}
Titel: ${title || "unbekannt"}
Inhalt: ${unitSize || "unbekannt"}

Führe jetzt den Online-Abgleich durch.
`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name:
            "alo_product_online_verification",
          strict: true,
          schema:
            onlineVerificationSchema,
        },
      },
    });

  const raw = response.output_text;

  if (!raw) {
    throw new Error(
      "ALO Verify hat kein Ergebnis geliefert."
    );
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      "ALO Verify Ergebnis konnte nicht gelesen werden."
    );
  }
}
