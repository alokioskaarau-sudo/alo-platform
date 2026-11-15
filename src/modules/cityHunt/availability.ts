type HuntEventAvailability = {
  status: string;
  registrationOpen: boolean;
  waitlistOpen: boolean;
  startsAt: unknown;
  endsAt: unknown;
  beforeStart?: boolean;
  notEnded?: boolean;
  rulesVersion: unknown;
  privacyVersion: unknown;
};

function hasDocuments(event: HuntEventAvailability): boolean {
  return (
    typeof event.rulesVersion === "string" &&
    event.rulesVersion.trim().length > 0 &&
    typeof event.privacyVersion === "string" &&
    event.privacyVersion.trim().length > 0
  );
}

export function isHuntWaitlistAvailable(
  event: HuntEventAvailability
): boolean {
  return (
    hasDocuments(event) &&
    event.status === "DRAFT" &&
    event.waitlistOpen === true &&
    event.registrationOpen === false &&
    event.startsAt == null &&
    event.endsAt == null
  );
}

export function canRegisterForHunt(
  event: HuntEventAvailability
): boolean {
  return (
    isHuntWaitlistAvailable(event) ||
    (
      hasDocuments(event) &&
      event.status === "REGISTRATION" &&
      event.registrationOpen === true &&
      event.startsAt != null &&
      event.endsAt != null &&
      event.beforeStart === true
    )
  );
}

export function canCompleteHuntOnboarding(
  event: HuntEventAvailability
): boolean {
  return (
    isHuntWaitlistAvailable(event) ||
    (
      hasDocuments(event) &&
      ["REGISTRATION", "LIVE"].includes(event.status) &&
      event.startsAt != null &&
      event.endsAt != null &&
      event.notEnded === true
    )
  );
}
