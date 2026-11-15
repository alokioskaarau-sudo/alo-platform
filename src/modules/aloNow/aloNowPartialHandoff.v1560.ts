// ALO_V1561_AGE_AWARE_PARTIAL_HANDOFF
// Pure domain logic. No external writes.

export type AgeClass =
  | "NONE"
  | "AGE_16"
  | "AGE_18"
  | "UNKNOWN";

export type HandoffLine = {
  lineItemId: string;
  quantity: number;
  ageClass: AgeClass;
};

export type HandoffPlan = {
  delivered: Array<{lineItemId: string; quantity: number}>;
  withheld: Array<{lineItemId: string; quantity: number}>;
  partial: boolean;
  blocked: boolean;
  verifiedAgeLevel: 0 | 16 | 18;
};

export function planAloNowHandoffV1561(
  lines: HandoffLine[],
  verifiedAgeLevel: 0 | 16 | 18
): HandoffPlan {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("EMPTY_ORDER_LINES");
  }

  if (![0, 16, 18].includes(verifiedAgeLevel)) {
    throw new Error("INVALID_VERIFIED_AGE_LEVEL");
  }

  const seen = new Set<string>();
  const delivered: HandoffPlan["delivered"] = [];
  const withheld: HandoffPlan["withheld"] = [];

  for (const line of lines) {
    const id = line.lineItemId?.trim();

    if (!id || seen.has(id)) {
      throw new Error("INVALID_OR_DUPLICATE_LINE_ID");
    }

    seen.add(id);

    if (!Number.isSafeInteger(line.quantity) ||
        line.quantity < 1) {
      throw new Error("INVALID_LINE_QUANTITY");
    }

    if (!["NONE","AGE_16","AGE_18","UNKNOWN"]
        .includes(line.ageClass)) {
      throw new Error("INVALID_AGE_CLASS");
    }

    const item = {
      lineItemId: id,
      quantity: line.quantity,
    };

    const allowed =
      line.ageClass === "NONE" ||
      (line.ageClass === "AGE_16" &&
       verifiedAgeLevel >= 16) ||
      (line.ageClass === "AGE_18" &&
       verifiedAgeLevel >= 18);

    if (allowed) {
      delivered.push(item);
    } else {
      withheld.push(item);
    }
  }

  return {
    delivered,
    withheld,
    partial:
      delivered.length > 0 &&
      withheld.length > 0,
    blocked: delivered.length === 0,
    verifiedAgeLevel,
  };
}
