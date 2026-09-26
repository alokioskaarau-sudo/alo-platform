import type {
  NextFunction,
  Request,
  Response,
} from "express";

import {
  getStaffUser,
  type AuthenticatedStaffUser,
  type StaffRole,
} from "./staffAuth.js";

/*
 * ============================================================
 * ALO STAFF RBAC
 * ============================================================
 *
 * Rollen beschreiben die organisatorische Stellung.
 * Capabilities beschreiben konkrete Berechtigungen.
 *
 * Wichtig:
 * - UI-Sichtbarkeit ist KEINE Security.
 * - Geschützte API-Routen müssen serverseitig prüfen.
 * - ADMIN besitzt immer alle Capabilities.
 * - Später können wir individuelle Overrides aus der DB ergänzen,
 *   ohne die Route-API erneut ändern zu müssen.
 */

export const STAFF_CAPABILITIES = [
  "dashboard.view",

  "orders.view",
  "orders.pack",
  "orders.manage",
  "orders.reprint",

  "products.view",
  "products.create",
  "products.edit",

  "inventory.view",
  "inventory.adjust",
  "inventory.receive",

  "live.view",
  "live.use",

  "tasks.view",
  "tasks.manage",

  "delivery.view",
  "delivery.use",
  "delivery.manage",

  "analytics.view",

  "staff.view",
  "staff.manage",

  "settings.view",
  "settings.manage",
] as const;

export type StaffCapability =
  typeof STAFF_CAPABILITIES[number];

const ALL_CAPABILITIES =
  new Set<StaffCapability>(
    STAFF_CAPABILITIES
  );

/*
 * Baseline-Rechte pro organisatorischer Rolle.
 *
 * Individuelle Mitarbeiterrechte kommen später als Override
 * darüber. Dadurch brauchen wir keine Rollen wie STREAMER,
 * PACKER, WAREHOUSE usw.
 */
const ROLE_CAPABILITIES:
  Record<
    StaffRole,
    ReadonlySet<StaffCapability>
  > = {
    ADMIN:
      ALL_CAPABILITIES,

    MANAGER:
      new Set<StaffCapability>([
        "dashboard.view",

        "orders.view",
        "orders.pack",
        "orders.manage",
        "orders.reprint",

        "products.view",
        "products.create",
        "products.edit",

        "inventory.view",
        "inventory.adjust",
        "inventory.receive",

        "live.view",
        "live.use",

        "tasks.view",
        "tasks.manage",

        "delivery.view",
        "delivery.use",
        "delivery.manage",

        "analytics.view",

        "staff.view",
        "staff.manage",

        "settings.view",
      ]),

    STAFF:
      new Set<StaffCapability>([
        "dashboard.view",

        "orders.view",
        "orders.pack",

        "products.view",

        "inventory.view",
        "inventory.receive",

        "live.view",
        "live.use",

        "tasks.view",

        "delivery.view",
        "delivery.use",
      ]),

    PRAKTIKANT:
      new Set<StaffCapability>([
        "dashboard.view",

        "orders.view",

        "products.view",

        "inventory.view",

        "tasks.view",
      ]),
  };

export function capabilitiesForRole(
  role: StaffRole
): StaffCapability[] {
  return [
    ...(
      ROLE_CAPABILITIES[role] ??
      new Set<StaffCapability>()
    ),
  ];
}

export function hasStaffCapability(
  user: Pick<
    AuthenticatedStaffUser,
    "role"
  >,
  capability: StaffCapability
): boolean {
  if (user.role === "ADMIN") {
    return true;
  }

  return (
    ROLE_CAPABILITIES[user.role]
      ?.has(capability) ??
    false
  );
}

export function hasEveryStaffCapability(
  user: Pick<
    AuthenticatedStaffUser,
    "role"
  >,
  capabilities: StaffCapability[]
): boolean {
  return capabilities.every(
    (capability) =>
      hasStaffCapability(
        user,
        capability
      )
  );
}

export function hasAnyStaffCapability(
  user: Pick<
    AuthenticatedStaffUser,
    "role"
  >,
  capabilities: StaffCapability[]
): boolean {
  return capabilities.some(
    (capability) =>
      hasStaffCapability(
        user,
        capability
      )
  );
}

export function requireStaffCapability(
  capability: StaffCapability
) {
  return (
    _req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const user =
      getStaffUser(res);

    if (
      !hasStaffCapability(
        user,
        capability
      )
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "Keine Berechtigung für diese Funktion.",
        code:
          "STAFF_PERMISSION_DENIED",
        requiredCapability:
          capability,
      });
    }

    return next();
  };
}

export function requireEveryStaffCapability(
  ...capabilities: StaffCapability[]
) {
  return (
    _req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const user =
      getStaffUser(res);

    if (
      !hasEveryStaffCapability(
        user,
        capabilities
      )
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "Keine Berechtigung für diese Funktion.",
        code:
          "STAFF_PERMISSION_DENIED",
        requiredCapabilities:
          capabilities,
      });
    }

    return next();
  };
}

export function requireAnyStaffCapability(
  ...capabilities: StaffCapability[]
) {
  return (
    _req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const user =
      getStaffUser(res);

    if (
      !hasAnyStaffCapability(
        user,
        capabilities
      )
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "Keine Berechtigung für diese Funktion.",
        code:
          "STAFF_PERMISSION_DENIED",
        requiredCapabilities:
          capabilities,
      });
    }

    return next();
  };
}
