import { db } from "../../database/db.js";
import { hashHuntAccessCode } from "../../database/cityHuntPlayers.js";
import { HuntRegistrationError } from "./registration.js";

function sessionHash(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input)
  ) {
    throw new HuntRegistrationError("INVALID_SESSION");
  }
  return hashHuntAccessCode(input);
}

// Ausschliesslich der eigene Spielerpass.
// Keine Kontaktadresse oder Elternadresse in der Antwort.
export async function getHuntPlayerPass(sessionCode: unknown) {
  const hash = sessionHash(sessionCode);

  const result = await db.query(`
    SELECT
      p.id, p.alias, p.age_group, p.status,
      p.guardian_required,
      p.rules_version AS accepted_rules,
      p.privacy_version AS accepted_privacy,
      e.slug, e.title, e.city, e.base_address,
      e.status AS event_status,
      e.waitlist_open, e.registration_open, e.participant_capacity,
      e.starts_at > clock_timestamp() AS before_start,
      (
        e.starts_at <= clock_timestamp()
        AND e.ends_at > clock_timestamp()
      ) AS event_in_time,
      attendance.player_id IS NOT NULL AS participation_exists,
      attendance.withdrawn_at,
      (
        attendance.player_id IS NOT NULL
        AND attendance.withdrawn_at IS NULL
        AND attendance.confirmed_starts_at = e.starts_at
        AND attendance.confirmed_ends_at = e.ends_at
        AND attendance.rules_version = e.rules_version
        AND attendance.privacy_version = e.privacy_version
      ) AS participation_confirmed,
      e.starts_at, e.ends_at,
      e.rules_version AS current_rules,
      e.privacy_version AS current_privacy,
      (
        g.player_id IS NOT NULL
        AND g.withdrawn_at IS NULL
        AND g.declares_guardianship = TRUE
        AND g.approves_participation = TRUE
        AND g.rules_version = e.rules_version
        AND g.privacy_version = e.privacy_version
        AND (
          p.age_group <> 'UNDER_14'
          OR g.confirms_adult_companion = TRUE
        )
      ) AS guardian_approved
    FROM alo_hunt_player_tokens t
    JOIN alo_hunt_players p ON p.id = t.player_id
    JOIN alo_hunt_events e ON e.slug = p.event_slug
    LEFT JOIN alo_hunt_guardian_consents g ON g.player_id = p.id
    LEFT JOIN alo_hunt_participations attendance
      ON attendance.player_id = p.id
      AND attendance.event_slug = e.slug
    WHERE t.token_hash = $1
      AND t.purpose = 'SESSION'
      AND t.revoked_at IS NULL
      AND t.expires_at > clock_timestamp()
      AND p.contact_verified_at IS NOT NULL
      AND p.status IN ('PENDING_GUARDIAN', 'READY')
  `, [hash]);

  const row = result.rows[0];
  if (!row) throw new HuntRegistrationError("INVALID_SESSION");

  const documentsCurrent =
    typeof row.current_rules === "string" &&
    row.current_rules.trim().length > 0 &&
    typeof row.current_privacy === "string" &&
    row.current_privacy.trim().length > 0 &&
    row.accepted_rules === row.current_rules &&
    row.accepted_privacy === row.current_privacy;

  const guardianApproved =
    row.guardian_required !== true ||
    row.guardian_approved === true;

  const onboardingComplete =
    row.status === "READY" &&
    documentsCurrent &&
    guardianApproved;

  const phase =
    row.event_status === "DRAFT"
      ? "WAITLIST"
      : row.event_status === "REGISTRATION"
        ? "UPCOMING"
        : row.event_status;

  const participationConfirmed = row.participation_confirmed === true;
  const participationStatus =
    row.withdrawn_at != null ? "WITHDRAWN" :
    !row.starts_at || !row.ends_at ? "WAITING_DATE" :
    participationConfirmed ? "CONFIRMED" :
    row.participation_exists === true ? "NEEDS_RECONFIRMATION" :
    "NOT_CONFIRMED";

  const canConfirmParticipation =
    onboardingComplete &&
    row.event_status === "REGISTRATION" &&
    row.registration_open === true &&
    row.before_start === true &&
    Number.isInteger(row.participant_capacity) &&
    row.participant_capacity > 0 &&
    !participationConfirmed;

  const gameAccessAvailable =
    onboardingComplete &&
    participationConfirmed &&
    row.event_status === "LIVE" &&
    row.event_in_time === true;

  let message = "Deinen Anmeldestatus findest du hier.";
  if (row.event_status === "CANCELLED") {
    message = "Das Event wurde abgesagt.";
  } else if (row.event_status === "FINISHED") {
    message = "Das Event ist beendet.";
  } else if (!documentsCurrent) {
    message = "Die Teilnahmeunterlagen wurden aktualisiert.";
  } else if (!guardianApproved) {
    message = "Die Elternfreigabe steht noch aus.";
  } else if (phase === "WAITLIST") {
    message = "Du bist vorgemerkt. Termin und Platzbestätigung folgen.";
  } else if (phase === "UPCOMING") {
    message = participationConfirmed
      ? "Du bist dabei. Dein Platz für diesen Termin ist bestätigt."
      : participationStatus === "WITHDRAWN"
        ? "Du hast deine Teilnahme abgesagt."
        : participationStatus === "NEEDS_RECONFIRMATION"
          ? "Termin oder Unterlagen wurden geändert. Bitte bestätige erneut."
          : "Der Termin steht fest. Bestätige jetzt deinen Platz.";
    if (!participationConfirmed && !canConfirmParticipation) {
      message += " Die Platzbestätigung ist momentan nicht verfügbar.";
    }
  } else if (phase === "PAUSED") {
    message = "Das Spiel ist momentan pausiert.";
  } else if (phase === "LIVE") {
    message = gameAccessAvailable
      ? "Das Event läuft. Dein Spielerpass ist zum Mitspielen freigegeben."
      : participationStatus === "WITHDRAWN"
        ? "Du hast deine Teilnahme abgesagt."
        : !participationConfirmed
          ? "Für den aktuellen Termin fehlt deine Teilnahmebestätigung."
          : "Das Spiel ist ausserhalb seiner vorgesehenen Spielzeit.";
  }

  return {
    player: {
      id: row.id as string,
      alias: row.alias as string,
      ageGroup: row.age_group as string,
      status: row.status as string,
      guardianRequired: row.guardian_required as boolean,
      guardianApproved,
      documentsCurrent,
      onboardingComplete,
    },
    event: {
      slug: row.slug as string,
      title: row.title as string,
      city: row.city as string,
      baseAddress: row.base_address as string,
      phase,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      rulesVersion: row.current_rules,
      privacyVersion: row.current_privacy,
    },
    participation: {
      status: participationStatus,
      confirmed: participationConfirmed,
      canConfirm: canConfirmParticipation,
      canWithdraw:
        row.participation_exists === true && row.withdrawn_at == null,
    },
    // Persönliche Zugangsfreigabe; jede Quest prüft zusätzlich ihre Öffnung.
    gameAccessAvailable,
    message,
  };
}

// Widerruft nur diese Sitzung; der Wartelisteneintrag bleibt bestehen.
export async function logoutHuntPlayer(sessionCode: unknown) {
  const hash = sessionHash(sessionCode);
  await db.query(`
    UPDATE alo_hunt_player_tokens
    SET revoked_at = clock_timestamp()
    WHERE token_hash = $1
      AND purpose = 'SESSION'
      AND revoked_at IS NULL
  `, [hash]);
  return { ok: true };
}
