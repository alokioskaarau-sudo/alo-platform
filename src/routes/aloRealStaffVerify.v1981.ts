// @ts-nocheck
import { Router } from "express";
import { db } from "../database/db.js";
import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const router = Router();
const scrypt = promisify(scryptCallback);
function productionReady() {
    return process.env.ALO_STAFF_BRIDGE_VERIFY_ENABLED === "YES" &&
        process.env.ALO_RUNTIME_MODE !== "staging" &&
        process.env.RAILWAY_ENVIRONMENT_NAME !== "staging" &&
        String(process.env.ALO_STAFF_BRIDGE_SERVICE_KEY || "").length >= 32;
}
function safeEquals(a, b) {
    const aa = Buffer.from(a), bb = Buffer.from(b);
    return aa.length === bb.length && timingSafeEqual(aa, bb);
}
async function verifyCredential(credential, storedHash) {
    const [alg, salt, expectedHex] = storedHash.split("$");
    if (alg !== "scrypt" || !salt || !expectedHex || !/^[0-9a-f]+$/i.test(expectedHex) ||
        expectedHex.length % 2 !== 0)
        return false;
    const expected = Buffer.from(expectedHex, "hex");
    if (!expected.length || expected.length > 128)
        return false;
    const actual = await scrypt(credential, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const attempts = new Map();
router.post("/staging-verify", async (req, res) => {
    if (!productionReady())
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const given = String(req.get("X-ALO-Staging-Service-Key") || "");
    const secret = String(process.env.ALO_STAFF_BRIDGE_SERVICE_KEY || "");
    if (!safeEquals(given, secret))
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    const username = String(req.body?.username || "").trim().toLowerCase();
    const credential = String(req.body?.credential || "");
    if (!username || !credential || username.length > 100 || credential.length > 256)
        return res.status(422).json({ ok: false, error: "INVALID_INPUT" });
    const now = Date.now(), previous = attempts.get(username);
    if (previous && previous.until > now && previous.count >= 5)
        return res.status(429).json({ ok: false, error: "RATE_LIMITED" });
    attempts.set(username, { count: previous && previous.until > now ? previous.count + 1 : 1, until: now + 15 * 60 * 1000 });
    if (attempts.size > 10000)
        for (const [k, v] of attempts)
            if (v.until <= now)
                attempts.delete(k);
    try {
        const r = await db.query(`SELECT id,username,display_name,role,pin_hash,password_hash
         FROM staff_users WHERE LOWER(username)=$1 AND active=TRUE LIMIT 1`, [username]);
        const user = r.rows[0];
        let valid = false;
        if (user) {
            for (const hash of [user.pin_hash, user.password_hash]) {
                if (typeof hash === "string" && hash && await verifyCredential(credential, hash)) {
                    valid = true;
                    break;
                }
            }
        }
        if (!valid)
            return res.status(401).json({ ok: false, error: "Anmeldung fehlgeschlagen." });
        attempts.delete(username);
        res.setHeader("Cache-Control", "no-store");
        return res.json({ ok: true, user: {
                id: String(user.id), username: String(user.username),
                displayName: String(user.display_name), role: String(user.role)
            } });
    }
    catch {
        return res.status(503).json({ ok: false, error: "AUTH_SERVICE_UNAVAILABLE" });
    }
});
export default router;
