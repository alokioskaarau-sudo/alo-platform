import { Router } from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
      return;
    }

    cb(
      new Error(
        `Dateityp nicht unterstützt: ${file.mimetype}`
      )
    );
  },
});

const deliverySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier: {
      type: ['string', 'null'],
    },
    deliveryNote: {
      type: ['string', 'null'],
    },
    documentDate: {
      type: ['string', 'null'],
      description:
        'Datum im Format YYYY-MM-DD, falls sicher erkennbar.',
    },
    currency: {
      type: ['string', 'null'],
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    warnings: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          product: {
            type: 'string',
          },
          articleNumber: {
            type: ['string', 'null'],
          },
          barcode: {
            type: ['string', 'null'],
          },
          quantity: {
            type: 'number',
            description:
              'Die im Dokument sichtbare Mengenangabe. Nicht raten.',
          },
          cases: {
            type: ['number', 'null'],
            description:
              'Anzahl Kartons/Trays/Displays, nur wenn eindeutig erkennbar.',
          },
          unitsPerCase: {
            type: ['number', 'null'],
            description:
              'Verkaufseinheiten pro Karton/Tray/Display, nur wenn eindeutig erkennbar.',
          },
          totalUnits: {
            type: ['number', 'null'],
            description:
              'Gesamtzahl einzelner Verkaufseinheiten. Darf aus cases * unitsPerCase berechnet werden, wenn beide Werte eindeutig sind.',
          },
          unitSize: {
            type: ['string', 'null'],
            description:
              'Gebindegrösse einer Verkaufseinheit, z.B. 330ml, 500ml, 42g.',
          },
          unit: {
            type: ['string', 'null'],
          },
          purchasePrice: {
            type: ['number', 'null'],
            description:
              'Einkaufspreis pro einzelner Verkaufseinheit. Nur setzen, wenn aus dem Dokument eindeutig bestimmbar.',
          },
          totalPrice: {
            type: ['number', 'null'],
          },
          expiry: {
            type: ['string', 'null'],
            description:
              'MHD als YYYY-MM-DD nur wenn tatsächlich im Dokument erkennbar.',
          },
          batch: {
            type: ['string', 'null'],
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
          warnings: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        required: [
          'product',
          'articleNumber',
          'barcode',
          'quantity',
          'cases',
          'unitsPerCase',
          'totalUnits',
          'unitSize',
          'unit',
          'purchasePrice',
          'totalPrice',
          'expiry',
          'batch',
          'confidence',
          'warnings',
        ],
      },
    },
  },
  required: [
    'supplier',
    'deliveryNote',
    'documentDate',
    'currency',
    'confidence',
    'warnings',
    'items',
  ],
} as const;

router.post(
  '/delivery-document',
  upload.single('file'),
  async (req, res) => {
    let uploadedFileId: string | null = null;

    try {
      if (!process.env.OPENAI_API_KEY) {
        res.status(500).json({
          ok: false,
          error:
            'OPENAI_API_KEY ist auf dem Server nicht gesetzt.',
        });
        return;
      }

      if (!req.file) {
        res.status(400).json({
          ok: false,
          error:
            'Keine Lieferschein-Datei empfangen.',
        });
        return;
      }

      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      const file = await openai.files.create({
        file: await toFile(
          req.file.buffer,
          req.file.originalname || 'lieferschein',
          {
            type:
              req.file.mimetype ||
              'application/octet-stream',
          }
        ),
        purpose: 'user_data',
      });

      uploadedFileId = file.id;

      const response =
        await openai.responses.create({
          model: 'gpt-5.6-terra',

          reasoning: {
            effort: 'low',
          },

          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `
Analysiere diesen Lieferschein für ALO Kiosk.

Erstelle ausschließlich einen strukturierten JSON-Entwurf.

WICHTIGE REGELN:
- Nichts erfinden.
- Lieferant nur übernehmen, wenn er im Dokument erkennbar ist.
- Lieferscheinnummer möglichst exakt übernehmen.
- Jede echte Produktposition einzeln erfassen.
- Mengen exakt aus dem Dokument übernehmen.
- quantity ist die im Dokument sichtbare Mengenangabe; nichts hineininterpretieren.
- Wenn eine Position eindeutig z.B. 4 Kartons mit je 24 Verkaufseinheiten enthält: cases=4, unitsPerCase=24 und totalUnits=96.
- totalUnits darf nur mathematisch aus eindeutig erkennbaren cases und unitsPerCase berechnet werden oder wenn die Gesamtstückzahl selbst sichtbar ist.
- Wenn nur 48 einzelne Verkaufseinheiten erkennbar sind, totalUnits=48.
- Wenn die Verpackungsstruktur nicht sicher erkennbar ist, cases, unitsPerCase und totalUnits null setzen statt zu raten.
- unitSize beschreibt EINE Verkaufseinheit, z.B. 330ml, 500ml oder 42g, nur wenn erkennbar.
- purchasePrice bedeutet ausschließlich Einkaufspreis pro einzelner Verkaufseinheit.
- Wenn im Dokument nur ein Kartonpreis steht und die Stückzahl pro Karton eindeutig ist, darf purchasePrice = Kartonpreis / unitsPerCase berechnet werden.
- Wenn die Preisbasis nicht eindeutig ist, purchasePrice null setzen.
- totalPrice ist ausschließlich die Positionssumme dieser Produktzeile, niemals Lieferschein-Gesamtsumme.
- Einkaufspreis und Positionssumme nur übernehmen oder berechnen, wenn die Grundlage eindeutig ist.
- Barcode/EAN nur übernehmen, wenn tatsächlich vorhanden. Keine EAN aus Produktwissen ergänzen.
- MHD und Charge nur übernehmen, wenn sie tatsächlich im Dokument stehen.
- Ein Datum des Lieferscheins ist NICHT automatisch ein MHD.
- Unsichere Felder null setzen.
- Bei unsicheren Produktbezeichnungen den sichtbaren Wortlaut verwenden.
- Kopfzeilen, Zwischensummen, MwSt., Porto und Gesamtsummen nicht als Produkte interpretieren.
- confidence zwischen 0 und 1 verwenden.
- Unsicherheiten in warnings beschreiben.
- Bei Mengen wie Karton, Tray, Display, Pack oder Stück die sichtbare Einheit in unit angeben.
- Für die spätere Lagerbuchung ist die Anzahl einzelner verkaufbarer Einheiten entscheidend; deshalb Verpackungshierarchien so exakt wie möglich strukturiert erfassen.
- Rechenwerte nur erzeugen, wenn ihre Ausgangswerte eindeutig im Dokument stehen.
- Keine Verkaufspreise erfinden oder aus Einkaufspreisen ableiten.
                  `.trim(),
                },
                {
                  type: 'input_file',
                  file_id: file.id,
                },
              ],
            },
          ],

          text: {
            format: {
              type: 'json_schema',
              name: 'alo_delivery_document',
              strict: true,
              schema: deliverySchema,
            },
          },
        });

      if (!response.output_text) {
        throw new Error(
          'OpenAI hat keine auslesbaren Daten zurückgegeben.'
        );
      }

      const parsed = JSON.parse(
        response.output_text
      );

      res.json({
        ok: true,
        draft: parsed,
      });
    } catch (error) {
      console.error(
        '[ALO DELIVERY AI]',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Lieferschein konnte nicht analysiert werden.',
      });
    } finally {
      if (
        uploadedFileId &&
        process.env.OPENAI_API_KEY
      ) {
        try {
          const openai = new OpenAI({
            apiKey:
              process.env.OPENAI_API_KEY,
          });

          await openai.files.delete(
            uploadedFileId
          );
        } catch (error) {
          console.error(
            '[ALO DELIVERY AI CLEANUP]',
            error
          );
        }
      }
    }
  }
);

export default router;
