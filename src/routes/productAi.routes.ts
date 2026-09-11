import { Router } from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: 2,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
    ]);

    if (!allowed.has(file.mimetype)) {
      cb(
        new Error(
          `Nicht unterstütztes Bildformat: ${file.mimetype}`
        )
      );
      return;
    }

    cb(null, true);
  },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const nullableString = {
  type: ['string', 'null'],
} as const;

const verificationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'evidence'],
  properties: {
    status: {
      type: 'string',
      enum: ['confirmed', 'not_confirmed', 'unknown'],
    },
    evidence: {
      type: ['string', 'null'],
    },
  },
} as const;

const productSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'brand',
    'productName',
    'flavor',
    'barcode',
    'unitSize',
    'netWeight',
    'country',
    'manufacturer',
    'category',
    'subcategory',
    'shortDescription',
    'descriptionHtml',
    'ingredients',
    'allergens',
    'traces',
    'nutritionPer100',
    'servingSize',
        'servingRecommendation',

'dietary',
    'caffeine',
    'tags',
    'searchKeywords',
    'seoTitle',
    'seoDescription',
    'vendor',
    'productType',
    'confidence',
    'fieldConfidence',
    'warnings',
  ],
  properties: {
    title: { type: 'string' },
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
      type: 'array',
      items: { type: 'string' },
    },

    traces: {
      type: 'array',
      items: { type: 'string' },
    },

    nutritionPer100: {
      type: 'object',
      additionalProperties: false,
      required: [
        'basis',
        'energyKj',
        'energyKcal',
        'fat',
        'saturatedFat',
        'carbohydrates',
        'sugars',
        'protein',
                'fiber',

        'salt',
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
      type: 'object',
      additionalProperties: false,
      required: [
        'vegan',
        'vegetarian',
        'halal',
        'kosher',
        'glutenFree',
        'lactoseFree',
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
      type: 'object',
      additionalProperties: false,
      required: [
        'containsCaffeine',
        'amount',
      ],
      properties: {
        containsCaffeine: {
          type: 'string',
          enum: ['confirmed', 'not_confirmed', 'unknown'],
        },
        amount: nullableString,
      },
    },

    tags: {
      type: 'array',
      items: { type: 'string' },
    },

    searchKeywords: {
      type: 'array',
      items: { type: 'string' },
    },

    seoTitle: nullableString,
    seoDescription: nullableString,

    vendor: nullableString,
    productType: nullableString,

    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },

    fieldConfidence: {
      type: 'object',
      additionalProperties: false,
      required: [
        'identity',
        'foodData',
        'nutrition',
        'dietary',
        'shopContent',
      ],
      properties: {
        identity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        foodData: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        nutrition: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        dietary: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        shopContent: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
      },
    },

    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

router.post(
  '/product-scan',
  upload.fields([
    {
      name: 'front',
      maxCount: 1,
    },
    {
      name: 'back',
      maxCount: 1,
    },
  ]),
  async (req, res) => {
    let frontFileId:
      | string
      | null = null;

    let backFileId:
      | string
      | null = null;

    try {
      if (
        !process.env.OPENAI_API_KEY
      ) {
        res.status(500).json({
          ok: false,
          error:
            'OPENAI_API_KEY fehlt auf ALO CORE.',
        });
        return;
      }

      const files =
        req.files as
          | {
              [
                fieldname: string
              ]:
                | Express.Multer.File[]
                | undefined;
            }
          | undefined;

      const front =
        files?.front?.[0];

      const back =
        files?.back?.[0];

      if (!front) {
        res.status(400).json({
          ok: false,
          error:
            'Vorderseiten-Foto fehlt.',
        });
        return;
      }

      const barcode =
        typeof req.body?.barcode ===
        'string'
          ? req.body.barcode.trim()
          : '';

      const uploadedFront =
        await openai.files.create({
          file: await toFile(
            front.buffer,
            front.originalname ||
              'product-front.jpg',
            {
              type:
                front.mimetype,
            }
          ),
          purpose:
            'user_data',
        });

      frontFileId =
        uploadedFront.id;

      if (back) {
        const uploadedBack =
          await openai.files.create({
            file: await toFile(
              back.buffer,
              back.originalname ||
                'product-back.jpg',
              {
                type:
                  back.mimetype,
              }
            ),
            purpose:
              'user_data',
          });

        backFileId =
          uploadedBack.id;
      }

      const content: any[] = [
        {
          type: 'input_text',
          text: `
Du bist ALO PRODUCT INTELLIGENCE für den Schweizer ALO KIOSK Online Shop.

Analysiere die fotografierte Originalverpackung und erstelle einen hochwertigen, strukturierten Product Master Draft.

BARCODE VOM SCANNER:
${barcode || 'Keiner übergeben'}

PRIORITÄT DER INFORMATIONEN:

1. Sichtbare Originalverpackung ist die primäre Faktenquelle.
2. Ein vom ALO Scanner übergebener Barcode hat Vorrang vor einem unsicher gelesenen Barcode.
3. Markenname, Produktname, Geschmack, Größe und Herkunft exakt erfassen.
4. Zutaten, Allergene, Spuren und Nährwerte niemals erfinden.
5. Shop-Content und SEO dürfen aus bestätigten Produktfakten optimiert formuliert werden.

TITEL:
- MUSS IN GROSSBUCHSTABEN sein.
- Sauber, kompakt und konsistent.
- Bevorzugtes Muster:
  MARKE + PRODUKT + GESCHMACK + GRÖSSE
- Keine unnötigen Werbewörter.
- Keine erfundenen Eigenschaften.

KATEGORISIERUNG:
Wähle die fachlich passendste Kategorie und Unterkategorie für ALO.
Mögliche Hauptbereiche:
Drinks
Snacks
Sweets
Chocolate
Cookies
Riegel

Bei Drinks z. B.:
Softdrinks
Energy Drinks
Limonade
Eistee
Wasser

FOOD DATA:
- ingredients möglichst originalgetreu von der Verpackung.
- allergens als einzelne strukturierte Allergene.
- traces nur bei expliziten Spuren-/May-contain-Angaben.
- Keine Allergene aus allgemeinem Wissen ergänzen.
- Ist Text nicht zuverlässig lesbar, Feld leer/null lassen und warning erzeugen.

NÄHRWERTE:
Extrahiere wenn sichtbar:
- Basis, bevorzugt pro 100 g oder 100 ml
- Energie kJ
- Energie kcal
- Fett
- davon gesättigte Fettsäuren
- Kohlenhydrate
- davon Zucker
- Eiweiß/Protein

- Nahrungsfasern/Ballaststoffe

- Salz

Werte als Text inklusive Einheit erhalten.
Niemals Werte umrechnen oder schätzen, wenn die Grundlage nicht eindeutig ist.


SERVIEREMPFEHLUNG:

- servingSize nur übernehmen, wenn eine Portionsgröße eindeutig angegeben ist.
- servingRecommendation kurz und sinnvoll formulieren, aber nur aus sicheren Produktfakten.
- Keine erfundenen Zubereitungs- oder Konsumhinweise.

ERNÄHRUNGSMERKMALE:
Für vegan, vegetarian, halal, kosher, glutenFree und lactoseFree gibt es ausschließlich:
confirmed
not_confirmed
unknown

confirmed nur bei eindeutiger Evidenz.
not_confirmed nur wenn eindeutig gegenteilige Evidenz vorhanden ist.
Ansonsten unknown.

Besonders HALAL und KOSHER niemals allein aus einer Zutatenliste behaupten.
evidence erklärt kurz die konkrete Grundlage.

KOFFEIN:
Nur bestätigen, wenn auf Verpackung eindeutig erkennbar.
Menge nur übernehmen, wenn tatsächlich angegeben.

SHOP CONTENT:
Erstelle eine natürliche deutsche Kurzbeschreibung und eine Shopify-taugliche HTML-Beschreibung.
Der Text soll nach ALO KIOSK klingen: modern, direkt und verkaufsstark, aber nicht künstlich oder unseriös.
Keine medizinischen Aussagen.
Keine erfundenen Geschmacks- oder Produkteigenschaften.

SEO:
Erstelle intern:
- seoTitle
- seoDescription
- searchKeywords

SEO für Schweizer Suchintention optimieren.
Marke, genauer Produktname, Geschmack, Größe und relevante Begriffe berücksichtigen.
'Schweiz' und 'online bestellen' nur natürlich verwenden.
Kein Keyword-Stuffing.
SEO-Daten sind Backend-/Shopify-Daten und müssen nicht Teil der sichtbaren Produktbeschreibung sein.

TAGS:
Sachliche Tags aus Marke, Produkttyp, Geschmack, Herkunft, Kategorie und relevanten Eigenschaften.

SHOPIFY:
vendor normalerweise Markenname.
productType sinnvoll aus Kategorie/Unterkategorie ableiten.
Keine Veröffentlichung veranlassen. Es wird ausschließlich ein Draft vorbereitet.

CONFIDENCE:
Bewerte getrennt:
identity
foodData
nutrition
dietary
shopContent

WARNINGS:
Erzeuge konkrete Warnungen bei unleserlichen oder fehlenden Pflichtinformationen, widersprüchlichen Daten oder fehlender Rückseite.

Wenn Informationen nicht sicher bekannt sind, lieber null/unknown als raten.

Erfinde keine Fakten.
`,
        },

        {
          type:
            'input_image',
          file_id:
            frontFileId,
          detail: 'high',
        },
      ];

      if (backFileId) {
        content.push({
          type:
            'input_image',
          file_id:
            backFileId,
          detail: 'high',
        });
      }

      const response =
        await openai.responses.create({
          model:
            'gpt-5.6-terra',

          store: false,

          reasoning: {
            effort: 'low',
          },

          input: [
            {
              role: 'developer',
              content: [
                {
                  type: 'input_text',
                  text: `Du bist der ALO Product Intelligence Scanner für einen Schweizer Snack-, Süsswaren- und Getränkehandel.

Analysiere ausschliesslich die bereitgestellten Produktbilder.

MARKE / BRAND:
- brand ist die echte, für Kunden sichtbare Produktmarke auf der Verpackung.
- Beispiele: HEYYY, Arizona, Fanta, Takis, Coca-Cola, Warheads.
- Verwende NICHT ALO Kiosk als brand, nur weil ALO Kiosk Händler oder Verkäufer ist.
- Händler, Shop, Importeur, Distributor und Hersteller sind nicht automatisch die Marke.
- Wenn HEYYY deutlich als Markenlogo auf der Verpackung steht, muss brand "HEYYY" sein.
- Wenn die Marke auf dem Bild nicht zuverlässig erkennbar ist, setze brand auf null.
- Erfinde niemals eine Marke.
- vendor ist getrennt von brand. Setze vendor nur, wenn ein tatsächlicher Vendor/Hersteller aus der Verpackung zuverlässig hervorgeht; sonst null.
- manufacturer ist ebenfalls getrennt von brand und nur ausfüllen, wenn ausdrücklich erkennbar.

PRODUKTDATEN:
- Lies Produktname, Geschmacksrichtung, Inhalt, EAN, Herkunft, Zutaten, Allergene und Nährwerte möglichst direkt von der Verpackung.
- unitSize ist der kunden sichtbare Inhalt, z. B. "355 ml" oder "68 g".
- netWeight ist ausschließlich ein zuverlässig angegebenes Produktgewicht in g oder kg.
- Bei einem klar deklarierten Gewicht wie "68 g" darf netWeight "68 g" sein.
- Volumen niemals in Gewicht umrechnen. Aus "355 ml" darf nicht "355 g" entstehen.
- Wenn kein echtes Gewicht zuverlässig sichtbar oder angegeben ist, setze netWeight auf null.
- Zutaten, Allergene, Spuren und Nährwerte niemals erraten.
- Nicht sichtbare oder nicht sicher lesbare Lebensmittelangaben bleiben null bzw. leere Arrays.
- title soll ein sauberer verkaufsfähiger Produkttitel sein und wird später automatisch grossgeschrieben.
- productName darf intern ausgefüllt werden, soll aber nicht künstlich den Markennamen duplizieren.
- country bedeutet Herkunft des Produkts, nicht Sitz des Händlers.
- confidence und fieldConfidence müssen Unsicherheit realistisch widerspiegeln.

Das Ergebnis muss exakt dem vorgegebenen JSON-Schema entsprechen.`,
                },
              ],
            },
            {
              role: 'user',
              content,
            },
          ],

          text: {
            format: {
              type:
                'json_schema',
              name:
                'alo_product_scan',
              strict: true,
              schema:
                productSchema,
            },
          },
        });

      const raw =
        response.output_text;

      if (!raw) {
        throw new Error(
          'OpenAI hat keinen Produkt-Draft geliefert.'
        );
      }

      let draft: any;

      try {
        draft =
          JSON.parse(raw);
      } catch {
        throw new Error(
          'Produkt-Draft konnte nicht gelesen werden.'
        );
      }

      if (
        barcode &&
        !draft.barcode
      ) {
        draft.barcode =
          barcode;
      }

      if (
        typeof draft.title ===
        'string'
      ) {
        draft.title =
          draft.title
            .trim()
            .toUpperCase();
      }

      res.json({
        ok: true,
        draft,
      });
    } catch (error) {
      console.error(
        '[ALO AI PRODUCT SCAN]',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Produktanalyse fehlgeschlagen.',
      });
    } finally {
      if (frontFileId) {
        try {
          await openai.files.delete(
            frontFileId
          );
        } catch {}
      }

      if (backFileId) {
        try {
          await openai.files.delete(
            backFileId
          );
        } catch {}
      }
    }
  }
);


router.post(
  "/product-verify-online",
  async (req, res) => {
    try {
      const currentDraft =
        req.body?.draft &&
        typeof req.body.draft === "object"
          ? req.body.draft
          : {};

      const barcode =
        typeof req.body?.barcode === "string"
          ? req.body.barcode.trim()
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

      console.log(
        "[ALO VERIFY REQUEST RECEIVED]",
        {
          hasBody: Boolean(req.body),
          hasDraft: Boolean(req.body?.draft),
          barcode: barcode || null,
          draftBarcode:
            typeof currentDraft?.barcode === "string"
              ? currentDraft.barcode
              : null,
          brand: brand || null,
          title: title || null,
          unitSize: unitSize || null,
        }
      );

      if (!barcode && !title && !brand) {
        res.status(400).json({
          ok: false,
          error:
            "Für den Online-Abgleich fehlen Barcode und Produktidentität.",
        });
        return;
      }

      /*
       * Schnelle Barcode-Daten werden NICHT mehr direkt
       * an die Staff App zurückgegeben.
       *
       * Sie dienen als zusätzliche Rohdaten für den
       * anschliessenden vollständigen ALO VERIFY Lauf.
       */
      let fastBarcodeDraft: any = null;
      let fastBarcodeFoundFields = 0;
      let fastBarcodeSource: any = null;

      /*
       * FAST FOOD DATA VERIFY
       *
       * Exakter Barcode zuerst direkt gegen Open Food Facts.
       * Dadurch bekommen wir Zutaten und Nährwerte häufig
       * innerhalb weniger Sekunden, ohne auf Web Search
       * warten zu müssen.
       *
       * Falls dort nichts Belastbares vorhanden ist,
       * läuft darunter der bestehende ALO Web Verify weiter.
       */
      if (barcode) {
        const offController =
          new AbortController();

        const offTimeout =
          setTimeout(
            () =>
              offController.abort(),
            8000
          );

        try {
          console.log(
            "[ALO VERIFY OFF START]",
            {
              barcode,
            }
          );

          const fields = [
            "code",
            "product_name",
            "product_name_de",
            "brands",
            "quantity",
            "countries",
            "countries_tags",
            "ingredients_text",
            "ingredients_text_de",
            "allergens",
            "allergens_tags",
            "traces",
            "traces_tags",
            "nutrition_data_per",
            "nutriments",
          ].join(",");

          const offResponse =
            await fetch(
              `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
                barcode
              )}.json?fields=${encodeURIComponent(
                fields
              )}`,
              {
                headers: {
                  "User-Agent":
                    "ALO-Kiosk/1.0",
                  Accept:
                    "application/json",
                },
                signal:
                  offController.signal,
              }
            );

          if (offResponse.ok) {
            const offPayload: any =
              await offResponse.json();

            const product =
              offPayload?.product;

            if (
              offPayload?.status === 1 &&
              product &&
              typeof product ===
                "object"
            ) {
              const nutriments =
                product.nutriments &&
                typeof product.nutriments ===
                  "object"
                  ? product.nutriments
                  : {};

              const asString = (
                value: unknown
              ) => {
                if (
                  typeof value ===
                  "string"
                ) {
                  const trimmed =
                    value.trim();

                  return trimmed ||
                    null;
                }

                if (
                  typeof value ===
                    "number" &&
                  Number.isFinite(value)
                ) {
                  return String(value);
                }

                return null;
              };

              const asNumber = (
                value: unknown
              ) => {
                if (
                  typeof value ===
                    "number" &&
                  Number.isFinite(value)
                ) {
                  return value;
                }

                if (
                  typeof value ===
                  "string"
                ) {
                  const parsed =
                    Number(
                      value.replace(
                        ",",
                        "."
                      )
                    );

                  return Number.isFinite(
                    parsed
                  )
                    ? parsed
                    : null;
                }

                return null;
              };

              const cleanTags = (
                value: unknown
              ): string[] => {
                if (
                  !Array.isArray(value)
                ) {
                  return [];
                }

                return value
                  .filter(
                    (
                      item
                    ): item is string =>
                      typeof item ===
                      "string"
                  )
                  .map((item) =>
                    item
                      .replace(
                        /^[a-z]{2}:/i,
                        ""
                      )
                      .replace(
                        /-/g,
                        " "
                      )
                      .trim()
                  )
                  .filter(Boolean);
              };

              const ingredients =
                asString(
                  product
                    .ingredients_text_de
                ) ||
                asString(
                  product
                    .ingredients_text
                );

              const allergens =
                cleanTags(
                  product.allergens_tags
                );

              const traces =
                cleanTags(
                  product.traces_tags
                );

              const energyKcal =
                asNumber(
                  nutriments[
                    "energy-kcal_100g"
                  ]
                );

              const energyKj =
                asNumber(
                  nutriments[
                    "energy-kj_100g"
                  ]
                );

              const fat =
                asNumber(
                  nutriments[
                    "fat_100g"
                  ]
                );

              const saturatedFat =
                asNumber(
                  nutriments[
                    "saturated-fat_100g"
                  ]
                );

              const carbohydrates =
                asNumber(
                  nutriments[
                    "carbohydrates_100g"
                  ]
                );

              const sugars =
                asNumber(
                  nutriments[
                    "sugars_100g"
                  ]
                );

              const protein =
                asNumber(
                  nutriments[
                    "proteins_100g"
                  ]
                );

              const fiber =
                asNumber(
                  nutriments[
                    "fiber_100g"
                  ]
                );

              const salt =
                asNumber(
                  nutriments[
                    "salt_100g"
                  ]
                );

              const nutritionValues =
                [
                  energyKcal,
                  energyKj,
                  fat,
                  saturatedFat,
                  carbohydrates,
                  sugars,
                  protein,
                  fiber,
                  salt,
                ];

              const nutritionFound =
                nutritionValues.filter(
                  (value) =>
                    value !== null
                ).length;

              const usefulFoodFields =
                [
                  Boolean(
                    ingredients
                  ),
                  allergens.length > 0,
                  traces.length > 0,
                  nutritionFound >= 4,
                ].filter(
                  Boolean
                ).length;

              console.log(
                "[ALO VERIFY OFF RESULT]",
                {
                  barcode,
                  productName:
                    product
                      .product_name_de ||
                    product
                      .product_name ||
                    null,
                  hasIngredients:
                    Boolean(
                      ingredients
                    ),
                  allergenCount:
                    allergens.length,
                  traceCount:
                    traces.length,
                  nutritionFound,
                }
              );

              /*
               * Nur direkt übernehmen, wenn
               * tatsächlich brauchbare Food Data
               * gefunden wurde.
               *
               * Exakter Barcode-Endpunkt = starke
               * Produktidentität.
               */
              if (
                usefulFoodFields > 0
              ) {
                const currentNutrition =
                  currentDraft
                    ?.nutritionPer100 &&
                  typeof currentDraft
                    .nutritionPer100 ===
                    "object"
                    ? currentDraft
                        .nutritionPer100
                    : {};

                const verifiedDraft = {
                  ...currentDraft,

                  barcode:
                    barcode ||
                    currentDraft
                      ?.barcode ||
                    null,

                  title:
                    asString(
                      product
                        .product_name_de
                    ) ||
                    asString(
                      product
                        .product_name
                    ) ||
                    currentDraft
                      ?.title ||
                    "",

                  brand:
                    asString(
                      product.brands
                    ) ||
                    currentDraft
                      ?.brand ||
                    null,

                  unitSize:
                    asString(
                      product.quantity
                    ) ||
                    currentDraft
                      ?.unitSize ||
                    null,

                  country:
                    asString(
                      product.countries
                    ) ||
                    currentDraft
                      ?.country ||
                    null,

                  ingredients:
                    ingredients ||
                    currentDraft
                      ?.ingredients ||
                    null,

                  allergens:
                    allergens.length
                      ? allergens
                      : Array.isArray(
                            currentDraft
                              ?.allergens
                          )
                        ? currentDraft
                            .allergens
                        : [],

                  traces:
                    traces.length
                      ? traces
                      : Array.isArray(
                            currentDraft
                              ?.traces
                          )
                        ? currentDraft
                            .traces
                        : [],

                  nutritionPer100: {
                    ...currentNutrition,

                    basis:
                      currentNutrition
                        ?.basis ||
                      product
                        .nutrition_data_per ||
                      "100g",

                    energyKj:
                      energyKj ??
                      currentNutrition
                        ?.energyKj ??
                      null,

                    energyKcal:
                      energyKcal ??
                      currentNutrition
                        ?.energyKcal ??
                      null,

                    fat:
                      fat ??
                      currentNutrition
                        ?.fat ??
                      null,

                    saturatedFat:
                      saturatedFat ??
                      currentNutrition
                        ?.saturatedFat ??
                      null,

                    carbohydrates:
                      carbohydrates ??
                      currentNutrition
                        ?.carbohydrates ??
                      null,

                    sugars:
                      sugars ??
                      currentNutrition
                        ?.sugars ??
                      null,

                    protein:
                      protein ??
                      currentNutrition
                        ?.protein ??
                      null,

                    fiber:
                      fiber ??
                      currentNutrition
                        ?.fiber ??
                      null,

                    salt:
                      salt ??
                      currentNutrition
                        ?.salt ??
                      null,
                  },
                };

                const foundFields =
                  [
                    ingredients,
                    allergens.length
                      ? allergens
                      : null,
                    traces.length
                      ? traces
                      : null,
                    ...nutritionValues,
                  ].filter(
                    (value) =>
                      value !== null &&
                      value !== ""
                  ).length;

                console.log(
                  "[ALO VERIFY OFF SUCCESS]",
                  {
                    barcode,
                    foundFields,
                  }
                );

                /*
                 * WICHTIG:
                 * Open Food Facts beendet ALO VERIFY hier
                 * NICHT mehr.
                 *
                 * Die Daten werden jetzt in den vollständigen
                 * Web-Abgleich mitgenommen. Dadurch können
                 * sweets.ch, Herstellerseiten, Schweizer
                 * Quellen sowie SEO weiterhin geprüft werden.
                 */
                fastBarcodeDraft =
                  verifiedDraft;

                fastBarcodeFoundFields =
                  foundFields;

                fastBarcodeSource = {
                  title:
                    "Open Food Facts",
                  url:
                    `https://world.openfoodfacts.org/product/${encodeURIComponent(
                      barcode
                    )}`,
                  sourceType:
                    "database",
                };

                console.log(
                  "[ALO VERIFY OFF CARRY FORWARD]",
                  {
                    barcode,
                    foundFields,
                  }
                );
              }
            }
          }
        } catch (error) {
          console.warn(
            "[ALO VERIFY OFF FALLBACK]",
            error instanceof Error
              ? error.message
              : error
          );
        } finally {
          clearTimeout(
            offTimeout
          );
        }
      }

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
                title: {
                  type: "string",
                },
                url: {
                  type: "string",
                },
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
                field: {
                  type: "string",
                },
                currentValue: {
                  type: ["string", "null"],
                },
                onlineValue: {
                  type: ["string", "null"],
                },
                reason: {
                  type: "string",
                },
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
              checkedFields: {
                type: "number",
              },
              foundFields: {
                type: "number",
              },
              conflictCount: {
                type: "number",
              },
            },
          },
        },
      } as const;

      const verifyStartedAt =
        Date.now();

      console.log(
        "[ALO VERIFY OPENAI START]",
        {
          barcode: barcode || null,
          title: title || null,
        }
      );

      const response: any =
        await Promise.race([
          openai.responses.create({
          model: "gpt-5.6-terra",
          store: false,

          reasoning: {
            effort: "low",
          },

          tools: [
            {
              type: "web_search",
              search_context_size:
                "medium",
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

ALO KIOSK SCHWEIZ – SHOP COPY UND SEO:

Wenn identityStatus "confirmed" ist, bearbeite zusätzlich
ALLE im Product Schema vorhandenen Shop-/SEO-Felder
vollständig und hochwertig.

Insbesondere:
- shortDescription
- descriptionHtml
- seoTitle
- seoDescription
- searchKeywords
- tags

REGELN FÜR ALO KIOSK:

1. ALO Kiosk ist der Shop und niemals die Produktmarke.
   "ALO Kiosk", "ALO Kiosk Schweiz" oder ähnliche Begriffe
   dürfen NIEMALS als brand oder manufacturer eingetragen
   werden.

2. brand muss die tatsächliche Produktmarke sein.
   Beispiel:
   ULTRAPOP Produkt -> brand "Ultrapop",
   nicht "Alo Kiosk".

3. Alle Kundentexte auf natürlichem, gut lesbarem Deutsch.

4. shortDescription:
   - kompakt
   - appetitlich / kaufstark
   - echte Produktmerkmale nennen
   - nichts erfinden

5. descriptionHtml:
   - eigenständige hochwertige Shopbeschreibung
   - für einen Schweizer Online-Shop
   - Produkt, Geschmack, Besonderheiten und Inhalt
     natürlich erklären
   - keine erfundenen Herkunfts-/Health-Claims
   - nicht einfach fremde Händlertexte kopieren

6. seoTitle:
   - stärkste reale Suchbegriffe verwenden
   - Marke + Produkt/Variante + relevante Grösse
   - Schweizer Kaufintention berücksichtigen
   - wenn sinnvoll mit
     "| ALO Kiosk Schweiz"
     abschliessen
   - kein Keyword-Spam
   - möglichst kompakt und suchmaschinenfreundlich

7. seoDescription:
   - natürliches Deutsch
   - Produkt und Geschmack konkret nennen
   - Kauf-/Bestellintention für die Schweiz
   - "ALO Kiosk Schweiz" sinnvoll integrieren
   - ungefähr 140 bis 160 Zeichen anstreben
   - keine erfundenen Eigenschaften

8. searchKeywords:
   - echte Produktbezeichnung
   - Marke
   - Variante / Geschmack
   - Inhalt / Packungsgrösse
   - passende Kategorie
   - sinnvolle Schweizer Suchvarianten
   - Kombinationen mit "Schweiz", "kaufen",
     "bestellen" wenn natürlich
   - ALO Kiosk / ALO Kiosk Schweiz ergänzend
   - keine irrelevanten Keywords

9. tags:
   - Marke
   - Kategorie
   - Produkttyp
   - Geschmack / Variante
   - Herkunft nur falls verifiziert
   - besondere Ernährungsmerkmale nur falls
     wirklich bestätigt

10. SEO und Shoptexte dürfen kreativ formuliert werden,
    aber die darin enthaltenen Produktfakten müssen immer
    auf der verifizierten Produktidentität und den
    recherchierten Fakten beruhen.

11. Bei confirmed soll der verifiedDraft möglichst
    vollständig sein. Prüfe NICHT nur fehlende Werte,
    sondern jeden verfügbaren Produkt-, Food-, Shop- und
    SEO-Wert auf Aktualität und Korrektheit.

12. Gehe die vollständige Feldliste des Product Schemas
    systematisch durch. Lass ein Feld nur leer/null, wenn
    dafür tatsächlich keine belastbare Information
    ermittelt werden kann.
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

FAST BARCODE DATABASE DATA:
${fastBarcodeDraft
  ? JSON.stringify(
      fastBarcodeDraft,
      null,
      2
    )
  : "Keine zusätzlichen Barcode-Daten gefunden."}

FAST BARCODE SOURCE:
${fastBarcodeSource
  ? JSON.stringify(
      fastBarcodeSource,
      null,
      2
    )
  : "Keine."}

WICHTIG ZU DIESEN FAST-DATEN:
- Sie sind zusätzliche Recherchehinweise.
- Sie ersetzen NICHT deine Web-Recherche.
- Prüfe sie gegen sweets.ch, Hersteller/Marke und
  weitere passende Quellen.
- Übernimm sie nur, wenn sie zur exakt identifizierten
  Produktvariante passen.
- Bei Konflikten melde diese in conflicts.

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
        }),
          new Promise(
            (
              _resolve,
              reject
            ) => {
              setTimeout(
                () =>
                  reject(
                    new Error(
                      "ALO Verify Websuche dauerte länger als 85 Sekunden."
                    )
                  ),
                85000
              );
            }
          ),
        ]);

      console.log(
        "[ALO VERIFY OPENAI RETURNED]",
        {
          ms:
            Date.now() -
            verifyStartedAt,
          responseId:
            response.id || null,
          hasOutputText:
            Boolean(
              response.output_text
            ),
        }
      );

      const raw =
        response.output_text;

      if (!raw) {
        throw new Error(
          "ALO Verify hat kein Ergebnis geliefert."
        );
      }

      let result: any;

      try {
        result =
          JSON.parse(raw);
      } catch {
        throw new Error(
          "ALO Verify Ergebnis konnte nicht gelesen werden."
        );
      }

      console.log(
        "[ALO VERIFY SUCCESS]",
        {
          totalMs:
            Date.now() -
            verifyStartedAt,
          identityStatus:
            result?.identityStatus ??
            null,
          sourceCount:
            Array.isArray(
              result?.sources
            )
              ? result.sources.length
              : 0,
          checkedFields:
            result?.summary
              ?.checkedFields ??
            null,
          foundFields:
            result?.summary
              ?.foundFields ??
            null,
          conflictCount:
            result?.summary
              ?.conflictCount ??
            null,
        }
      );

      res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "ALO product online verify error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Online-Abgleich fehlgeschlagen.",
      });
    }
  }
);


router.post(
  "/api/ai/product-image-studio",
  upload.single("image"),
  async (req, res) => {
    try {
      const file = req.file;

      if (!file) {
        res.status(400).json({
          ok: false,
          error:
            "Produktfoto fehlt.",
        });
        return;
      }

      const title =
        typeof req.body?.title ===
        "string"
          ? req.body.title.trim()
          : "";

      const brand =
        typeof req.body?.brand ===
        "string"
          ? req.body.brand.trim()
          : "";

      const unitSize =
        typeof req.body?.unitSize ===
        "string"
          ? req.body.unitSize.trim()
          : "";

      const referenceImage =
        await toFile(
          file.buffer,
          file.originalname ||
            "alo-product-reference.jpg",
          {
            type:
              file.mimetype ||
              "image/jpeg",
          }
        );

      const prompt = `
Create a professional e-commerce studio product image
using the supplied photograph as the STRICT visual reference.

PRODUCT HINTS:
Title: ${title || "unknown"}
Brand: ${brand || "unknown"}
Pack size: ${unitSize || "unknown"}

PRIMARY RULE:
Preserve the exact real product identity from the input image.

The actual packaging must remain faithful to the reference:
- exact product type and package shape
- exact brand identity
- exact visible logo
- exact label design
- exact colors
- exact flavor / variant
- exact visible typography and wording
- exact cap, lid, bottle, can, bag or box structure
- exact visible quantity / size markings when readable

DO NOT:
- redesign the package
- create a new label
- invent text
- correct or rewrite existing branding
- add promotional stickers
- add fruit, ingredients, ice, splashes or decorative props
- add hands or people
- add other products
- create a lifestyle scene
- change the product variant
- change the package color
- remove important visible packaging details

COMPOSITION:
- one single product only
- product fully visible
- upright and front-facing
- centered precisely
- generous but efficient margin around the product
- square 1:1 composition
- clean pure white or extremely light neutral studio background
- professional softbox lighting
- balanced exposure
- crisp product edges
- realistic material texture
- subtle natural contact shadow beneath the product
- no dramatic reflections hiding label information
- no perspective distortion
- no cropping of the product

The result must look like a premium Swiss online-shop
catalog product photo.

Faithfulness to the real package is more important than
beautification.

If any tiny text cannot be reproduced reliably,
do not invent replacement wording.
Keep the visual appearance as faithful as possible
to the supplied reference.
`;

      const result =
        await openai.images.edit({
          model:
            "gpt-image-2",
          image:
            referenceImage,
          prompt,
          size:
            "1024x1024",
          quality:
            "medium",
          background:
            "opaque",
        });

      const base64 =
        result.data?.[0]
          ?.b64_json;

      if (!base64) {
        throw new Error(
          "OpenAI hat kein Produktbild geliefert."
        );
      }

      const output =
        Buffer.from(
          base64,
          "base64"
        );

      res.setHeader(
        "Content-Type",
        "image/png"
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      res.setHeader(
        "Content-Length",
        String(output.length)
      );

      res.send(output);
    } catch (error) {
      console.error(
        "[ALO AI STUDIO IMAGE]",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Studio-Produktbild konnte nicht erstellt werden.",
      });
    }
  }
);

export default router;
