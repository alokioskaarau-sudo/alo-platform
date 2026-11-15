import { db } from "./db.js";

// Explizite Migration: wird nicht automatisch beim Serverstart ausgeführt.
export async function initializeHuntObservationSchema() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(10611001)");

    await client.query(`
      ALTER TABLE public.alo_hunt_stations
        ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'QR',
        ADD COLUMN IF NOT EXISTS answer_hint TEXT
    `);

    // Bestehende QR-Stationen behalten ihren bisherigen Modus.
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.alo_hunt_stations'::regclass
            AND conname = 'alo_hunt_station_access_mode_guard'
        ) THEN
          ALTER TABLE public.alo_hunt_stations
            ADD CONSTRAINT alo_hunt_station_access_mode_guard
            CHECK (access_mode IN ('QR', 'OBSERVATION'));
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.alo_hunt_stations'::regclass
            AND conname = 'alo_hunt_station_answer_hint_guard'
        ) THEN
          ALTER TABLE public.alo_hunt_stations
            ADD CONSTRAINT alo_hunt_station_answer_hint_guard
            CHECK (
              answer_hint IS NULL
              OR (
                char_length(answer_hint) BETWEEN 1 AND 120
                AND answer_hint !~ '[[:cntrl:]]'
              )
            );
        END IF;
      END
      $migration$
    `);

    // answer_hint enthält nur die sichtbare Hilfe,
    // beispielsweise "S _ _ _ _". Keine vollständige geheime Lösung.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.alo_hunt_search_stages (
        event_slug TEXT NOT NULL,
        quest_key TEXT NOT NULL,
        station_key TEXT NOT NULL,
        stage_position INTEGER NOT NULL CHECK (stage_position > 0),
        latitude DOUBLE PRECISION NOT NULL
          CHECK (latitude BETWEEN -90 AND 90),
        longitude DOUBLE PRECISION NOT NULL
          CHECK (longitude BETWEEN -180 AND 180),
        radius_meters INTEGER NOT NULL
          CHECK (radius_meters BETWEEN 20 AND 2000),
        release_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (status IN ('DRAFT', 'PUBLISHED', 'DISABLED')),

        PRIMARY KEY (
          event_slug, quest_key, station_key, stage_position
        ),

        FOREIGN KEY (event_slug, quest_key, station_key)
          REFERENCES public.alo_hunt_stations (
            event_slug, quest_key, station_key
          )
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS alo_hunt_search_stages_release_idx
      ON public.alo_hunt_search_stages (
        event_slug, quest_key, station_key, release_at
      )
      WHERE status = 'PUBLISHED'
    `);

    // Bewusst noch keine Änderung der Veröffentlichungsbedingung:
    // Ortsrätsel werden erst nach Anpassung und Test der Spielaktionen
    // ohne QR-Code veröffentlichbar.
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
