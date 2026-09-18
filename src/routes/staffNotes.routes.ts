import { Router } from "express";
import { db } from "../database/db.js";

const router = Router();

type NoteStore =
  | "aarau"
  | "olten"
  | "online"
  | "all";

type NotePriority =
  | "normal"
  | "important"
  | "urgent";

type NoteType =
  | "task"
  | "handover"
  | "note"
  | "pinned"
  | "customer"
  | "problem";

function cleanText(
  value: unknown
): string {
  return String(
    value ?? ""
  ).trim();
}

function validStore(
  value: unknown
): value is NoteStore {
  return (
    value === "aarau" ||
    value === "olten" ||
    value === "online" ||
    value === "all"
  );
}

function validPriority(
  value: unknown
): value is NotePriority {
  return (
    value === "normal" ||
    value === "important" ||
    value === "urgent"
  );
}

function validType(
  value: unknown
): value is NoteType {
  return (
    value === "task" ||
    value === "handover" ||
    value === "note" ||
    value === "pinned" ||
    value === "customer" ||
    value === "problem"
  );
}

function parseDueAt(
  value: unknown
): Date | null {
  const text =
    cleanText(value);

  if (!text) {
    return null;
  }

  const date =
    new Date(text);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date;
}

async function ensureTable() {
  /*
   * CREATE bleibt kompatibel
   * mit einer komplett neuen DB.
   */
  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_notes (
      id BIGSERIAL PRIMARY KEY,
      store_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,

      priority TEXT NOT NULL
        DEFAULT 'normal',

      note_type TEXT NOT NULL
        DEFAULT 'note',

      pinned BOOLEAN NOT NULL
        DEFAULT FALSE,

      due_at TIMESTAMPTZ,

      completed BOOLEAN NOT NULL
        DEFAULT FALSE,

      created_by TEXT,
      completed_by TEXT,
      completed_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      CONSTRAINT staff_notes_store_check
        CHECK (
          store_id IN (
            'aarau',
            'olten',
            'online',
            'all'
          )
        ),

      CONSTRAINT staff_notes_priority_check
        CHECK (
          priority IN (
            'normal',
            'important',
            'urgent'
          )
        ),

      CONSTRAINT staff_notes_type_check
        CHECK (
          note_type IN (
            'task',
            'handover',
            'note',
            'pinned',
            'customer',
            'problem'
          )
        )
    );
  `);

  /*
   * Migration bestehender Tabelle.
   * Vorhandene Notizen bleiben erhalten.
   */
  await db.query(`
    ALTER TABLE staff_notes
    ADD COLUMN IF NOT EXISTS
      note_type TEXT;
  `);

  await db.query(`
    ALTER TABLE staff_notes
    ADD COLUMN IF NOT EXISTS
      pinned BOOLEAN;
  `);

  await db.query(`
    ALTER TABLE staff_notes
    ADD COLUMN IF NOT EXISTS
      due_at TIMESTAMPTZ;
  `);

  await db.query(`
    UPDATE staff_notes
    SET note_type = 'note'
    WHERE note_type IS NULL;
  `);

  await db.query(`
    UPDATE staff_notes
    SET pinned = FALSE
    WHERE pinned IS NULL;
  `);

  await db.query(`
    ALTER TABLE staff_notes
    ALTER COLUMN note_type
      SET DEFAULT 'note';
  `);

  await db.query(`
    ALTER TABLE staff_notes
    ALTER COLUMN note_type
      SET NOT NULL;
  `);

  await db.query(`
    ALTER TABLE staff_notes
    ALTER COLUMN pinned
      SET DEFAULT FALSE;
  `);

  await db.query(`
    ALTER TABLE staff_notes
    ALTER COLUMN pinned
      SET NOT NULL;
  `);

  /*
   * Constraint nur ergänzen,
   * falls er bei alter Tabelle
   * noch nicht existiert.
   */
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
          'staff_notes_type_check'
      ) THEN
        ALTER TABLE staff_notes
        ADD CONSTRAINT
          staff_notes_type_check
        CHECK (
          note_type IN (
            'task',
            'handover',
            'note',
            'pinned',
            'customer',
            'problem'
          )
        );
      END IF;
    END
    $$;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_notes_store_open_idx
    ON staff_notes (
      store_id,
      completed,
      created_at DESC
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_notes_board_idx
    ON staff_notes (
      store_id,
      pinned DESC,
      note_type,
      completed,
      created_at DESC
    );
  `);
}

let tableReady:
  Promise<void> | null = null;

function ensureReady() {
  if (!tableReady) {
    tableReady =
      ensureTable().catch(
        (error) => {
          tableReady = null;
          throw error;
        }
      );
  }

  return tableReady;
}

const returningFields = `
  id,
  store_id AS "storeId",
  title,
  body,
  priority,
  note_type AS "type",
  pinned,
  due_at AS "dueAt",
  completed,
  created_by AS "createdBy",
  completed_by AS "completedBy",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

/* =========================================================
   LIST
========================================================= */

router.get(
  "/",
  async (req, res) => {
    try {
      await ensureReady();

      const requestedStore =
        cleanText(
          req.query.store
        );

      const requestedType =
        cleanText(
          req.query.type
        );

      const includeCompleted =
        req.query.completed ===
        "true";

      const values: unknown[] =
        [];

      const where: string[] =
        [];

      if (
        requestedStore &&
        requestedStore !== "all"
      ) {
        if (
          !validStore(
            requestedStore
          )
        ) {
          res
            .status(400)
            .json({
              ok: false,
              error:
                "Ungültiger Standort.",
            });

          return;
        }

        values.push(
          requestedStore
        );

        where.push(
          `(store_id = $${values.length} OR store_id = 'all')`
        );
      }

      if (requestedType) {
        if (
          !validType(
            requestedType
          )
        ) {
          res
            .status(400)
            .json({
              ok: false,
              error:
                "Ungültiger Eintragstyp.",
            });

          return;
        }

        values.push(
          requestedType
        );

        where.push(
          `note_type = $${values.length}`
        );
      }

      if (!includeCompleted) {
        where.push(
          "completed = FALSE"
        );
      }

      const result =
        await db.query(
          `
            SELECT
              ${returningFields}
            FROM staff_notes

            ${
              where.length
                ? `WHERE ${where.join(
                    " AND "
                  )}`
                : ""
            }

            ORDER BY
              completed ASC,
              pinned DESC,

              CASE priority
                WHEN 'urgent'
                  THEN 1
                WHEN 'important'
                  THEN 2
                ELSE 3
              END ASC,

              CASE note_type
                WHEN 'problem'
                  THEN 1
                WHEN 'task'
                  THEN 2
                WHEN 'handover'
                  THEN 3
                WHEN 'pinned'
                  THEN 4
                WHEN 'customer'
                  THEN 5
                ELSE 6
              END ASC,

              due_at ASC
                NULLS LAST,

              created_at DESC
          `,
          values
        );

      res.json({
        ok: true,
        notes: result.rows,
      });
    } catch (error) {
      console.error(
        "STAFF NOTES LIST ERROR",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "ALO Board konnte nicht geladen werden.",
      });
    }
  }
);

/* =========================================================
   CREATE
========================================================= */

router.post(
  "/",
  async (req, res) => {
    try {
      await ensureReady();

      const storeId =
        cleanText(
          req.body?.storeId
        );

      const title =
        cleanText(
          req.body?.title
        );

      const body =
        cleanText(
          req.body?.body
        );

      const createdBy =
        cleanText(
          req.body?.createdBy
        );

      const priority =
        cleanText(
          req.body?.priority
        ) || "normal";

      const type =
        cleanText(
          req.body?.type
        ) || "note";

      const pinned =
        typeof req.body
          ?.pinned ===
        "boolean"
          ? req.body.pinned
          : type === "pinned";

      const dueAtRaw =
        cleanText(
          req.body?.dueAt
        );

      const dueAt =
        parseDueAt(
          dueAtRaw
        );

      if (
        !validStore(storeId)
      ) {
        res.status(422).json({
          ok: false,
          error:
            "Bitte einen gültigen Standort wählen.",
        });

        return;
      }

      if (!title) {
        res.status(422).json({
          ok: false,
          error:
            "Bitte einen Titel eingeben.",
        });

        return;
      }

      if (
        !validPriority(
          priority
        )
      ) {
        res.status(422).json({
          ok: false,
          error:
            "Ungültige Priorität.",
        });

        return;
      }

      if (!validType(type)) {
        res.status(422).json({
          ok: false,
          error:
            "Ungültiger Eintragstyp.",
        });

        return;
      }

      if (
        dueAtRaw &&
        !dueAt
      ) {
        res.status(422).json({
          ok: false,
          error:
            "Ungültiger Fälligkeitszeitpunkt.",
        });

        return;
      }

      const result =
        await db.query(
          `
            INSERT INTO staff_notes (
              store_id,
              title,
              body,
              priority,
              note_type,
              pinned,
              due_at,
              created_by
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8
            )
            RETURNING
              ${returningFields}
          `,
          [
            storeId,
            title,
            body || null,
            priority,
            type,
            pinned,
            dueAt,
            createdBy || null,
          ]
        );

      res.status(201).json({
        ok: true,
        note: result.rows[0],
      });
    } catch (error) {
      console.error(
        "STAFF NOTES CREATE ERROR",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Eintrag konnte nicht erstellt werden.",
      });
    }
  }
);

/* =========================================================
   UPDATE
========================================================= */

router.patch(
  "/:id",
  async (req, res) => {
    try {
      await ensureReady();

      const id =
        Number(
          req.params.id
        );

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültige Eintrag-ID.",
        });

        return;
      }

      const current =
        await db.query(
          `
            SELECT *
            FROM staff_notes
            WHERE id = $1
            LIMIT 1
          `,
          [id]
        );

      if (
        current.rowCount ===
        0
      ) {
        res.status(404).json({
          ok: false,
          error:
            "Eintrag nicht gefunden.",
        });

        return;
      }

      const existing =
        current.rows[0];

      const storeId =
        req.body?.storeId ===
        undefined
          ? existing.store_id
          : cleanText(
              req.body.storeId
            );

      const title =
        req.body?.title ===
        undefined
          ? existing.title
          : cleanText(
              req.body.title
            );

      const body =
        req.body?.body ===
        undefined
          ? existing.body
          : cleanText(
              req.body.body
            ) || null;

      const priority =
        req.body?.priority ===
        undefined
          ? existing.priority
          : cleanText(
              req.body.priority
            );

      const type =
        req.body?.type ===
        undefined
          ? existing.note_type
          : cleanText(
              req.body.type
            );

      const pinned =
        typeof req.body
          ?.pinned ===
        "boolean"
          ? req.body.pinned
          : existing.pinned;

      const completed =
        typeof req.body
          ?.completed ===
        "boolean"
          ? req.body.completed
          : existing.completed;

      const completedBy =
        cleanText(
          req.body?.completedBy
        );

      let dueAt =
        existing.due_at;

      if (
        req.body?.dueAt !==
        undefined
      ) {
        const raw =
          cleanText(
            req.body.dueAt
          );

        if (!raw) {
          dueAt = null;
        } else {
          const parsed =
            parseDueAt(raw);

          if (!parsed) {
            res
              .status(422)
              .json({
                ok: false,
                error:
                  "Ungültiger Fälligkeitszeitpunkt.",
              });

            return;
          }

          dueAt = parsed;
        }
      }

      if (
        !validStore(storeId)
      ) {
        res.status(422).json({
          ok: false,
          error:
            "Ungültiger Standort.",
        });

        return;
      }

      if (!title) {
        res.status(422).json({
          ok: false,
          error:
            "Titel darf nicht leer sein.",
        });

        return;
      }

      if (
        !validPriority(
          priority
        )
      ) {
        res.status(422).json({
          ok: false,
          error:
            "Ungültige Priorität.",
        });

        return;
      }

      if (!validType(type)) {
        res.status(422).json({
          ok: false,
          error:
            "Ungültiger Eintragstyp.",
        });

        return;
      }

      const result =
        await db.query(
          `
            UPDATE staff_notes
            SET
              store_id = $2,
              title = $3,
              body = $4,
              priority = $5,
              note_type = $6,
              pinned = $7,
              due_at = $8,
              completed = $9,

              completed_by =
                CASE
                  WHEN $9 = TRUE
                    THEN COALESCE(
                      NULLIF(
                        $10,
                        ''
                      ),
                      completed_by
                    )
                  ELSE NULL
                END,

              completed_at =
                CASE
                  WHEN $9 = TRUE
                    THEN COALESCE(
                      completed_at,
                      NOW()
                    )
                  ELSE NULL
                END,

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING
              ${returningFields}
          `,
          [
            id,
            storeId,
            title,
            body,
            priority,
            type,
            pinned,
            dueAt,
            completed,
            completedBy,
          ]
        );

      res.json({
        ok: true,
        note: result.rows[0],
      });
    } catch (error) {
      console.error(
        "STAFF NOTES UPDATE ERROR",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Eintrag konnte nicht aktualisiert werden.",
      });
    }
  }
);

/* =========================================================
   DELETE
========================================================= */

router.delete(
  "/:id",
  async (req, res) => {
    try {
      await ensureReady();

      const id =
        Number(
          req.params.id
        );

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        res.status(400).json({
          ok: false,
          error:
            "Ungültige Eintrag-ID.",
        });

        return;
      }

      const result =
        await db.query(
          `
            DELETE FROM staff_notes
            WHERE id = $1
            RETURNING id
          `,
          [id]
        );

      if (
        result.rowCount ===
        0
      ) {
        res.status(404).json({
          ok: false,
          error:
            "Eintrag nicht gefunden.",
        });

        return;
      }

      res.json({
        ok: true,
        id,
      });
    } catch (error) {
      console.error(
        "STAFF NOTES DELETE ERROR",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Eintrag konnte nicht gelöscht werden.",
      });
    }
  }
);

export default router;
