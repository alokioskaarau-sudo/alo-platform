/**
 * ALO NOW V1819 - versioned commission consistency check.
 *
 * Pure validation, no DB, no Shopify, no booking, no payout.
 * Inputs are NOT independently authenticated by this module.
 * A match alone never creates earnings entitlement.
 */

import {
  calculateCommissionRappen
} from "./aloNowDriverFinance.v841.js";

export type CommissionCheckInputV1819 = {
  orderId: string;
  driverUserId: string;
  workspace: "AARAU" | "OLTEN";
  tariffVersion: string;
  tariffEffectiveFrom: string;
  deliveryCompletedAt: string;
  distanceMetres: number;
  baseRappen: number;
  rappenPerKm: number;
  capRappen: number;
  bookedCommissionRappen: number;
};

export type CommissionCheckResultV1819 = {
  status:
    | "BLOCKED"
    | "MATCHED_SOURCE_VERIFICATION_PENDING";
  arithmeticMatched: boolean;
  sourceVerified: false;
  earningsAuthorized: false;
  payoutEnabled: false;
  payableOutstandingRappen: null;
};

const ORDER = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const DRIVER = /^[1-9][0-9]{0,18}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function blocked(): CommissionCheckResultV1819 {
  return {
    status: "BLOCKED",
    arithmeticMatched: false,
    sourceVerified: false,
    earningsAuthorized: false,
    payoutEnabled: false,
    payableOutstandingRappen: null
  };
}

function validIso(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value;
}

export function checkCommissionV1819(
  input: CommissionCheckInputV1819
): CommissionCheckResultV1819 {
  if (
    !input ||
    !ORDER.test(input.orderId) ||
    !DRIVER.test(input.driverUserId) ||
    !["AARAU", "OLTEN"].includes(input.workspace) ||
    !VERSION.test(input.tariffVersion) ||
    !validIso(input.tariffEffectiveFrom) ||
    !validIso(input.deliveryCompletedAt) ||
    Date.parse(input.tariffEffectiveFrom) >
      Date.parse(input.deliveryCompletedAt) ||
    !Number.isSafeInteger(input.distanceMetres) ||
    input.distanceMetres <= 0 ||
    ![
      input.baseRappen,
      input.rappenPerKm,
      input.capRappen,
      input.bookedCommissionRappen
    ].every(v => Number.isSafeInteger(v) && v >= 0) ||
    input.capRappen < input.baseRappen ||
    input.bookedCommissionRappen <= 0
  ) {
    return blocked();
  }

  try {
    const expected = calculateCommissionRappen(
      input.distanceMetres,
      input.baseRappen,
      input.rappenPerKm,
      input.capRappen
    );

    if (
      !Number.isSafeInteger(expected) ||
      expected <= 0 ||
      expected !== input.bookedCommissionRappen
    ) {
      return blocked();
    }

    // Arithmetic match != authenticated tariff/distance/event.
    return {
      status: "MATCHED_SOURCE_VERIFICATION_PENDING",
      arithmeticMatched: true,
      sourceVerified: false,
      earningsAuthorized: false,
      payoutEnabled: false,
      payableOutstandingRappen: null
    };
  } catch {
    return blocked();
  }
}
