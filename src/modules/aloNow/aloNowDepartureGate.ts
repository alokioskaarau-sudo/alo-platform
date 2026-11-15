/**
 * ALO NOW – Departure Gate V1.
 *
 * Pure business rules; no database, Shopify or network actions.
 * This module is NOT yet wired to production dispatch.
 */

import {
  evaluateAloNowDispatch,
  type AloNowVehicle,
  type AloNowLoadClass,
} from "./aloNowVehiclePolicy.js";

export type DepartureInput = {
  accepted: boolean;
  driverApproved: boolean;
  driverOnline: boolean;
  paymentMethod: "ONLINE" | "CASH";
  paymentStatus:
    | "PENDING"
    | "PAID"
    | "CASH_AGREED"
    | "FAILED";
  packStatus:
    | "NEW"
    | "PACKING"
    | "PACKED"
    | "READY_TO_SHIP"
    | "COMPLETED";
  vehicle: AloNowVehicle | null;
  roadDistanceKm: number | null;
  loadClass: AloNowLoadClass;
  manualDistanceApproved: boolean;
  remainingDriverCapacity: number;
};

export type DepartureDecision = {
  allowed: boolean;
  reasons: string[];
};

export function evaluateAloNowDeparture(
  input: DepartureInput
): DepartureDecision {
  const reasons: string[] = [];

  if (!input.accepted) {
    reasons.push("ORDER_NOT_ACCEPTED");
  }
  if (!input.driverApproved || !input.driverOnline) {
    reasons.push("DRIVER_NOT_AVAILABLE");
  }

  if (input.paymentMethod === "ONLINE") {
    if (input.paymentStatus !== "PAID") {
      reasons.push("PAYMENT_NOT_CONFIRMED");
    }
  } else if (input.paymentMethod === "CASH") {
    if (input.paymentStatus !== "CASH_AGREED") {
      reasons.push("CASH_NOT_CONFIRMED");
    }
  } else {
    reasons.push("UNKNOWN_PAYMENT_METHOD");
  }

  if (input.packStatus !== "PACKED") {
    reasons.push("ORDER_NOT_PACKED");
  }

  if (
    !Number.isInteger(input.remainingDriverCapacity) ||
    input.remainingDriverCapacity < 1
  ) {
    reasons.push("NO_DRIVER_CAPACITY");
  }

  const vehicleDecision = evaluateAloNowDispatch({
    vehicle: input.vehicle,
    roadDistanceKm: input.roadDistanceKm,
    loadClass: input.loadClass,
    standardRadiusKm: 12,
  });

  if (!vehicleDecision.eligible) {
    // Review is necessary but not sufficient:
    // exceeding 12km or unknown load/route must
    // never be silently converted to approval.
    reasons.push(
      "VEHICLE_OR_ROUTE_REVIEW_REQUIRED:" +
      vehicleDecision.reason
    );
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
