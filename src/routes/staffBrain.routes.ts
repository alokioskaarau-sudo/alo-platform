/* ALO_261_BRAIN_API
 * Server-side, authenticated, confirmed memories.
 * V1: personal scope only. Team permissions follow separately.
 */

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../database/db.js";
import {
  requireStaffAuth,
  getStaffUser
} from "../middleware/staffAuth.js";

const router = Router();
router.use(requireStaffAuth);

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS alo_brain_memories (
          id UUID PRIMARY KEY,
          owner_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          topic TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS alo_brain_owner_idx
        ON alo_brain_memories (owner_id, updated_at DESC)
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS alo_brain_links (
          id UUID PRIMARY KEY,
          owner_id TEXT NOT NULL,
          source_id UUID NOT NULL
            REFERENCES alo_brain_memories(id) ON DELETE CASCADE,
          target_id UUID NOT NULL
            REFERENCES alo_brain_memories(id) ON DELETE CASCADE,
          relation TEXT NOT NULL DEFAULT 'RELATED_TOPIC',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (source_id <> target_id)
        )
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS alo_brain_links_owner_idx
        ON alo_brain_links (owner_id)
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS alo_brain_events (
          id UUID PRIMARY KEY,
          owner_id TEXT NOT NULL,
          memory_id UUID,
          event_type TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS alo_brain_events_owner_idx
        ON alo_brain_events (owner_id, created_at DESC)
      `);
    })().catch(error => {
      schemaReady = null;
      throw error;
    });
  }

  return schemaReady;
}

const kinds = new Set([
  "PREFERENCE",
  "WORKFLOW_RULE",
  "PRODUCT_KNOWLEDGE",
  "VOICE_STYLE",
  "TEAM_KNOWLEDGE"
]);

function clean(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function owner(res: any): string {
  return String(getStaffUser(res).id);
}

function validId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Brain data for the visual graph.
router.get("/", async (_req, res) => {
  try {
    await ensureSchema();

    const userId = owner(res);

    const [memories, links, events] = await Promise.all([
      db.query(`
        SELECT id, kind, topic, title, content, source,
               created_at AS "createdAt",
               updated_at AS "updatedAt"
        FROM alo_brain_memories
        WHERE owner_id = $1
        ORDER BY updated_at DESC
        LIMIT 200
      `, [userId]),

      db.query(`
        SELECT l.id, l.source_id AS "sourceId",
               l.target_id AS "targetId", l.relation
        FROM alo_brain_links l
        JOIN alo_brain_memories a
          ON a.id = l.source_id AND a.owner_id = $1
        JOIN alo_brain_memories b
          ON b.id = l.target_id AND b.owner_id = $1
        WHERE l.owner_id = $1
        ORDER BY l.created_at DESC
        LIMIT 400
      `, [userId]),

      db.query(`
        SELECT id, memory_id AS "memoryId",
               event_type AS "eventType",
               description,
               created_at AS "createdAt"
        FROM alo_brain_events
        WHERE owner_id = $1
        ORDER BY created_at DESC
        LIMIT 100
      `, [userId])
    ]);

    res.json({
      ok: true,
      mode: "SERVER_MEMORY",
      memories: memories.rows,
      links: links.rows,
      events: events.rows
    });
  } catch (error) {
    console.error("ALO Brain read error", error);
    res.status(500).json({
      ok: false,
      error: "ALO Brain konnte nicht geladen werden."
    });
  }
});

// Only an explicitly confirmed memory may be stored.
router.post("/", async (req, res) => {
  const kind = clean(req.body?.kind, 40);
  const topic = clean(req.body?.topic, 80).toLowerCase();
  const title = clean(req.body?.title, 120);
  const content = clean(req.body?.content, 1200);
  const source = clean(req.body?.source, 40) || "conversation";

  if (
    req.body?.confirmed !== true ||
    !kinds.has(kind) ||
    !topic || !title || !content ||
    !["manual", "conversation", "correction"].includes(source)
  ) {
    res.status(422).json({
      ok: false,
      error: "Erinnerung muss ausdrücklich bestätigt werden."
    });
    return;
  }

  const userId = owner(res);
  const id = randomUUID();
  const eventId = randomUUID();

  try {
    await ensureSchema();

    const client = await db.connect();

    try {
      await client.query("BEGIN");

      const previous = await client.query(`
        SELECT id
        FROM alo_brain_memories
        WHERE owner_id = $1 AND topic = $2
        ORDER BY updated_at DESC
        LIMIT 1
      `, [userId, topic]);

      const inserted = await client.query(`
        INSERT INTO alo_brain_memories
          (id, owner_id, kind, topic, title, content, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id, kind, topic, title, content, source,
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"
      `, [id, userId, kind, topic, title, content, source]);

      let link = null;

      if (previous.rows.length) {
        const linkId = randomUUID();

        const linked = await client.query(`
          INSERT INTO alo_brain_links
            (id, owner_id, source_id, target_id, relation)
          VALUES ($1,$2,$3,$4,'RELATED_TOPIC')
          RETURNING id, source_id AS "sourceId",
                    target_id AS "targetId", relation
        `, [linkId, userId, id, previous.rows[0].id]);

        link = linked.rows[0];
      }

      await client.query(`
        INSERT INTO alo_brain_events
          (id, owner_id, memory_id, event_type, description)
        VALUES ($1,$2,$3,'MEMORY_CREATED',$4)
      `, [eventId, userId, id, title]);

      await client.query("COMMIT");

      res.status(201).json({
        ok: true,
        memory: inserted.rows[0],
        link,
        event: "MEMORY_CREATED"
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("ALO Brain write error", error);
    res.status(500).json({
      ok: false,
      error: "Erinnerung konnte nicht gespeichert werden."
    });
  }
});

// Correct an existing memory.
router.patch("/:id", async (req, res) => {
  if (!validId(req.params.id) || req.body?.confirmed !== true) {
    res.status(422).json({
      ok: false,
      error: "Ungültige oder nicht bestätigte Korrektur."
    });
    return;
  }

  const title = clean(req.body?.title, 120);
  const content = clean(req.body?.content, 1200);

  if (!title || !content) {
    res.status(422).json({
      ok: false,
      error: "Titel und Inhalt erforderlich."
    });
    return;
  }

  try {
    await ensureSchema();

    const result = await db.query(`
      UPDATE alo_brain_memories
      SET title = $3, content = $4, updated_at = NOW()
      WHERE id = $1 AND owner_id = $2
      RETURNING id, title, content
    `, [req.params.id, owner(res), title, content]);

    if (!result.rows.length) {
      res.status(404).json({ ok: false, error: "Nicht gefunden." });
      return;
    }

    res.json({ ok: true, memory: result.rows[0] });
  } catch (error) {
    console.error("ALO Brain update error", error);
    res.status(500).json({ ok: false, error: "Korrektur fehlgeschlagen." });
  }
});

// Delete an owned memory; graph links cascade.
router.delete("/:id", async (req, res) => {
  if (!validId(req.params.id) || req.body?.confirmed !== true) {
    res.status(422).json({
      ok: false,
      error: "Löschen muss ausdrücklich bestätigt werden."
    });
    return;
  }

  try {
    await ensureSchema();

    const result = await db.query(`
      DELETE FROM alo_brain_memories
      WHERE id = $1 AND owner_id = $2
      RETURNING id
    `, [req.params.id, owner(res)]);

    if (!result.rows.length) {
      res.status(404).json({ ok: false, error: "Nicht gefunden." });
      return;
    }

    res.json({ ok: true, deleted: true });
  } catch (error) {
    console.error("ALO Brain delete error", error);
    res.status(500).json({ ok: false, error: "Löschen fehlgeschlagen." });
  }
});

export default router;
