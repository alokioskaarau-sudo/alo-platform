
import { db } from "./db.js";

/**
 * ALO NOW GPS schema.
 * Production-capable, disabled unless explicitly enabled.
 * No orders or payments are modified.
 */
export async function ensureAloNowGpsSchema(): Promise<void> {
  if (
    process.env.ALO_NOW_GPS_SCHEMA_ENABLED !== "true"
  ) {
    return;
  }

  await db.query(`
-- ALO NOW V138B
-- GPS sessions and latest driver locations.
-- STAGING REVIEW REQUIRED BEFORE EXECUTION.
-- This file is not run automatically.

BEGIN;

CREATE TABLE IF NOT EXISTS alo_now_gps_consents (
    delivery_id BIGINT PRIMARY KEY
        REFERENCES alo_now_deliveries(id)
        ON DELETE CASCADE,
    driver_user_id BIGINT NOT NULL,
    session_id UUID NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alo_now_driver_locations (
    delivery_id BIGINT PRIMARY KEY
        REFERENCES alo_now_deliveries(id)
        ON DELETE CASCADE,
    driver_user_id BIGINT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL
        CHECK (latitude BETWEEN 45 AND 48.5),
    longitude DOUBLE PRECISION NOT NULL
        CHECK (longitude BETWEEN 5 AND 11),
    accuracy_meters DOUBLE PRECISION NOT NULL
        CHECK (accuracy_meters BETWEEN 0 AND 150),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS
    alo_now_gps_consents_cleanup_idx
    ON alo_now_gps_consents (updated_at)
    WHERE enabled IS TRUE;

CREATE INDEX IF NOT EXISTS
    alo_now_driver_locations_cleanup_idx
    ON alo_now_driver_locations (received_at);

COMMIT;

  `);
}
