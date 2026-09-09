import { createHash } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';

import { db } from '../database/db.js';

const router = Router();

const DELIVERY_PARSER_VERSION =
  'delivery-v3';

let cacheTableReady:
  Promise<void> | null = null;

function ensureDeliveryAiCache() {
  if (!cacheTableReady) {
    cacheTableReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS
          delivery_ai_cache (
            id BIGSERIAL PRIMARY KEY,
            file_hash TEXT NOT NULL,
            parser_version TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            file_size BIGINT,
            result_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
              DEFAULT NOW(),
            last_used_at TIMESTAMPTZ NOT NULL
              DEFAULT NOW(),
            hit_count INTEGER NOT NULL
              DEFAULT 0,
            UNIQUE (
              file_hash,
              parser_version
            )
          )
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS
          delivery_ai_cache_last_used_idx
        ON delivery_ai_cache (
          last_used_at DESC
        )
      `);
    })().catch((error) => {
      cacheTableReady = null;
      throw error;
    });
  }

  return cacheTableReady;
}

function hashDeliveryFile(
  buffer: Buffer
) {
  return createHash('sha256')
    .update(buffer)
    .digest('hex');
}

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
      description:
        'Primäre Dokument-/Belegnummer dieser Warenlieferung. Bevorzugt echte Lieferscheinnummer. Falls keine solche vorhanden ist, darf eine eindeutig als Auftragsnummer/Order Number bezeichnete Nummer verwendet werden. Keine Rechnungsnummer, Kundennummer oder Datumswerte.',
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
      if (!req.file) {
        res.status(400).json({
          ok: false,
          error:
            'Keine Lieferschein-Datei empfangen.',
        });
        return;
      }

      const fileHash =
        hashDeliveryFile(req.file.buffer);

      await ensureDeliveryAiCache();

      const cached =
        await db.query<{
          result_json: unknown;
        }>(
          `
            UPDATE delivery_ai_cache
            SET
              last_used_at = NOW(),
              hit_count = hit_count + 1
            WHERE
              file_hash = $1
              AND parser_version = $2
            RETURNING result_json
          `,
          [
            fileHash,
            DELIVERY_PARSER_VERSION,
          ]
        );

      if (cached.rows[0]) {
        console.log(
          '[ALO DELIVERY AI CACHE HIT]',
          fileHash.slice(0, 12)
        );

        res.json({
          ok: true,
          draft:
            cached.rows[0].result_json,
          cache: {
            hit: true,
            parserVersion:
              DELIVERY_PARSER_VERSION,
          },
        });

        return;
      }

      console.log(
        '[ALO DELIVERY AI CACHE MISS]',
        fileHash.slice(0, 12)
      );

      if (!process.env.OPENAI_API_KEY) {
        res.status(500).json({
          ok: false,
          error:
            'OPENAI_API_KEY ist auf dem Server nicht gesetzt.',
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

Dateiname des hochgeladenen Dokuments:
${req.file.originalname || 'unbekannt'}

Der Dateiname darf als zusätzlicher Hinweis für die Dokument-/Auftragsnummer verwendet werden, aber nur wenn er eine plausible Nummer enthält und zum Dokument passt.

Erstelle ausschließlich einen strukturierten JSON-Entwurf.

WICHTIGE REGELN:
- Nichts erfinden.
- Lieferant nur übernehmen, wenn er im Dokument erkennbar ist.
- deliveryNote ist die primäre Dokument-/Belegnummer dieser Warenlieferung.
- PRIORITÄT 1: echte Lieferscheinnummer, z.B. "Lieferschein", "Lieferschein-Nr.", "Lieferscheinnummer", "Delivery Note", "Delivery Note No.", "Delivery No.".
- PRIORITÄT 2: falls keine echte Lieferscheinnummer vorhanden ist, darf eine eindeutig sichtbare Auftragsnummer / Order Number / Order No. als deliveryNote verwendet werden.
- Rechnungsnummer, Invoice Number, Kundennummer, Debitorennummer oder Datum niemals als deliveryNote verwenden.
- Den Wert exakt übernehmen, inklusive Buchstaben, Bindestrichen, Schrägstrichen und führenden Nullen.
- Wenn mehrere mögliche Nummern vorhanden sind, die Nummer mit der höchsten obigen Priorität verwenden.
- Wenn weder Lieferschein- noch eindeutige Auftragsnummer erkennbar ist, deliveryNote=null setzen statt zu raten.
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

      await db.query(
        `
          INSERT INTO delivery_ai_cache (
            file_hash,
            parser_version,
            original_name,
            mime_type,
            file_size,
            result_json
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::jsonb
          )
          ON CONFLICT (
            file_hash,
            parser_version
          )
          DO UPDATE SET
            result_json =
              EXCLUDED.result_json,
            original_name =
              EXCLUDED.original_name,
            mime_type =
              EXCLUDED.mime_type,
            file_size =
              EXCLUDED.file_size,
            last_used_at = NOW()
        `,
        [
          fileHash,
          DELIVERY_PARSER_VERSION,
          req.file.originalname || null,
          req.file.mimetype || null,
          req.file.size,
          JSON.stringify(parsed),
        ]
      );

      console.log(
        '[ALO DELIVERY AI CACHE SAVED]',
        fileHash.slice(0, 12)
      );

      res.json({
        ok: true,
        draft: parsed,
        cache: {
          hit: false,
          parserVersion:
            DELIVERY_PARSER_VERSION,
        },
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
