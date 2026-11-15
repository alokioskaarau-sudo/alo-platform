// ALO_NOW_V1623_AGE_DECISION
// Pure decision logic. No DB, Shopify or external calls.
// Driver must physically inspect the document.
// Birth date must never be written to an audit log.

export type AgeRequirementV1623 =
  "NONE" | "AGE_16" | "AGE_18";

export type AgeDecisionV1623 =
  | {allowed: true; status: "VERIFIED"; ageLevel: 16 | 18}
  | {allowed: true; status: "NOT_REQUIRED"; ageLevel: 0}
  | {
      allowed: false;
      status:
        | "ID_CHECK_FAILED"
        | "INVALID_DATE"
        | "UNDERAGE";
      ageLevel: 0;
    };

function parseDate(value: string): Date | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) return null;

  const [y, m, d] = value.split("-").map(Number);

  if (y < 1900 || y > 9999) return null;

  const parsed = new Date(Date.UTC(y, m - 1, d));

  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) return null;

  return parsed;
}

export function decideAgeAtHandoffV1623(input: {
  requirement: AgeRequirementV1623;
  birthDate: string;
  todaySwissDate: string;
  originalDocumentChecked: boolean;
  identityMatchesRecipient: boolean;
  documentValid: boolean;
}): AgeDecisionV1623 {
  if (!input || ![
    "NONE", "AGE_16", "AGE_18"
  ].includes(input.requirement)) {
    throw new Error("INVALID_AGE_REQUIREMENT");
  }

  if (input.requirement === "NONE") {
    return {
      allowed: true,
      status: "NOT_REQUIRED",
      ageLevel: 0,
    };
  }

  if (
    input.originalDocumentChecked !== true ||
    input.identityMatchesRecipient !== true ||
    input.documentValid !== true
  ) {
    return {
      allowed: false,
      status: "ID_CHECK_FAILED",
      ageLevel: 0,
    };
  }

  const birth = parseDate(input.birthDate);
  const today = parseDate(input.todaySwissDate);

  if (!birth || !today || birth > today) {
    return {
      allowed: false,
      status: "INVALID_DATE",
      ageLevel: 0,
    };
  }

  let age =
    today.getUTCFullYear() - birth.getUTCFullYear();

  if (
    today.getUTCMonth() < birth.getUTCMonth() ||
    (
      today.getUTCMonth() === birth.getUTCMonth() &&
      today.getUTCDate() < birth.getUTCDate()
    )
  ) age--;

  const minimum =
    input.requirement === "AGE_18" ? 18 : 16;

  if (age < minimum || age > 125) {
    return {
      allowed: false,
      status: "UNDERAGE",
      ageLevel: 0,
    };
  }

  return {
    allowed: true,
    status: "VERIFIED",
    ageLevel: minimum,
  };
}
