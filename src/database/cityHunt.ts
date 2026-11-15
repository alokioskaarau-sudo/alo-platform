import { db } from "./db.js";
import { cityHuntEvent } from "../modules/cityHunt/event.js";

// Bewusst NICHT beim Serverstart aufgerufen.
// Erst nach Prüfung führen wir diese Vorbereitung ausdrücklich aus.
export async function initializeCityHuntDatabase() {
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [10611001]
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS alo_hunt_events (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        city TEXT NOT NULL,
        base_address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (status IN (
            'DRAFT', 'REGISTRATION', 'LIVE',
            'PAUSED', 'FINISHED', 'CANCELLED'
          )),
        registration_open BOOLEAN NOT NULL DEFAULT FALSE,
        starts_at TIMESTAMPTZ,
        ends_at TIMESTAMPTZ,
        rules_version TEXT,
        privacy_version TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          ends_at IS NULL OR starts_at IS NULL
          OR ends_at > starts_at
        ),
        CHECK (
          NOT registration_open OR (
            status = 'REGISTRATION'
            AND starts_at IS NOT NULL
            AND ends_at IS NOT NULL
            AND rules_version IS NOT NULL
            AND privacy_version IS NOT NULL
          )
        )
      );

      CREATE TABLE IF NOT EXISTS alo_hunt_cash_prizes (
        event_slug TEXT NOT NULL
          REFERENCES alo_hunt_events(slug),
        prize_key TEXT NOT NULL,
        tier TEXT NOT NULL
          CHECK (tier IN ('main', 'silver', 'mini')),
        amount_rappen INTEGER NOT NULL
          CHECK (amount_rappen > 0),
        status TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (status IN (
            'DRAFT', 'AVAILABLE', 'CLAIMED',
            'REDEEMED', 'VOID'
          )),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_slug, prize_key)
      );
    `);

    await client.query(`
      INSERT INTO alo_hunt_events (
        slug, title, city, base_address
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (slug) DO NOTHING
    `, [
      cityHuntEvent.slug,
      cityHuntEvent.title,
      cityHuntEvent.city,
      cityHuntEvent.baseAddress,
    ]);

    for (const tier of cityHuntEvent.cashPrizes) {
      for (let number = 1; number <= tier.count; number++) {
        await client.query(`
          INSERT INTO alo_hunt_cash_prizes (
            event_slug, prize_key, tier, amount_rappen
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT (event_slug, prize_key) DO NOTHING
        `, [
          cityHuntEvent.slug,
          `${tier.key}-${number}`,
          tier.key,
          tier.amountRappen,
        ]);
      }
    }

    const result = await client.query(`
      SELECT
        COUNT(*)::INTEGER AS count,
        COALESCE(SUM(amount_rappen), 0)::INTEGER AS total
      FROM alo_hunt_cash_prizes
      WHERE event_slug = $1
    `, [cityHuntEvent.slug]);

    if (
      result.rows[0]?.count !== 14 ||
      result.rows[0]?.total !== 50000
    ) {
      throw new Error(
        "City Hunt: gespeicherter Preisplan weicht von CHF 500 / 14 Preisen ab."
      );
    }

    await client.query("COMMIT");
    return { prizeCount: 14, cashBudgetRappen: 50000 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
