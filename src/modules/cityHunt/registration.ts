import { canRegisterForHunt } from "./availability.js";
import { randomUUID } from "node:crypto";
import { db } from "../../database/db.js";
import { createHuntAccessCode } from "../../database/cityHuntPlayers.js";

export class HuntRegistrationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "HuntRegistrationError";
  }
}

export type HuntAgeGroup = "UNDER_14" | "14_17" | "ADULT";

export function validateHuntRegistration(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HuntRegistrationError("INVALID_INPUT");
  }

  const value = input as Record<string, unknown>;

  function field(name: string, max: number): string {
    const item = value[name];
    if (typeof item !== "string" || item.length > max) {
      throw new HuntRegistrationError("INVALID_" + name.toUpperCase());
    }
    return item.trim();
  }

  const alias = field("alias", 24);
  if (!/^[A-Za-z0-9_-]{3,24}$/.test(alias)) {
    throw new HuntRegistrationError("INVALID_ALIAS");
  }

  const contactEmail = field("contactEmail", 254).toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) ||
    /[\r\n]/.test(contactEmail)
  ) {
    throw new HuntRegistrationError("INVALID_EMAIL");
  }

  const ageGroup = field("ageGroup", 20);
  if (!["UNDER_14", "14_17", "ADULT"].includes(ageGroup)) {
    throw new HuntRegistrationError("INVALID_AGE_GROUP");
  }

  if (
    value.acceptRules !== true ||
    value.acknowledgePrivacy !== true
  ) {
    throw new HuntRegistrationError("ACKNOWLEDGEMENT_REQUIRED");
  }

  const rulesVersion = field("rulesVersion", 100);
  const privacyVersion = field("privacyVersion", 100);
  if (!rulesVersion || !privacyVersion) {
    throw new HuntRegistrationError("DOCUMENT_VERSION_REQUIRED");
  }

  return {
    alias,
    contactEmail,
    ageGroup: ageGroup as HuntAgeGroup,
    rulesVersion,
    privacyVersion,
  };
}

// Interner Dienst. Noch nicht an eine öffentliche Route angeschlossen.
// Der rohe Bestätigungscode darf nur an den Mailversand weitergegeben werden.
export async function createPendingHuntPlayer(
  eventSlug: string,
  input: unknown
) {
  const data = validateHuntRegistration(input);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const eventResult = await client.query(`
      SELECT
        status, registration_open, waitlist_open,
        starts_at, ends_at,
        rules_version, privacy_version,
        starts_at > NOW() AS before_start
      FROM alo_hunt_events
      WHERE slug = $1
      FOR UPDATE
    `, [eventSlug]);

    const event = eventResult.rows[0];
    if (
      !event ||
      !canRegisterForHunt({
        status: event.status,
        registrationOpen: event.registration_open,
        waitlistOpen: event.waitlist_open,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        beforeStart: event.before_start,
        rulesVersion: event.rules_version,
        privacyVersion: event.privacy_version,
      })
    ) {
      throw new HuntRegistrationError("REGISTRATION_CLOSED");
    }

    if (
      data.rulesVersion !== event.rules_version ||
      data.privacyVersion !== event.privacy_version
    ) {
      throw new HuntRegistrationError("DOCUMENTS_CHANGED");
    }

    const id = randomUUID();
    const verification = createHuntAccessCode();

    await client.query(`
      INSERT INTO alo_hunt_players (
        id, event_slug, alias, age_group,
        contact_email, guardian_required,
        rules_version, privacy_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      id, eventSlug, data.alias, data.ageGroup,
      data.contactEmail, data.ageGroup !== "ADULT",
      event.rules_version, event.privacy_version,
    ]);

    await client.query(`
      INSERT INTO alo_hunt_player_tokens (
        token_hash, player_id, purpose, expires_at
      ) VALUES (
        $1, $2, 'VERIFY_CONTACT', NOW() + INTERVAL '30 minutes'
      )
    `, [verification.hash, id]);

    await client.query("COMMIT");

    return {
      playerId: id,
      status: "PENDING_CONTACT" as const,
      // Ausschliesslich für den internen Mailversand:
      delivery: {
        recipient: data.contactEmail,
        verificationCode: verification.code,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
