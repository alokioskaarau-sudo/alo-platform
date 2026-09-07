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
          },
          unit: {
            type: ['string', 'null'],
          },
          purchasePrice: {
            type: ['number', 'null'],
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
- Einkaufspreis und Gesamtpreis nur übernehmen, wenn klar erkennbar.
- Barcode/EAN nur übernehmen, wenn tatsächlich vorhanden.
- MHD und Charge nur übernehmen, wenn sie tatsächlich im Dokument stehen.
- Ein Datum des Lieferscheins ist NICHT automatisch ein MHD.
- Unsichere Felder null setzen.
- Bei unsicheren Produktbezeichnungen den sichtbaren Wortlaut verwenden.
- Kopfzeilen, Zwischensummen, MwSt., Porto und Gesamtsummen nicht als Produkte interpretieren.
- confidence zwischen 0 und 1 verwenden.
- Unsicherheiten in warnings beschreiben.
- Bei Mengen wie Karton, Tray, Pack oder Stück die sichtbare Einheit in unit angeben.
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
