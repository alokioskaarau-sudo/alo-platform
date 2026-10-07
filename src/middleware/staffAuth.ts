import type {
  NextFunction,
  Request,
  Response,
} from "express";

import {
  createHash,
} from "node:crypto";

import {
  db,
} from "../database/db.js";


export type StaffRole =
  | "ADMIN"
  | "MANAGER"
  | "STAFF"
  | "PRAKTIKANT";


export type StaffWorkspace =
  | "AARAU"
  | "OLTEN"
  | "ONLINE";


export type StaffJob =
  | "admin"
  | "management"
  | "store_manager"
  | "sales"
  | "warehouse"
  | "online_shop"
  | "packing"
  | "live_team"
  | "driver";


export type AuthenticatedStaffUser = {
  id: string;
  username: string;
  displayName: string;

  role: StaffRole;
  jobKey: StaffJob;
  jobKeys: StaffJob[];

  defaultWorkspace: StaffWorkspace;
  allowedWorkspaces: StaffWorkspace[];

  permissions: string[];
  deniedPermissions: string[];

  profileNote: string | null;
  avatarUrl: string | null;

  active: boolean;

  approvedAt: string | null;
  approvedBy: string | null;
};


function stringArray(
  value: unknown
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) =>
      String(item).trim()
    )
    .filter(Boolean);
}


function hashToken(
  token: string
): string {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}


function bearerToken(
  req: Request
): string {
  const authorization =
    req.get("Authorization");

  if (
    !authorization ||
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    return "";
  }

  return authorization
    .slice(7)
    .trim();
}


export async function requireStaffAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const token =
      bearerToken(req);

    if (!token) {
      return res
        .status(401)
        .json({
          ok: false,
          error: "Unauthorized",
        });
    }

    const tokenHash =
      hashToken(token);

    const result =
      await db.query(
        `
          SELECT
            s.id AS session_id,
            s.staff_user_id,

            u.username,
            u.display_name,
            u.role,

            u.job_key,
            u.job_keys,

            u.default_workspace,
            u.allowed_workspaces,

            u.permissions,
            u.denied_permissions,

            u.profile_note,
            u.avatar_url,

            u.active,

            u.approved_at,
            u.approved_by

          FROM staff_sessions s

          INNER JOIN staff_users u
            ON u.id = s.staff_user_id

          WHERE
            s.token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > NOW()
            AND u.active = TRUE

          LIMIT 1
        `,
        [tokenHash]
      );

    if (
      result.rows.length === 0
    ) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            "Session ungültig oder abgelaufen.",
        });
    }

    const row =
      result.rows[0];

    const allowedWorkspaces =
      stringArray(
        row.allowed_workspaces
      ) as StaffWorkspace[];

    const staffUser:
      AuthenticatedStaffUser = {

        id:
          String(
            row.staff_user_id
          ),

        username:
          String(row.username),

        displayName:
          String(row.display_name),

        role:
          row.role as StaffRole,

        jobKey:
          String(
            row.job_key || "sales"
          ) as StaffJob,

        jobKeys:
          Array.from(
            new Set(
              (
                stringArray(
                  row.job_keys
                ).length > 0
                  ? stringArray(
                      row.job_keys
                    )
                  : [
                      String(
                        row.job_key ||
                        "sales"
                      ),
                    ]
              )
                .filter(
                  (value) =>
                    value !== "admin" ||
                    row.role === "ADMIN"
                )
            )
          ) as StaffJob[],

        defaultWorkspace:
          row.default_workspace as StaffWorkspace,

        allowedWorkspaces,

        permissions:
          stringArray(
            row.permissions
          ),

        deniedPermissions:
          stringArray(
            row.denied_permissions
          ),

        profileNote:
          row.profile_note == null
            ? null
            : String(
                row.profile_note
              ),

        avatarUrl:
          row.avatar_url == null
            ? null
            : String(
                row.avatar_url
              ),

        active:
          Boolean(row.active),

        approvedAt:
          row.approved_at == null
            ? null
            : String(
                row.approved_at
              ),

        approvedBy:
          row.approved_by == null
            ? null
            : String(
                row.approved_by
              ),
      };

    res.locals.staffUser =
      staffUser;

    res.locals.staffSessionId =
      String(row.session_id);

    await db.query(
      `
        UPDATE staff_sessions
        SET last_seen_at = NOW()
        WHERE id = $1
      `,
      [row.session_id]
    );

    return next();

  } catch (error) {

    console.error(
      "STAFF AUTH ERROR",
      error
    );

    return res
      .status(500)
      .json({
        ok: false,
        error:
          "Staff-Authentifizierung fehlgeschlagen.",
      });
  }
}


export function getStaffUser(
  res: Response
): AuthenticatedStaffUser {
  return res.locals
    .staffUser as
    AuthenticatedStaffUser;
}

