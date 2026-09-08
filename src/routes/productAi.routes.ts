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
  "/api/ai/product-verify-online",
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

      if (!barcode && !title && !brand) {
        res.status(400).json({
          ok: false,
          error:
            "Für den Online-Abgleich fehlen Barcode und Produktidentität.",
        });
        return;
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
3. Verwende vorzugsweise:
   - offizielle Herstellerseiten
   - offizielle Markenwebseiten
   - offizielle Produktdaten
4. Seriöse Händler oder Produktdatenbanken nur
   ergänzend verwenden.
5. Barcode/EAN ist das stärkste Identitätsmerkmal.
6. Zusätzlich Marke, Produktname, Geschmack und
   Packungsgrösse abgleichen.
7. Wenn Packungsgrösse, Variante oder Barcode
   nicht zusammenpassen, darf die Quelle NICHT
   blind für Food Data verwendet werden.

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

export default router;
