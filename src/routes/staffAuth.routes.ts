import {
  Router,
} from "express";

import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

import {
  promisify,
} from "node:util";

import {
  db,
} from "../database/db.js";

import {
  getStaffUser,
  requireStaffAuth,
} from "../middleware/staffAuth.js";

import {
  effectiveStaffCapabilities,
} from "../middleware/staffRbac.js";

const router =
  Router();

const scrypt =
  promisify(scryptCallback);

const SESSION_DAYS = 30;

function cleanText(
  value: unknown
): string {
  return String(
    value ?? ""
  ).trim();
}

function hashToken(
  token: string
): string {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}

async function hashCredential(
  credential: string
): Promise<string> {
  const salt =
    randomBytes(16)
      .toString("hex");

  const derived =
    await scrypt(
      credential,
      salt,
      64
    ) as Buffer;

  return [
    "scrypt",
    salt,
    derived.toString("hex"),
  ].join("$");
}

async function verifyCredential(
  credential: string,
  storedHash: string
): Promise<boolean> {
  const [
    algorithm,
    salt,
    expectedHex,
  ] = storedHash.split("$");

  if (
    algorithm !== "scrypt" ||
    !salt ||
    !expectedHex
  ) {
    return false;
  }

  let expected: Buffer;

  try {
    expected =
      Buffer.from(
        expectedHex,
        "hex"
      );
  } catch {
    return false;
  }

  if (
    expected.length === 0
  ) {
    return false;
  }

  const actual =
    await scrypt(
      credential,
      salt,
      expected.length
    ) as Buffer;

  if (
    actual.length !==
    expected.length
  ) {
    return false;
  }

  return timingSafeEqual(
    actual,
    expected
  );
}

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


function publicUser(
  row: any
) {
  const role =
    String(row.role) as
      import("../middleware/staffAuth.js").StaffRole;

  const jobKey =
    String(
      row.job_key ||
      (
        role === "ADMIN"
          ? "admin"
          : role === "MANAGER"
          ? "management"
          : "sales"
      )
    );

  const permissions =
    stringArray(
      row.permissions
    );

  const deniedPermissions =
    stringArray(
      row.denied_permissions
    );

  return {
    id:
      String(row.id),

    username:
      String(row.username),

    displayName:
      String(row.display_name),

    role,

    jobKey,

    defaultWorkspace:
      String(
        row.default_workspace
      ),

    allowedWorkspaces:
      stringArray(
        row.allowed_workspaces
      ),

    permissions,

    deniedPermissions,

    active:
      row.active === undefined
        ? true
        : Boolean(row.active),

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

    capabilities:
      Array.from(
        effectiveStaffCapabilities({
          role,
          jobKey:
            jobKey as import(
              "../middleware/staffAuth.js"
            ).StaffJob,
          permissions,
          deniedPermissions,
        })
      ),
  };
}

export async function createStaffCredentialHash(
  credential: string
) {
  return hashCredential(
    credential
  );
}


/* =========================================================
   SELF REGISTRATION

   Jeder neue Crew-Mitarbeiter darf sein eigenes Profil
   erstellen.

   Sicherheitsregeln:
   - keine Selbstvergabe von ADMIN / MANAGER
   - normale Crew -> STAFF
   - Praktikant -> PRAKTIKANT
   - Fahrer -> DRIVER
   - PIN/Credential wird nur als scrypt Hash gespeichert
   - Username muss eindeutig sein
   - Driver-Profil startet OFFLINE
========================================================= */

router.post(
  "/register",
  async (req, res) => {
    const displayName =
      cleanText(
        req.body?.displayName
      );

    const username =
      cleanText(
        req.body?.username
      )
        .toLowerCase();

    const credential =
      cleanText(
        req.body?.credential
      );

    const requestedProfile =
      cleanText(
        req.body?.profileType
      )
        .toUpperCase();

    const requestedWorkspace =
      cleanText(
        req.body?.workspace
      )
        .toUpperCase();

    const transportType =
      cleanText(
        req.body?.transportType
      )
        .toUpperCase();

    if (
      displayName.length < 2 ||
      displayName.length > 80
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Bitte einen gÃ¼ltigen Namen eingeben.",
      });
    }

    if (
      !/^[a-z0-9._-]{3,32}$/.test(
        username
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Benutzername muss 3-32 Zeichen haben und darf nur Buchstaben, Zahlen, Punkt, Minus und Unterstrich enthalten.",
      });
    }

    if (
      credential.length < 4 ||
      credential.length > 64
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "PIN muss mindestens 4 Zeichen haben.",
      });
    }

    /*
     * Niemals ADMIN/MANAGER aus einem
     * Ã¶ffentlichen Request Ã¼bernehmen.
     */
    let role:
      | "STAFF"
      | "PRAKTIKANT"
      | "DRIVER" =
        "STAFF";

    if (
      requestedProfile ===
      "PRAKTIKANT"
    ) {
      role =
        "PRAKTIKANT";
    }

    if (
      requestedProfile ===
      "DRIVER"
    ) {
      role =
        "DRIVER";
    }

    const validWorkspaces =
      new Set([
        "AARAU",
        "OLTEN",
        "ONLINE",
      ]);

    const defaultWorkspace =
      validWorkspaces.has(
        requestedWorkspace
      )
        ? requestedWorkspace
        : "ONLINE";

    /*
     * Normale Crew kann zwischen den
     * operativen Workspaces wechseln.
     *
     * Das ist KEINE Admin-Berechtigung.
     * Die tatsÃ¤chlichen Funktionen kommen
     * weiterhin aus capabilitiesForRole().
     */
    const allowedWorkspaces =
      role === "DRIVER"
        ? [
            defaultWorkspace,
          ]
        : [
            "AARAU",
            "OLTEN",
            "ONLINE",
          ];

    const credentialHash =
      await hashCredential(
        credential
      );

    const client =
      await db.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const existing =
        await client.query(
          `
            SELECT id
            FROM staff_users
            WHERE LOWER(username) =
              LOWER($1)
            LIMIT 1
          `,
          [
            username,
          ]
        );

      if (
        existing.rowCount &&
        existing.rowCount > 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({
          ok: false,
          error:
            "Dieser Benutzername ist bereits vergeben.",
        });
      }

      const inserted =
        await client.query(
          `
            INSERT INTO staff_users (
              username,
              display_name,
              pin_hash,
              role,
              default_workspace,
              allowed_workspaces,
              active
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6::JSONB,
              TRUE
            )
            RETURNING *
          `,
          [
            username,
            displayName,
            credentialHash,
            role,
            defaultWorkspace,
            JSON.stringify(allowedWorkspaces),
          ]
        );

      const user =
        inserted.rows[0];

      /*
       * Fahrer bekommt automatisch sein
       * ALO-NOW-Profil.
       *
       * approved bleibt bewusst FALSE:
       * Profil selbst erstellen = erlaubt,
       * aber Delivery-Freigabe bleibt
       * kontrolliert.
       */
      if (
        role === "DRIVER"
      ) {
        await client.query(
          `
            INSERT INTO alo_driver_profiles (
              staff_user_id,
              approved,
              availability_status,
              home_workspace,
              transport_type,
              approved_for_age_restricted,
              max_active_deliveries
            )
            VALUES (
              $1,
              FALSE,
              'OFFLINE',
              $2,
              $3,
              FALSE,
              3
            )
            ON CONFLICT (
              staff_user_id
            )
            DO NOTHING
          `,
          [
            user.id,
            defaultWorkspace,
            transportType ||
              null,
          ]
        );
      }

      /*
       * Direkt eine Session erzeugen,
       * damit Registrierung -> Workspace
       * ohne zweiten Login funktioniert.
       */
      const token =
        randomBytes(32)
          .toString("hex");

      const tokenHash =
        hashToken(token);

      await client.query(
        `
          INSERT INTO staff_sessions (
            staff_user_id,
            token_hash,
            expires_at
          )
          VALUES (
            $1,
            $2,
            NOW() +
              ($3 || ' days')::INTERVAL
          )
        `,
        [
          user.id,
          tokenHash,
          SESSION_DAYS,
        ]
      );

      await client.query(
        "COMMIT"
      );

      return res.status(201).json({
        ok: true,

        token,

        user:
          publicUser(user),

        requiresDriverApproval:
          role === "DRIVER",
      });
    }
    catch (error: any) {
      await client.query(
        "ROLLBACK"
      );

      /*
       * PostgreSQL unique violation.
       */
      if (
        error?.code ===
        "23505"
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "Dieser Benutzername ist bereits vergeben.",
        });
      }

      console.error(
        "[staff-auth/register]",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Profil konnte nicht erstellt werden.",
      });
    }
    finally {
      client.release();
    }
  }
);
/* =========================================================
   CREATE STAFF / DRIVER PROFILE

   ADMIN / MANAGER only.

   Creates the staff account and optional ALO NOW driver
   profile in one database transaction.
========================================================= */

router.post(
  "/users",
  requireStaffAuth,
  async (req, res) => {
    const actor =
      getStaffUser(res);

    if (
      actor.role !== "ADMIN" &&
      actor.role !== "MANAGER"
    ) {
      return res.status(403).json({
        ok: false,
        error: "Keine Berechtigung zum Erstellen von Profilen.",
      });
    }

    const displayName =
      cleanText(req.body?.displayName);

    const requestedUsername =
      cleanText(req.body?.username)
        .toLowerCase();

    const pin =
      cleanText(req.body?.pin);

    const role =
      cleanText(req.body?.role || "STAFF")
        .toUpperCase();

    const defaultWorkspace =
      cleanText(
        req.body?.defaultWorkspace || "AARAU"
      ).toUpperCase();

    const isDriver =
      req.body?.isDriver === true;

    const transportTypeRaw =
      cleanText(req.body?.transportType)
        .toUpperCase();

    if (!displayName) {
      return res.status(422).json({
        ok: false,
        error: "Name fehlt.",
      });
    }

    if (
      pin.length < 4 ||
      pin.length > 32
    ) {
      return res.status(422).json({
        ok: false,
        error: "Die PIN muss zwischen 4 und 32 Zeichen lang sein.",
      });
    }

    if (
      ![
        "ADMIN",
        "MANAGER",
        "STAFF",
        "PRAKTIKANT",
      ].includes(role)
    ) {
      return res.status(422).json({
        ok: false,
        error: "UngÃƒÆ’Ã‚Â¼ltige Mitarbeiterrolle.",
      });
    }

    if (
      actor.role === "MANAGER" &&
      (
        role === "ADMIN" ||
        role === "MANAGER"
      )
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "Manager dÃƒÆ’Ã‚Â¼rfen nur STAFF- oder PRAKTIKANT-Profile erstellen.",
      });
    }

    if (
      actor.role !== "ADMIN" &&
      (
        role === "ADMIN" ||
        role === "MANAGER"
      )
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "Nur ein Admin darf Admin- oder Managerprofile erstellen.",
      });
    }

    if (
      ![
        "AARAU",
        "OLTEN",
        "ONLINE",
      ].includes(defaultWorkspace)
    ) {
      return res.status(422).json({
        ok: false,
        error: "UngÃƒÆ’Ã‚Â¼ltiger Workspace.",
      });
    }

    if (
      transportTypeRaw &&
      ![
        "CAR",
        "SCOOTER",
        "BIKE",
        "OTHER",
      ].includes(transportTypeRaw)
    ) {
      return res.status(422).json({
        ok: false,
        error: "UngÃƒÆ’Ã‚Â¼ltiges Transportmittel.",
      });
    }

    const generatedUsername =
      displayName
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ".")
        .replace(/^\.+|\.+$/g, "");

    const username =
      requestedUsername ||
      generatedUsername;

    if (!username) {
      return res.status(422).json({
        ok: false,
        error: "Benutzername konnte nicht erstellt werden.",
      });
    }

    const pinHash =
      await hashCredential(pin);

    const allowedWorkspaces =
      defaultWorkspace === "ONLINE"
        ? ["ONLINE"]
        : [defaultWorkspace, "ONLINE"];

    const client =
      await db.connect();

    try {
      await client.query("BEGIN");

      const duplicate =
        await client.query(
          `
            SELECT 1
            FROM staff_users
            WHERE LOWER(username) = $1
            LIMIT 1
          `,
          [username]
        );

      if (duplicate.rows[0]) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "Dieser Profilname ist bereits vergeben.",
        });
      }

      const created =
        await client.query(
          `
            INSERT INTO staff_users (
              username,
              display_name,
              role,
              pin_hash,
              default_workspace,
              allowed_workspaces,
              active
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6::jsonb,
              TRUE
            )
            RETURNING
              id,
              username,
              display_name,
              role,
              default_workspace,
              allowed_workspaces
          `,
          [
            username,
            displayName,
            role,
            pinHash,
            defaultWorkspace,
            JSON.stringify(allowedWorkspaces),
          ]
        );

      const user =
        created.rows[0];

      if (isDriver) {
        const driverWorkspace =
          defaultWorkspace === "ONLINE"
            ? "AARAU"
            : defaultWorkspace;

        await client.query(
          `
            INSERT INTO alo_driver_profiles (
              staff_user_id,
              approved,
              availability_status,
              home_workspace,
              transport_type,
              approved_for_age_restricted,
              max_active_deliveries
            )
            VALUES (
              $1,
              TRUE,
              'OFFLINE',
              $2,
              $3,
              FALSE,
              3
            )
          `,
          [
            user.id,
            driverWorkspace,
            transportTypeRaw || null,
          ]
        );
      }

      await client.query(
        `
          INSERT INTO staff_activity (
            staff_user_id,
            workspace,
            action,
            entity_type,
            entity_id,
            metadata
          )
          VALUES (
            $1,
            $2,
            'STAFF_PROFILE_CREATED',
            'STAFF_USER',
            $3,
            $4::jsonb
          )
        `,
        [
          actor.id,
          defaultWorkspace,
          String(user.id),
          JSON.stringify({
            username,
            displayName,
            role,
            isDriver,
          }),
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        ok: true,
        user: publicUser(user),
        driver: isDriver
          ? {
              enabled: true,
              approved: true,
              availabilityStatus: "OFFLINE",
              workspace:
                defaultWorkspace === "ONLINE"
                  ? "AARAU"
                  : defaultWorkspace,
              transportType:
                transportTypeRaw || null,
              maxActiveDeliveries: 3,
            }
          : null,
      });
    } catch (error: any) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      if (error?.code === "23505") {
        return res.status(409).json({
          ok: false,
          error:
            "Dieser Profilname ist bereits vergeben.",
        });
      }

      console.error(
        "STAFF PROFILE CREATE ERROR",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Profil konnte nicht erstellt werden.",
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   STAFF USER PICKER
========================================================= */

router.get(
  "/users",
  async (_req, res) => {
    try {
      const result =
        await db.query(
          `
            SELECT
              id,
              username,
              display_name,
              role,
              default_workspace,
              allowed_workspaces,
              pin_hash,
              password_hash
            FROM staff_users
            WHERE active = TRUE
            ORDER BY
              CASE role
                WHEN 'ADMIN' THEN 1
                WHEN 'MANAGER' THEN 2
                WHEN 'STAFF' THEN 3
                WHEN 'PRAKTIKANT' THEN 4
                ELSE 5
              END,
              display_name ASC
          `
        );

      return res.json({
        ok: true,
        users:
          result.rows.map(
            (row: any) => ({
              ...publicUser(row),
              needsPinSetup:
                !row.pin_hash &&
                !row.password_hash,
            })
          ),
      });
    } catch (error) {
      console.error(
        "STAFF USERS ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Mitarbeiter konnten nicht geladen werden.",
        });
    }
  }
);


/* =========================================================
   FIRST-PIN ENROLLMENT ISSUE

   Security:
   - niemals Token-Hashes zurÃƒÆ’Ã‚Â¼ckgeben
   - bestehende offene FIRST_PIN Tokens werden widerrufen
   - Token ist kurzlebig
   - nur fÃƒÆ’Ã‚Â¼r Accounts ohne bestehende PIN
========================================================= */

router.post(
  "/enrollment/issue",
  requireStaffAuth,
  async (req, res) => {
    const actor =
      getStaffUser(res);

    if (
      actor.role !== "ADMIN" &&
      actor.role !== "MANAGER"
    ) {
      return res
        .status(403)
        .json({
          ok: false,
          error:
            "Keine Berechtigung fÃƒÆ’Ã‚Â¼r Mitarbeiter-Einrichtung.",
        });
    }

    const username =
      cleanText(
        req.body?.username
      ).toLowerCase();

    if (!username) {
      return res
        .status(422)
        .json({
          ok: false,
          error:
            "Mitarbeiter fehlt.",
        });
    }

    const client =
      await db.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const userResult =
        await client.query(
          `
            SELECT
              id,
              username,
              display_name,
              role,
              pin_hash,
              password_hash,
              active
            FROM staff_users
            WHERE LOWER(username) = $1
            LIMIT 1
            FOR UPDATE
          `,
          [username]
        );

      if (
        userResult.rows.length === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Mitarbeiter nicht gefunden.",
          });
      }

      const user =
        userResult.rows[0];

      if (!user.active) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Mitarbeiterkonto ist deaktiviert.",
          });
      }

      if (
        user.pin_hash ||
        user.password_hash
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "FÃƒÆ’Ã‚Â¼r diesen Mitarbeiter ist bereits ein PIN eingerichtet.",
          });
      }

      /*
       * Pro Mitarbeiter darf nur ein aktueller
       * FIRST_PIN Token offen sein.
       */
      await client.query(
        `
          UPDATE staff_enrollment_tokens
          SET used_at = NOW()
          WHERE staff_user_id = $1
            AND purpose = 'FIRST_PIN'
            AND used_at IS NULL
        `,
        [user.id]
      );

      const enrollmentToken =
        randomBytes(32)
          .toString("base64url");

      const enrollmentTokenHash =
        hashToken(
          enrollmentToken
        );

      /*
       * 15 Minuten reichen fÃƒÆ’Ã‚Â¼r die
       * unmittelbare Ersteinrichtung.
       */
      const expiresAt =
        new Date(
          Date.now() +
            15 * 60 * 1000
        );

      await client.query(
        `
          INSERT INTO staff_enrollment_tokens (
            staff_user_id,
            token_hash,
            purpose,
            expires_at,
            created_by_staff_user_id
          )
          VALUES (
            $1,
            $2,
            'FIRST_PIN',
            $3,
            $4
          )
        `,
        [
          user.id,
          enrollmentTokenHash,
          expiresAt,
          actor.id,
        ]
      );

      await client.query(
        `
          INSERT INTO staff_activity (
            staff_user_id,
            workspace,
            action,
            entity_type,
            entity_id,
            metadata
          )
          VALUES (
            $1,
            NULL,
            'FIRST_PIN_ENROLLMENT_ISSUED',
            'STAFF_USER',
            $2,
            $3::jsonb
          )
        `,
        [
          actor.id,
          String(user.id),
          JSON.stringify({
            username:
              String(user.username),
          }),
        ]
      );

      await client.query(
        "COMMIT"
      );

      return res.json({
        ok: true,

        /*
         * Raw Token wird genau hier einmalig
         * an den berechtigten Client geliefert.
         * In der DB liegt ausschlieÃƒÆ’Ã…Â¸lich SHA-256.
         */
        enrollmentToken,

        expiresAt:
          expiresAt.toISOString(),

        user: {
          id:
            String(user.id),
          username:
            String(user.username),
          displayName:
            String(user.display_name),
        },
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "STAFF ENROLLMENT ISSUE ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Mitarbeiter-Einrichtung konnte nicht vorbereitet werden.",
        });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   FIRST LOGIN / PIN SETUP
========================================================= */

router.post(
  "/setup-pin",
  async (req, res) => {
    const client =
      await db.connect();

    try {
      const username =
        cleanText(
          req.body?.username
        ).toLowerCase();

      const pin =
        cleanText(
          req.body?.pin
        );

      const pinConfirmation =
        cleanText(
          req.body?.pinConfirmation
        );

      const deviceName =
        cleanText(
          req.body?.deviceName
        );

      const devicePlatform =
        cleanText(
          req.body?.devicePlatform
        );

      if (
        !username ||
        !pin ||
        !pinConfirmation
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Mitarbeiter oder PIN fehlen.",
          });
      }

      if (pin !== pinConfirmation) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Die PINs stimmen nicht ÃƒÆ’Ã‚Â¼berein.",
          });
      }

      if (
        pin.length < 4 ||
        pin.length > 32
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Die PIN muss zwischen 4 und 32 Zeichen lang sein.",
          });
      }

      await client.query(
        "BEGIN"
      );

      const result =
        await client.query(
          `
            SELECT
              id,
              username,
              display_name,
              role,
              password_hash,
              pin_hash,
              default_workspace,
              allowed_workspaces,
              active
            FROM staff_users
            WHERE LOWER(username) = $1
            LIMIT 1
            FOR UPDATE
          `,
          [username]
        );

      if (
        result.rows.length === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Mitarbeiter nicht gefunden.",
          });
      }

      const user =
        result.rows[0];

      if (!user.active) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Mitarbeiterkonto ist deaktiviert.",
          });
      }

      if (
        user.pin_hash ||
        user.password_hash
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res
          .status(409)
          .json({
            ok: false,
            error:
              "PIN wurde bereits eingerichtet.",
          });
      }

      const pinHash =
        await hashCredential(pin);

      const token =
        randomBytes(32)
          .toString("base64url");

      const tokenHash =
        hashToken(token);

      const expiresAt =
        new Date(
          Date.now() +
            SESSION_DAYS *
              24 *
              60 *
              60 *
              1000
        );

      await client.query(
        `
          UPDATE staff_users
          SET
            pin_hash = $1,
            last_login_at = NOW(),
            updated_at = NOW()
          WHERE id = $2
        `,
        [
          pinHash,
          user.id,
        ]
      );

      await client.query(
        `
          INSERT INTO staff_sessions (
            staff_user_id,
            token_hash,
            device_name,
            device_platform,
            expires_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5
          )
        `,
        [
          user.id,
          tokenHash,
          deviceName || null,
          devicePlatform || null,
          expiresAt,
        ]
      );

      await client.query(
        `
          INSERT INTO staff_activity (
            staff_user_id,
            action,
            entity_type,
            entity_id,
            metadata
          )
          VALUES (
            $1,
            'PIN_SETUP',
            'STAFF_USER',
            $2,
            $3::jsonb
          )
        `,
        [
          user.id,
          String(user.id),
          JSON.stringify({
            deviceName:
              deviceName || null,
            devicePlatform:
              devicePlatform || null,
          }),
        ]
      );

      await client.query(
        "COMMIT"
      );

      return res.json({
        ok: true,
        token,
        expiresAt:
          expiresAt.toISOString(),
        user:
          publicUser(user),
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "STAFF PIN SETUP ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "PIN konnte nicht eingerichtet werden.",
        });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   LOGIN
========================================================= */

router.post(
  "/login",
  async (req, res) => {
    try {
      const username =
        cleanText(
          req.body?.username
        ).toLowerCase();

      const credential =
        cleanText(
          req.body?.credential
        );

      const deviceName =
        cleanText(
          req.body?.deviceName
        );

      const devicePlatform =
        cleanText(
          req.body?.devicePlatform
        );

      if (
        !username ||
        !credential
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Benutzer und Zugangscode fehlen.",
          });
      }

      const result =
        await db.query(
          `
            SELECT
              id,
              username,
              display_name,
              role,
              password_hash,
              pin_hash,
              default_workspace,
              allowed_workspaces,
              active
            FROM staff_users
            WHERE
              LOWER(username) = $1
            LIMIT 1
          `,
          [username]
        );

      if (
        result.rows.length === 0
      ) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Anmeldung fehlgeschlagen.",
          });
      }

      const user =
        result.rows[0];

      if (!user.active) {
        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Mitarbeiterkonto ist deaktiviert.",
          });
      }

      const hashes = [
        user.pin_hash,
        user.password_hash,
      ].filter(
        (value): value is string =>
          typeof value ===
            "string" &&
          value.length > 0
      );

      let valid = false;

      for (
        const storedHash
        of hashes
      ) {
        if (
          await verifyCredential(
            credential,
            storedHash
          )
        ) {
          valid = true;
          break;
        }
      }

      if (!valid) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Anmeldung fehlgeschlagen.",
          });
      }

      const token =
        randomBytes(32)
          .toString("base64url");

      const tokenHash =
        hashToken(token);

      const expiresAt =
        new Date(
          Date.now() +
            SESSION_DAYS *
              24 *
              60 *
              60 *
              1000
        );

      const client =
        await db.connect();

      try {
        await client.query(
          "BEGIN"
        );

        await client.query(
          `
            INSERT INTO staff_sessions (
              staff_user_id,
              token_hash,
              device_name,
              device_platform,
              expires_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5
            )
          `,
          [
            user.id,
            tokenHash,
            deviceName || null,
            devicePlatform ||
              null,
            expiresAt,
          ]
        );

        await client.query(
          `
            UPDATE staff_users
            SET
              last_login_at =
                NOW(),
              updated_at =
                NOW()
            WHERE id = $1
          `,
          [user.id]
        );

        await client.query(
          `
            INSERT INTO staff_activity (
              staff_user_id,
              action,
              entity_type,
              entity_id,
              metadata
            )
            VALUES (
              $1,
              'LOGIN',
              'STAFF_SESSION',
              NULL,
              $2::jsonb
            )
          `,
          [
            user.id,
            JSON.stringify({
              deviceName:
                deviceName ||
                null,
              devicePlatform:
                devicePlatform ||
                null,
            }),
          ]
        );

        await client.query(
          "COMMIT"
        );
      } catch (error) {
        await client.query(
          "ROLLBACK"
        );
        throw error;
      } finally {
        client.release();
      }

      return res.json({
        ok: true,
        token,
        expiresAt:
          expiresAt
            .toISOString(),
        user:
          publicUser(user),
      });
    } catch (error) {
      console.error(
        "STAFF LOGIN ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Anmeldung konnte nicht durchgefÃƒÆ’Ã‚Â¼hrt werden.",
        });
    }
  }
);


/* =========================================================
   BIOMETRIC DEVICE REGISTRATION

   Requires an existing authenticated staff session.

   The biometric check itself stays on the device.
   Server stores only a hash of a random device secret.
========================================================= */

router.post(
  "/biometric/register",
  requireStaffAuth,
  async (req, res) => {
    try {
      const actor =
        getStaffUser(res);

      if (!actor?.id) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Keine gÃ¼ltige Mitarbeiter-Session.",
          });
      }

      const deviceId =
        cleanText(
          req.body?.deviceId
        );

      const deviceName =
        cleanText(
          req.body?.deviceName
        );

      const devicePlatform =
        cleanText(
          req.body?.devicePlatform
        );

      if (!deviceId) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "GerÃ¤te-ID fehlt.",
          });
      }

      const deviceSecret =
        randomBytes(32)
          .toString("base64url");

      const secretHash =
        await hashCredential(
          deviceSecret
        );

      await db.query(
        `
          INSERT INTO
            staff_biometric_devices (
              staff_user_id,
              device_id,
              device_name,
              device_platform,
              secret_hash,
              active,
              revoked_at,
              updated_at
            )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            TRUE,
            NULL,
            NOW()
          )
          ON CONFLICT (
            staff_user_id,
            device_id
          )
          DO UPDATE SET
            device_name =
              EXCLUDED.device_name,
            device_platform =
              EXCLUDED.device_platform,
            secret_hash =
              EXCLUDED.secret_hash,
            active =
              TRUE,
            revoked_at =
              NULL,
            updated_at =
              NOW()
        `,
        [
          actor.id,
          deviceId,
          deviceName || null,
          devicePlatform || null,
          secretHash,
        ]
      );

      await db.query(
        `
          INSERT INTO staff_activity (
            staff_user_id,
            action,
            entity_type,
            entity_id,
            metadata
          )
          VALUES (
            $1,
            'BIOMETRIC_REGISTER',
            'BIOMETRIC_DEVICE',
            NULL,
            $2::jsonb
          )
        `,
        [
          actor.id,
          JSON.stringify({
            deviceId,
            deviceName:
              deviceName || null,
            devicePlatform:
              devicePlatform || null,
          }),
        ]
      );

      return res.json({
        ok: true,
        deviceId,
        deviceSecret,
      });
    } catch (error) {
      console.error(
        "BIOMETRIC REGISTER ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Biometrie konnte nicht eingerichtet werden.",
        });
    }
  }
);


/* =========================================================
   BIOMETRIC LOGIN

   Device must first unlock its locally stored secret using
   Face ID / Touch ID / fingerprint.

   Server validates the device secret and then creates the
   same normal staff session used by PIN login.
========================================================= */

router.post(
  "/biometric/login",
  async (req, res) => {
    try {
      const username =
        cleanText(
          req.body?.username
        ).toLowerCase();

      const deviceId =
        cleanText(
          req.body?.deviceId
        );

      const deviceSecret =
        cleanText(
          req.body?.deviceSecret
        );

      const deviceName =
        cleanText(
          req.body?.deviceName
        );

      const devicePlatform =
        cleanText(
          req.body?.devicePlatform
        );

      if (
        !username ||
        !deviceId ||
        !deviceSecret
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Biometrische Anmeldedaten fehlen.",
          });
      }

      const result =
        await db.query(
          `
            SELECT
              u.id,
              u.username,
              u.display_name,
              u.role,
              u.default_workspace,
              u.allowed_workspaces,
              u.active,

              b.id AS biometric_device_id,
              b.secret_hash

            FROM staff_users u

            INNER JOIN
              staff_biometric_devices b
              ON
                b.staff_user_id =
                  u.id

            WHERE
              LOWER(u.username) =
                $1
              AND
              b.device_id =
                $2
              AND
              b.active =
                TRUE
              AND
              b.revoked_at
                IS NULL

            LIMIT 1
          `,
          [
            username,
            deviceId,
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Biometrische Anmeldung nicht verfÃ¼gbar.",
          });
      }

      const user =
        result.rows[0];

      if (!user.active) {
        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Mitarbeiterkonto ist deaktiviert.",
          });
      }

      const valid =
        await verifyCredential(
          deviceSecret,
          user.secret_hash
        );

      if (!valid) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Biometrische Anmeldung fehlgeschlagen.",
          });
      }

      const token =
        randomBytes(32)
          .toString("base64url");

      const tokenHash =
        hashToken(token);

      const expiresAt =
        new Date(
          Date.now() +
            SESSION_DAYS *
              24 *
              60 *
              60 *
              1000
        );

      const client =
        await db.connect();

      try {
        await client.query(
          "BEGIN"
        );

        await client.query(
          `
            INSERT INTO staff_sessions (
              staff_user_id,
              token_hash,
              device_name,
              device_platform,
              expires_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5
            )
          `,
          [
            user.id,
            tokenHash,
            deviceName || null,
            devicePlatform || null,
            expiresAt,
          ]
        );

        await client.query(
          `
            UPDATE
              staff_biometric_devices
            SET
              last_used_at =
                NOW(),
              updated_at =
                NOW()
            WHERE id =
              $1
          `,
          [
            user.biometric_device_id,
          ]
        );

        await client.query(
          `
            UPDATE staff_users
            SET
              last_login_at =
                NOW(),
              updated_at =
                NOW()
            WHERE id =
              $1
          `,
          [
            user.id,
          ]
        );

        await client.query(
          `
            INSERT INTO staff_activity (
              staff_user_id,
              action,
              entity_type,
              entity_id,
              metadata
            )
            VALUES (
              $1,
              'BIOMETRIC_LOGIN',
              'STAFF_SESSION',
              NULL,
              $2::jsonb
            )
          `,
          [
            user.id,
            JSON.stringify({
              deviceId,
              deviceName:
                deviceName || null,
              devicePlatform:
                devicePlatform || null,
            }),
          ]
        );

        await client.query(
          "COMMIT"
        );
      } catch (error) {
        await client.query(
          "ROLLBACK"
        );

        throw error;
      } finally {
        client.release();
      }

      return res.json({
        ok: true,
        token,
        expiresAt:
          expiresAt.toISOString(),
        user:
          publicUser(user),
      });
    } catch (error) {
      console.error(
        "BIOMETRIC LOGIN ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Biometrische Anmeldung konnte nicht durchgefÃ¼hrt werden.",
        });
    }
  }
);


/* =========================================================
   CURRENT USER
========================================================= */

router.get(
  "/me",
  requireStaffAuth,
  async (_req, res) => {
    try {
      const actor =
        getStaffUser(res);

      const result =
        await db.query(
          `
            SELECT
              id,
              username,
              display_name,
              role,
              job_key,
              default_workspace,
              allowed_workspaces,
              permissions,
              denied_permissions,
              profile_note,
              avatar_url,
              active,
              approved_at,
              approved_by
            FROM staff_users
            WHERE id = $1
            LIMIT 1
          `,
          [actor.id]
        );

      if (
        result.rows.length === 0
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Mitarbeiter nicht gefunden.",
          });
      }

      return res.json({
        ok: true,
        user:
          publicUser(
            result.rows[0]
          ),
      });

    } catch (error) {

      console.error(
        "STAFF ME ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Profil konnte nicht geladen werden.",
        });
    }
  }
);


router.patch(
  "/me",
  requireStaffAuth,
  async (req, res) => {
    try {
      const actor =
        getStaffUser(res);

      const displayName =
        typeof req.body?.displayName ===
        "string"
          ? req.body.displayName.trim()
          : undefined;

      const profileNote =
        typeof req.body?.profileNote ===
        "string"
          ? req.body.profileNote.trim()
          : undefined;

      const avatarUrl =
        typeof req.body?.avatarUrl ===
        "string"
          ? req.body.avatarUrl.trim()
          : undefined;

      if (
        displayName !== undefined &&
        !displayName
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Anzeigename darf nicht leer sein.",
          });
      }

      const result =
        await db.query(
          `
            UPDATE staff_users
            SET
              display_name =
                COALESCE(
                  $2,
                  display_name
                ),

              profile_note =
                CASE
                  WHEN $3::boolean
                    THEN $4
                  ELSE profile_note
                END,

              avatar_url =
                CASE
                  WHEN $5::boolean
                    THEN $6
                  ELSE avatar_url
                END,

              updated_at = NOW()

            WHERE id = $1

            RETURNING
              id,
              username,
              display_name,
              role,
              job_key,
              default_workspace,
              allowed_workspaces,
              permissions,
              denied_permissions,
              profile_note,
              avatar_url,
              active,
              approved_at,
              approved_by
          `,
          [
            actor.id,

            displayName ??
              null,

            profileNote !==
              undefined,

            profileNote ===
              undefined
              ? null
              : profileNote ||
                null,

            avatarUrl !==
              undefined,

            avatarUrl ===
              undefined
              ? null
              : avatarUrl ||
                null,
          ]
        );

      return res.json({
        ok: true,
        user:
          publicUser(
            result.rows[0]
          ),
      });

    } catch (error) {

      console.error(
        "STAFF PROFILE UPDATE ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Profil konnte nicht gespeichert werden.",
        });
    }
  }
);


/*
 * ALO_STAFF_V2_ADMIN_UPDATE
 *
 * Central admin endpoint for:
 * - role
 * - operational job
 * - workspaces
 * - allow / deny permissions
 * - active state
 * - profile metadata
 */


/*
 * Admin staff management list.
 *
 * Der bestehende GET /users Endpoint bleibt bewusst klein,
 * weil er auch für den Login/Profile-Picker verwendet wird.
 *
 * Diese Route liefert dagegen die vollständigen,
 * administrierbaren Mitarbeiterprofile und ist nur für
 * angemeldete Administratoren zugänglich.
 */
router.get(
  "/manage/users",
  requireStaffAuth,
  async (_req, res) => {
    const actor = getStaffUser(res);

    if (actor.role !== "ADMIN") {
      return res.status(403).json({
        ok: false,
        error:
          "Nur Administratoren dürfen Mitarbeiter verwalten.",
      });
    }

    try {
      const result = await db.query(`
        SELECT
          id,
          username,
          display_name,
          role,
          job_key,
          default_workspace,
          allowed_workspaces,
          permissions,
          denied_permissions,
          active,
          profile_note,
          avatar_url,
          approved_at,
          approved_by,
          pin_hash,
          password_hash
        FROM staff_users
        ORDER BY
          active DESC,
          CASE role
            WHEN 'ADMIN' THEN 1
            WHEN 'MANAGER' THEN 2
            WHEN 'STAFF' THEN 3
            WHEN 'PRAKTIKANT' THEN 4
            ELSE 5
          END,
          display_name ASC,
          username ASC
      `);

      return res.json({
        ok: true,
        users: result.rows.map((row) => ({
          ...publicUser(row),
          needsPinSetup:
            !row.pin_hash &&
            !row.password_hash,
        })),
      });
    } catch (error) {
      console.error(
        "GET /staff-auth/manage/users failed:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Mitarbeiter konnten nicht geladen werden.",
      });
    }
  }
);


router.patch(
  "/users/:id",
  requireStaffAuth,
  async (req, res) => {
    const actor =
      getStaffUser(res);

    if (
      actor.role !== "ADMIN"
    ) {
      return res
        .status(403)
        .json({
          ok: false,
          error:
            "Nur Administratoren dürfen Mitarbeiterrechte ändern.",
        });
    }

    const targetId =
      String(
        req.params.id || ""
      ).trim();

    if (
      !/^\d+$/.test(
        targetId
      )
    ) {
      return res
        .status(422)
        .json({
          ok: false,
          error:
            "Ungültige Mitarbeiter-ID.",
        });
    }

    const validRoles =
      new Set([
        "ADMIN",
        "MANAGER",
        "STAFF",
        "PRAKTIKANT",
      ]);

    const validJobs =
      new Set([
        "admin",
        "management",
        "store_manager",
        "sales",
        "warehouse",
        "online_shop",
        "packing",
        "live_team",
        "driver",
      ]);

    const validWorkspaces =
      new Set([
        "AARAU",
        "OLTEN",
        "ONLINE",
      ]);

    try {

      const currentResult =
        await db.query(
          `
            SELECT *
            FROM staff_users
            WHERE id = $1
            LIMIT 1
          `,
          [targetId]
        );

      if (
        currentResult.rows.length === 0
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Mitarbeiter nicht gefunden.",
          });
      }

      const current =
        currentResult.rows[0];

      const role =
        req.body?.role ===
        undefined
          ? String(
              current.role
            )
          : String(
              req.body.role
            ).toUpperCase();

      if (
        !validRoles.has(role)
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Ungültige Rolle.",
          });
      }

      const jobKey =
        req.body?.jobKey ===
        undefined
          ? String(
              current.job_key ||
              "sales"
            )
          : String(
              req.body.jobKey
            );

      if (
        !validJobs.has(jobKey)
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Ungültiger Job.",
          });
      }

      const defaultWorkspace =
        req.body
          ?.defaultWorkspace ===
        undefined
          ? String(
              current
                .default_workspace
            )
          : String(
              req.body
                .defaultWorkspace
            ).toUpperCase();

      if (
        !validWorkspaces.has(
          defaultWorkspace
        )
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Ungültiger Standard-Standort.",
          });
      }

      const allowedWorkspaces =
        req.body
          ?.allowedWorkspaces ===
        undefined
          ? stringArray(
              current
                .allowed_workspaces
            )
          : stringArray(
              req.body
                .allowedWorkspaces
            ).map(
              (value) =>
                value.toUpperCase()
            );

      if (
        allowedWorkspaces.some(
          (workspace) =>
            !validWorkspaces.has(
              workspace
            )
        )
      ) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Ungültiger Standort in allowedWorkspaces.",
          });
      }

      if (
        !allowedWorkspaces.includes(
          defaultWorkspace
        )
      ) {
        allowedWorkspaces.push(
          defaultWorkspace
        );
      }

      const permissions =
        req.body?.permissions ===
        undefined
          ? stringArray(
              current.permissions
            )
          : stringArray(
              req.body.permissions
            );

      const deniedPermissions =
        req.body
          ?.deniedPermissions ===
        undefined
          ? stringArray(
              current
                .denied_permissions
            )
          : stringArray(
              req.body
                .deniedPermissions
            );

      const active =
        req.body?.active ===
        undefined
          ? Boolean(
              current.active
            )
          : Boolean(
              req.body.active
            );

      /*
       * Safety:
       * Admin cannot disable their own
       * currently authenticated account.
       */
      if (
        targetId === actor.id &&
        !active
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "Du kannst dein eigenes Admin-Konto nicht deaktivieren.",
          });
      }

      if (
        targetId === actor.id &&
        role !== "ADMIN"
      ) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "Du kannst dir selbst nicht die Admin-Rolle entziehen.",
          });
      }

      const displayName =
        req.body?.displayName ===
        undefined
          ? String(
              current.display_name
            )
          : String(
              req.body.displayName
            ).trim();

      if (!displayName) {
        return res
          .status(422)
          .json({
            ok: false,
            error:
              "Anzeigename darf nicht leer sein.",
          });
      }

      const profileNote =
        req.body?.profileNote ===
        undefined
          ? current.profile_note
          : (
              String(
                req.body.profileNote ||
                ""
              ).trim() ||
              null
            );

      const result =
        await db.query(
          `
            UPDATE staff_users
            SET
              display_name = $2,
              role = $3,
              job_key = $4,
              default_workspace = $5,
              allowed_workspaces =
                $6::jsonb,
              permissions =
                $7::jsonb,
              denied_permissions =
                $8::jsonb,
              active = $9,
              profile_note = $10,

              approved_at =
                CASE
                  WHEN approved_at
                    IS NULL
                    THEN NOW()
                  ELSE approved_at
                END,

              approved_by =
                CASE
                  WHEN approved_by
                    IS NULL
                    THEN $11
                  ELSE approved_by
                END,

              token_version =
                token_version + 1,

              updated_at = NOW()

            WHERE id = $1

            RETURNING
              id,
              username,
              display_name,
              role,
              job_key,
              default_workspace,
              allowed_workspaces,
              permissions,
              denied_permissions,
              profile_note,
              avatar_url,
              active,
              approved_at,
              approved_by
          `,
          [
            targetId,
            displayName,
            role,
            jobKey,
            defaultWorkspace,

            JSON.stringify(
              allowedWorkspaces
            ),

            JSON.stringify(
              permissions
            ),

            JSON.stringify(
              deniedPermissions
            ),

            active,
            profileNote,
            actor.id,
          ]
        );

      await db.query(
        `
          INSERT INTO staff_activity (
            staff_user_id,
            action,
            entity_type,
            entity_id
          )
          VALUES (
            $1,
            'STAFF_ACCESS_UPDATED',
            'STAFF_USER',
            $2
          )
        `,
        [
          actor.id,
          targetId,
        ]
      );

      return res.json({
        ok: true,
        user:
          publicUser(
            result.rows[0]
          ),
      });

    } catch (error) {

      console.error(
        "STAFF ADMIN UPDATE ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Mitarbeiter konnte nicht aktualisiert werden.",
        });
    }
  }
);

/* =========================================================
   LOGOUT
========================================================= */

router.post(
  "/logout",
  requireStaffAuth,
  async (_req, res) => {
    try {
      const user =
        getStaffUser(res);

      const sessionId =
        res.locals
          .staffSessionId;

      const client =
        await db.connect();

      try {
        await client.query(
          "BEGIN"
        );

        await client.query(
          `
            UPDATE staff_sessions
            SET revoked_at = NOW()
            WHERE id = $1
          `,
          [sessionId]
        );

        await client.query(
          `
            INSERT INTO staff_activity (
              staff_user_id,
              action,
              entity_type,
              entity_id
            )
            VALUES (
              $1,
              'LOGOUT',
              'STAFF_SESSION',
              $2
            )
          `,
          [
            user.id,
            sessionId,
          ]
        );

        await client.query(
          "COMMIT"
        );
      } catch (error) {
        await client.query(
          "ROLLBACK"
        );
        throw error;
      } finally {
        client.release();
      }

      return res.json({
        ok: true,
      });
    } catch (error) {
      console.error(
        "STAFF LOGOUT ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Abmeldung konnte nicht durchgefÃƒÆ’Ã‚Â¼hrt werden.",
        });
    }
  }
);

export default router;












