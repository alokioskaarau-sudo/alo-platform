// @ts-nocheck
import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../database/db.js";
const router = Router();
const PROD = "https://alo-platform-production.up.railway.app";
const enabled = () => (process.env.ALO_RUNTIME_MODE === "staging" ||
    process.env.RAILWAY_ENVIRONMENT_NAME === "staging") &&
    process.env.ALO_STAGING_ISOLATION_APPROVED === "YES" &&
    process.env.ALO_STAFF_BRIDGE_STAGING_ENABLED === "YES";
const key = () => process.env.ALO_STAFF_BRIDGE_SERVICE_KEY || "";
const isReady = () => enabled() && key().length >= 32;
async function callProd(path, options = {}) {
    return fetch(PROD + path, {
        ...options,
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
}
// Staging only; original router remains active outside staging.
router.get("/users", async (_req, res, next) => {
    if (!enabled())
        return next();
    if (!isReady())
        return res.status(503).json({ ok: false, error: "STAFF_BRIDGE_NOT_CONFIGURED" });
    try {
        const r = await callProd("/api/staff-auth/users");
        if (!r.ok)
            throw new Error("upstream");
        const data = await r.json();
        if (!data?.ok || !Array.isArray(data.users))
            throw new Error("invalid");
        res.setHeader("Cache-Control", "no-store");
        return res.json({ ok: true, users: data.users });
    }
    catch {
        return res.status(503).json({ ok: false, error: "ORIGINAL_STAFF_LIST_UNAVAILABLE" });
    }
});
// Only a first-line throttle. Production must independently limit verification.
const attempts = new Map();
router.post("/login", async (req, res, next) => {
    if (!enabled())
        return next();
    if (!isReady())
        return res.status(503).json({ ok: false, error: "STAFF_BRIDGE_NOT_CONFIGURED" });
    const username = String(req.body?.username || "").trim().toLowerCase();
    const credential = String(req.body?.credential || "");
    if (!username || !credential || username.length > 100 || credential.length > 256)
        return res.status(422).json({ ok: false, error: "INVALID_LOGIN_INPUT" });
    const source = String(req.ip || "unknown");
    const limitKey = `${source}:${username}`;
    const now = Date.now();
    const prev = attempts.get(limitKey);
    if (prev && prev.until > now && prev.count >= 5)
        return res.status(429).json({ ok: false, error: "ZU_VIELE_VERSUCHE" });
    attempts.set(limitKey, { count: prev && prev.until > now ? prev.count + 1 : 1, until: now + 15 * 60 * 1000 });
    if (attempts.size > 10000) {
        for (const [k, v] of attempts)
            if (v.until <= now)
                attempts.delete(k);
    }
    try {
        const upstream = await callProd("/api/staff-auth/staging-verify", {
            method: "POST",
            headers: { "X-ALO-Staging-Service-Key": key() },
            body: JSON.stringify({ username, credential })
        });
        if (upstream.status === 401)
            return res.status(401).json({ ok: false, error: "Anmeldung fehlgeschlagen." });
        if (!upstream.ok)
            return res.status(503).json({ ok: false, error: "ORIGINAL_AUTH_UNAVAILABLE" });
        const data = await upstream.json();
        const verified = data?.user;
        if (!data?.ok || !verified || String(verified.username).toLowerCase() !== username ||
            !/^[a-z0-9-]{12,72}$/i.test(String(verified.id)) ||
            !["ADMIN", "MANAGER", "STAFF", "PRAKTIKANT"].includes(String(verified.role))) {
            return res.status(502).json({ ok: false, error: "INVALID_VERIFIED_IDENTITY" });
        }
        // Dedicated usernames cannot collide with legacy staging test accounts.
        const localUsername = "alo_origin_" + String(verified.id).replace(/[^a-z0-9]/gi, "").toLowerCase();
        const displayName = String(verified.displayName || "").trim();
        if (!displayName || displayName.length > 150)
            throw new Error("invalid_display_name");
        const token = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const client = await db.connect();
        let local;
        try {
            await client.query("BEGIN");
            // Preserve verified role for staging RBAC; the staging firewall remains mandatory.
            // Unique on username ensures no accidental reuse of original staging users.
            await client.query(`INSERT INTO staff_users
          (username,display_name,role,default_workspace,allowed_workspaces,active)
         VALUES ($1,$2,$3,'ONLINE','["ONLINE"]'::jsonb,TRUE)
         ON CONFLICT DO NOTHING`, [localUsername, displayName, "STAFF"]);
            const found = await client.query(`SELECT id,username,display_name,role,active,default_workspace,allowed_workspaces
           FROM staff_users WHERE username = $1 LIMIT 1`, [localUsername]);
            local = found.rows[0];
            if (!local || !local.active || local.display_name !== displayName ||
                local.role !== "STAFF")
                throw new Error("STAGING_IDENTITY_CONFLICT");
            await client.query(`INSERT INTO staff_sessions
         (staff_user_id,token_hash,device_name,device_platform,expires_at)
         VALUES($1,$2,$3,$4,$5)`, [local.id, tokenHash, "ALO STAFF Verified Staging", "IOS_STAGING", expiresAt]);
            await client.query("COMMIT");
        }
        catch (e) {
            await client.query("ROLLBACK");
            throw e;
        }
        finally {
            client.release();
        }
        attempts.delete(limitKey);
        res.setHeader("Cache-Control", "no-store");
        return res.json({
            ok: true, token, expiresAt: expiresAt.toISOString(),
            user: {
                id: String(local.id), username: localUsername, displayName,
                role: "STAFF", jobKey: "sales", jobKeys: ["sales"],
                defaultWorkspace: "ONLINE", allowedWorkspaces: ["ONLINE"],
                permissions: [], deniedPermissions: [], profileNote: null,
                avatarUrl: null, active: true, approvedAt: null, approvedBy: null
            }
        });
    }
    catch {
        return res.status(503).json({ ok: false, error: "STAGING_LOGIN_FAILED" });
    }
});
export default router;
