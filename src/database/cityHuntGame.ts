import { db } from "./db.js";

// Manuell ausführen. Kein Spielstart und keine echten Fundcodes.
export async function initializeCityHuntGame() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [10611001]
    );

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        alo_hunt_players_id_event_unique
      ON alo_hunt_players (id, event_slug);

      CREATE TABLE IF NOT EXISTS alo_hunt_quests (
        event_slug TEXT NOT NULL
          REFERENCES alo_hunt_events(slug),
        quest_key TEXT NOT NULL,
        title TEXT NOT NULL,
        introduction TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (status IN ('DRAFT', 'PUBLISHED', 'DISABLED')),
        opens_at TIMESTAMPTZ,
        closes_at TIMESTAMPTZ,
        final_code_hash TEXT
          CHECK (final_code_hash ~ '^[0-9a-f]{64}$'),
        cash_prize_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_slug, quest_key),
        FOREIGN KEY (event_slug, cash_prize_key)
          REFERENCES alo_hunt_cash_prizes(event_slug, prize_key),
        CHECK (
          closes_at IS NULL OR opens_at IS NULL
          OR closes_at > opens_at
        ),
        CHECK (
          status <> 'PUBLISHED' OR (
            opens_at IS NOT NULL
            AND closes_at IS NOT NULL
            AND final_code_hash IS NOT NULL
            AND cash_prize_key IS NOT NULL
          )
        )
      );

      CREATE TABLE IF NOT EXISTS alo_hunt_stations (
        event_slug TEXT NOT NULL,
        quest_key TEXT NOT NULL,
        station_key TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position > 0),
        title TEXT NOT NULL,
        task_text TEXT NOT NULL,

        -- Nur ungefähres Suchgebiet, kein exakter Fundort.
        area_latitude DOUBLE PRECISION
          CHECK (area_latitude BETWEEN -90 AND 90),
        area_longitude DOUBLE PRECISION
          CHECK (area_longitude BETWEEN -180 AND 180),
        area_radius_m INTEGER
          CHECK (area_radius_m BETWEEN 20 AND 2000),

        -- Rohe QR-Codes und Lösungen gehören nicht in öffentliche Antworten.
        entry_code_hash TEXT
          CHECK (entry_code_hash ~ '^[0-9a-f]{64}$'),
        answer_hash TEXT
          CHECK (answer_hash ~ '^[0-9a-f]{64}$'),
        earned_digit TEXT
          CHECK (earned_digit ~ '^[0-9]$'),
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (status IN ('DRAFT', 'PUBLISHED', 'DISABLED')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_slug, quest_key, station_key),
        UNIQUE (event_slug, quest_key, position),
        UNIQUE (entry_code_hash),
        FOREIGN KEY (event_slug, quest_key)
          REFERENCES alo_hunt_quests(event_slug, quest_key),
        CHECK (
          (
            area_latitude IS NULL
            AND area_longitude IS NULL
            AND area_radius_m IS NULL
          )
          OR (
            area_latitude IS NOT NULL
            AND area_longitude IS NOT NULL
            AND area_radius_m IS NOT NULL
          )
        ),
        CHECK (
          status <> 'PUBLISHED' OR (
            entry_code_hash IS NOT NULL
            AND answer_hash IS NOT NULL
            AND earned_digit IS NOT NULL
          )
        )
      );

      CREATE TABLE IF NOT EXISTS alo_hunt_hints (
        event_slug TEXT NOT NULL,
        quest_key TEXT NOT NULL,
        station_key TEXT NOT NULL,
        hint_key TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position > 0),
        kind TEXT NOT NULL CHECK (kind IN ('TEXT', 'IMAGE')),
        text_content TEXT,
        private_asset_key TEXT,
        release_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (status IN ('DRAFT', 'PUBLISHED', 'DISABLED')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_slug, quest_key, station_key, hint_key),
        UNIQUE (event_slug, quest_key, station_key, position),
        FOREIGN KEY (event_slug, quest_key, station_key)
          REFERENCES alo_hunt_stations(
            event_slug, quest_key, station_key
          ),
        CHECK (
          (kind = 'TEXT'
            AND text_content IS NOT NULL
            AND length(btrim(text_content)) > 0
            AND private_asset_key IS NULL)
          OR
          (kind = 'IMAGE'
            AND private_asset_key IS NOT NULL
            AND length(btrim(private_asset_key)) > 0)
        )
      );

      CREATE TABLE IF NOT EXISTS alo_hunt_station_progress (
        player_id UUID NOT NULL,
        event_slug TEXT NOT NULL,
        quest_key TEXT NOT NULL,
        station_key TEXT NOT NULL,
        discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (
          player_id, event_slug, quest_key, station_key
        ),
        FOREIGN KEY (player_id, event_slug)
          REFERENCES alo_hunt_players(id, event_slug)
          ON DELETE CASCADE,
        FOREIGN KEY (event_slug, quest_key, station_key)
          REFERENCES alo_hunt_stations(
            event_slug, quest_key, station_key
          ),
        CHECK (
          completed_at IS NULL
          OR completed_at >= discovered_at
        )
      );

      CREATE TABLE IF NOT EXISTS alo_hunt_cash_claims (
        event_slug TEXT NOT NULL,
        prize_key TEXT NOT NULL,
        player_id UUID NOT NULL,
        redemption_code_hash TEXT NOT NULL UNIQUE
          CHECK (redemption_code_hash ~ '^[0-9a-f]{64}$'),
        status TEXT NOT NULL DEFAULT 'RESERVED'
          CHECK (status IN ('RESERVED', 'REDEEMED', 'VOID')),
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        redeemed_at TIMESTAMPTZ,
        redeemed_by_staff_id BIGINT
          REFERENCES staff_users(id),
        PRIMARY KEY (event_slug, prize_key),
        FOREIGN KEY (event_slug, prize_key)
          REFERENCES alo_hunt_cash_prizes(event_slug, prize_key),
        FOREIGN KEY (player_id, event_slug)
          REFERENCES alo_hunt_players(id, event_slug),
        CHECK (
          (status = 'REDEEMED'
            AND redeemed_at IS NOT NULL
            AND redeemed_by_staff_id IS NOT NULL)
          OR
          (status <> 'REDEEMED'
            AND redeemed_at IS NULL
            AND redeemed_by_staff_id IS NULL)
        ),
        CHECK (
          redeemed_at IS NULL OR redeemed_at >= claimed_at
        )
      );

      CREATE INDEX IF NOT EXISTS alo_hunt_hints_release_idx
        ON alo_hunt_hints (
          event_slug, quest_key, station_key, release_at
        );

      CREATE INDEX IF NOT EXISTS alo_hunt_cash_claims_player_idx
        ON alo_hunt_cash_claims (player_id, event_slug);
    `);

    await client.query("COMMIT");
    return { ok: true, tablesPrepared: 5 };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
