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
  capabilitiesForRole,
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

function publicUser(
  row: any
) {
  const role =
    String(row.role) as
      import("../middleware/staffAuth.js").StaffRole;

  return {
    id: String(row.id),

    username:
      String(row.username),

    displayName:
      String(row.display_name),

    role,

    defaultWorkspace:
      String(
        row.default_workspace
      ),

    allowedWorkspaces:
      Array.isArray(
        row.allowed_workspaces
      )
        ? row.allowed_workspaces
        : [],

    capabilities:
      capabilitiesForRole(role),
  };
}

/*
 * Bootstrap-Helfer:
 * wird spÃƒÂ¤ter fÃƒÂ¼r die initialen
 * Mitarbeiterkonten genutzt.
 *
 * Keine Route gibt Hashes zurÃƒÂ¼ck.
 */
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
          "Bitte einen gültigen Namen eingeben.",
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
     * öffentlichen Request übernehmen.
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
     * Die tatsächlichen Funktionen kommen
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
              credential_hash,
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
              $6::TEXT[],
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
            allowedWorkspaces,
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
        error: "UngÃƒÂ¼ltige Mitarbeiterrolle.",
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
          "Manager dÃƒÂ¼rfen nur STAFF- oder PRAKTIKANT-Profile erstellen.",
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
        error: "UngÃƒÂ¼ltiger Workspace.",
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
        error: "UngÃƒÂ¼ltiges Transportmittel.",
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
   - niemals Token-Hashes zurÃƒÂ¼ckgeben
   - bestehende offene FIRST_PIN Tokens werden widerrufen
   - Token ist kurzlebig
   - nur fÃƒÂ¼r Accounts ohne bestehende PIN
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
            "Keine Berechtigung fÃƒÂ¼r Mitarbeiter-Einrichtung.",
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
              "FÃƒÂ¼r diesen Mitarbeiter ist bereits ein PIN eingerichtet.",
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
       * 15 Minuten reichen fÃƒÂ¼r die
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
         * In der DB liegt ausschlieÃƒÅ¸lich SHA-256.
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
              "Die PINs stimmen nicht ÃƒÂ¼berein.",
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
            "Anmeldung konnte nicht durchgefÃƒÂ¼hrt werden.",
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
    const user =
      getStaffUser(res);

    return res.json({
      ok: true,

      user: {
        ...user,

        capabilities:
          capabilitiesForRole(
            user.role
          ),
      },
    });
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
            "Abmeldung konnte nicht durchgefÃƒÂ¼hrt werden.",
        });
    }
  }
);

export default router;


