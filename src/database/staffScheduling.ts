import { db } from "./db.js";

export async function ensureStaffSchedulingTables() {

  // ALO_V51_SCHEDULE_SETTINGS
  // Dauerhafte, zentrale Einstellungen der Dienstplanung.
  // Mitarbeiter-Stundenstatistik ist standardmaessig AUS.
  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_schedule_settings (
      key TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    INSERT INTO staff_schedule_settings (key, enabled)
    VALUES ('show_employee_hours_statistics', FALSE)
    ON CONFLICT (key) DO NOTHING;
  `);


  // Erforderlich für den Ausschluss überlappender Schichten.
  // Ein Fehler darf nicht ignoriert werden.
  try {
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS btree_gist;
    `);
  } catch (error) {
    console.error(
      "ALO V51: PostgreSQL-Erweiterung btree_gist fehlt.",
      error
    );
    throw error;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_schedule_shifts (
      id BIGSERIAL PRIMARY KEY,
      staff_user_id BIGINT NOT NULL
        REFERENCES staff_users(id),
      workspace TEXT NOT NULL
        CHECK (workspace IN ('AARAU', 'OLTEN')),
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')),
      notes TEXT,
      created_by_user_id BIGINT NOT NULL
        REFERENCES staff_users(id),
      updated_by_user_id BIGINT
        REFERENCES staff_users(id),
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (ends_at > starts_at)
    );
  `);


  // Verhindert parallele Doppelbuchungen auf Datenbankebene.
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'staff_schedule_no_overlap'
      ) THEN
        ALTER TABLE staff_schedule_shifts
        ADD CONSTRAINT staff_schedule_no_overlap
        EXCLUDE USING gist (
          staff_user_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        )
        WHERE (status <> 'CANCELLED');
      END IF;
    END
    $$;
  `);


  // ALO_V51_SHIFT_PRESET_PERSISTENCE
  // Schichttyp und Uhrzeiten werden unabhängig gespeichert.
  // Bestehende Schichten erhalten CUSTOM.
  await db.query(`
    ALTER TABLE staff_schedule_shifts
    ADD COLUMN IF NOT EXISTS shift_preset TEXT
      NOT NULL DEFAULT 'CUSTOM';
  `);

  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'staff_schedule_shift_preset_check'
      ) THEN
        ALTER TABLE staff_schedule_shifts
        ADD CONSTRAINT staff_schedule_shift_preset_check
        CHECK (
          shift_preset IN (
            'EARLY',
            'LATE',
            'FULL',
            'CUSTOM'
          )
        );
      END IF;
    END
    $$;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_schedule_shifts_time_idx
    ON staff_schedule_shifts (starts_at, ends_at);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_schedule_shifts_user_idx
    ON staff_schedule_shifts (staff_user_id, starts_at);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_schedule_requests (
      id BIGSERIAL PRIMARY KEY,
      staff_user_id BIGINT NOT NULL
        REFERENCES staff_users(id),
      request_type TEXT NOT NULL
        CHECK (request_type IN ('VACATION', 'DAY_OFF', 'UNAVAILABLE')),
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
      reviewed_by_user_id BIGINT
        REFERENCES staff_users(id),
      reviewed_at TIMESTAMPTZ,
      review_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (ends_at > starts_at)
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      staff_schedule_requests_user_idx
    ON staff_schedule_requests (staff_user_id, starts_at);
  `);
}
