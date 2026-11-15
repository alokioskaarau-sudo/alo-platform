import { randomBytes } from "node:crypto";
import { renderHuntPage } from "../modules/cityHunt/page.js";
import huntSessionRouter from "./cityHunt.session.routes.js";
import { Router } from "express";
import {
  cashBudgetRappen,
  cityHuntEvent,
} from "../modules/cityHunt/event.js";

const router = Router();

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Vorläufiger Eventplan, noch ohne Verbindung zum Live-Spielstand.
router.get("/event", (_req, res) => {
  return res.json({
    ok: true,
    phase: "FOUNDATION",
    source: "DRAFT_PLAN",
    event: cityHuntEvent,
    cashBudgetRappen,
    message: "Termin folgt. Anmeldung noch geschlossen.",
  });
});

// Es werden ausdrücklich keine Teilnehmerdaten gespeichert.
router.post("/register", (_req, res) => {
  return res.status(403).json({
    ok: false,
    code: "REGISTRATION_CLOSED",
    error: "Die Anmeldung ist noch nicht geöffnet.",
  });
});

router.use(huntSessionRouter);


router.get("/play", (_req, res) => {
  const nonce = randomBytes(24).toString("base64url");
  res.setHeader("Content-Security-Policy", [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data: https://tile.openstreetmap.org",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; "));
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.type("html").send(renderHuntPage(nonce));
});

export default router;
