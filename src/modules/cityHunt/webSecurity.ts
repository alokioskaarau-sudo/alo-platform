import type { Request, Response, NextFunction } from "express";

export const HUNT_COOKIE = "__Host-alo_hunt_session";

export function huntWebOrigin(): string {
  const raw = process.env.HUNT_PUBLIC_ORIGIN ||
    "https://alo-platform-production.up.railway.app";
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("INVALID_HUNT_PUBLIC_ORIGIN");
  }
  return url.origin;
}

export function requireHuntWeb(
  _req: Request, res: Response, next: NextFunction
) {
  if (process.env.HUNT_WEB_ENABLED !== "true") {
    return res.status(503).json({
      ok: false,
      code: "HUNT_WEB_NOT_READY",
      error: "Der Spielerpass ist noch nicht öffentlich verfügbar.",
    });
  }
  next();
}

export function requireHuntSameOrigin(
  req: Request, res: Response, next: NextFunction
) {
  if (
    req.get("Origin") !== huntWebOrigin() ||
    req.get("X-ALO-Hunt") !== "1" ||
    !req.is("application/json")
  ) {
    return res.status(403).json({
      ok: false, code: "REQUEST_NOT_ALLOWED",
    });
  }
  next();
}

export function readHuntSession(req: Request): string | null {
  const matches = (req.headers.cookie || "")
    .split(";")
    .map(value => value.trim())
    .filter(value => value.startsWith(HUNT_COOKIE + "="));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(HUNT_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function setHuntSession(res: Response, code: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    throw new Error("INVALID_SESSION_CODE");
  }
  res.cookie(HUNT_COOKIE, code, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearHuntSession(res: Response) {
  res.clearCookie(HUNT_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
}
