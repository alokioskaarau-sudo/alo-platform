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

const JOB_CAPABILITIES:
  Partial<
    Record<
      AuthenticatedStaffUser["jobKey"],
      ReadonlySet<string>
    >
  > = {
    admin:
      new Set(STAFF_CAPABILITIES),

    management:
      new Set([
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

    store_manager:
      new Set([
        "dashboard.view",
        "orders.view",
        "orders.pack",
        "orders.manage",
        "orders.reprint",
        "products.view",
        "products.edit",
        "inventory.view",
        "inventory.adjust",
        "inventory.receive",
        "live.view",
        "live.use",
        "tasks.view",
        "tasks.manage",
        "delivery.view",
        "analytics.view",
        "staff.view",
      ]),

    sales:
      new Set([
        "dashboard.view",
        "orders.view",
        "orders.pack",
        "products.view",
        "inventory.view",
        "inventory.adjust",
        "inventory.receive",
        "live.view",
        "tasks.view",
        "delivery.view",
      ]),

    warehouse:
      new Set([
        "dashboard.view",
        "orders.view",
        "orders.pack",
        "orders.manage",
        "orders.reprint",
        "products.view",
        "products.edit",
        "inventory.view",
        "inventory.adjust",
        "inventory.receive",
        "tasks.view",
      ]),

    online_shop:
      new Set([
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
        "tasks.view",
        "analytics.view",
        "delivery.view",
      ]),

    packing:
      new Set([
        "dashboard.view",
        "orders.view",
        "orders.pack",
        "orders.reprint",
        "products.view",
        "inventory.view",
        "tasks.view",
      ]),

    live_team:
      new Set([
        "dashboard.view",
        "orders.view",
        "orders.pack",
        "products.view",
        "inventory.view",
        "live.view",
        "live.use",
        "tasks.view",
      ]),

    driver:
      new Set([
        "dashboard.view",
        "tasks.view",
        "delivery.view",
        "delivery.use",
      ]),
  };


/*
 * Compatibility aliases.
 *
 * Die App verwendet bereits die neue ALO-OS-Namenswelt,
 * ältere Backend-Routen teilweise noch die bisherigen Namen.
 * Beide müssen während der Migration dieselbe Berechtigung meinen.
 */
const CAPABILITY_ALIASES:
  Record<string, string[]> = {
    "stock.view": [
      "inventory.view",
    ],
    "stock.adjust": [
      "inventory.adjust",
    ],
    "stock.receive": [
      "inventory.receive",
      "receiving.use",
    ],

    "inventory.view": [
      "stock.view",
    ],
    "inventory.adjust": [
      "stock.adjust",
    ],
    "inventory.receive": [
      "stock.receive",
      "receiving.use",
    ],
    "receiving.use": [
      "inventory.receive",
      "stock.receive",
    ],

    "alo_now.view": [
      "delivery.view",
    ],
    "alo_now.drive": [
      "delivery.use",
    ],
    "alo_now.manage": [
      "delivery.manage",
    ],

    "delivery.view": [
      "alo_now.view",
    ],
    "delivery.use": [
      "alo_now.drive",
    ],
    "delivery.manage": [
      "alo_now.manage",
    ],

    "orders.status": [
      "orders.manage",
    ],
    "orders.manage": [
      "orders.status",
    ],

    "live.manage": [
      "live.use",
    ],
    "live.use": [
      "live.manage",
    ],

    "admin.staff": [
      "staff.manage",
    ],
    "staff.manage": [
      "admin.staff",
    ],

    "admin.settings": [
      "settings.manage",
    ],
    "settings.manage": [
      "admin.settings",
    ],
  };

function capabilityNames(
  capability: string
): string[] {
  return Array.from(
    new Set([
      capability,
      ...(
        CAPABILITY_ALIASES[
          capability
        ] ?? []
      ),
    ])
  );
}


export function effectiveStaffCapabilities(
  user: Pick<
    AuthenticatedStaffUser,
    | "role"
    | "jobKey"
    | "jobKeys"
    | "permissions"
    | "deniedPermissions"
  >
): Set<string> {

  /*
   * ADMIN bleibt uneingeschränkt.
   */
  if (
    user.role === "ADMIN"
  ) {
    return new Set([
      ...STAFF_CAPABILITIES,
      ...(user.permissions ?? []),
    ]);
  }

  const jobs =
    Array.from(
      new Set(
        (
          user.jobKeys?.length
            ? user.jobKeys
            : [user.jobKey]
        ).filter(
          (job) =>
            job !== "admin"
        )
      )
    );

  const effective =
    new Set<string>();

  for (const job of jobs) {
    const jobCapabilities =
      JOB_CAPABILITIES[job];

    if (!jobCapabilities) {
      continue;
    }

    for (
      const capability of
      jobCapabilities
    ) {
      effective.add(capability);
    }
  }

  /*
   * Legacy/fallback safety:
   * Falls kein gültiger Job vorhanden ist,
   * verwenden wir weiterhin die Rollen-Baseline.
   */
  if (effective.size === 0) {
    const roleCapabilities =
      ROLE_CAPABILITIES[
        user.role
      ] ??
      new Set<string>();

    for (
      const capability of
      roleCapabilities
    ) {
      effective.add(capability);
    }
  }

  for (
    const permission of
    user.permissions ?? []
  ) {
    effective.add(permission);
  }

  /*
   * Deny gewinnt immer.
   * Auch Alias-Namen werden entfernt.
   */
  for (
    const denied of
      user.deniedPermissions ?? []
  ) {
    for (
      const name of
        capabilityNames(denied)
    ) {
      effective.delete(name);
    }
  }

  return effective;
}


export function hasStaffCapability(
  user: Pick<
    AuthenticatedStaffUser,
    | "role"
    | "jobKey"
    | "jobKeys"
    | "permissions"
    | "deniedPermissions"
  >,
  capability: StaffCapability | string
): boolean {

  if (
    user.role === "ADMIN"
  ) {
    return true;
  }

  const effective =
    effectiveStaffCapabilities(
      user
    );

  return capabilityNames(
    capability
  ).some(
    (name) =>
      effective.has(name)
  );
}


export function hasEveryStaffCapability(
  user: Pick<
    AuthenticatedStaffUser,
    | "role"
    | "jobKey"
    | "jobKeys"
    | "permissions"
    | "deniedPermissions"
  >,
  capabilities:
    Array<StaffCapability | string>
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
    | "role"
    | "jobKey"
    | "jobKeys"
    | "permissions"
    | "deniedPermissions"
  >,
  capabilities:
    Array<StaffCapability | string>
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
