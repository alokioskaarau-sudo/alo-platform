import {
  Request,
  Response,
  NextFunction,
} from "express";

import {
  createHmac,
  timingSafeEqual,
} from "crypto";


const COOKIE_NAME =
  "alo_dashboard_session";

const SESSION_DURATION_MS =
  12 * 60 * 60 * 1000;


function safeEqual(
  a: string,
  b: string
): boolean {

  const aa =
    Buffer.from(String(a));

  const bb =
    Buffer.from(String(b));

  if (
    aa.length !==
    bb.length
  ) {
    return false;
  }

  return timingSafeEqual(
    aa,
    bb
  );
}


function dashboardCode(): string {

  return String(
    process.env.SHIPPING_DASHBOARD_CODE ||
    ""
  ).trim();
}


function sessionSecret(): string {

  return String(
    process.env.SHIPPING_DASHBOARD_SESSION_SECRET ||
    ""
  ).trim();
}


function createSignature(
  expires: string
): string {

  return createHmac(
    "sha256",
    sessionSecret()
  )
    .update(expires)
    .digest("hex");
}


function readCookie(
  req: Request,
  name: string
): string | null {

  const header =
    req.headers.cookie || "";

  for (
    const part of header.split(";")
  ) {

    const index =
      part.indexOf("=");

    if (
      index === -1
    ) {
      continue;
    }

    const key =
      part
        .slice(0, index)
        .trim();

    const value =
      part
        .slice(index + 1)
        .trim();

    if (
      key === name
    ) {

      try {

        return decodeURIComponent(
          value
        );

      } catch {

        return null;
      }
    }
  }

  return null;
}


export function verifyDashboardCode(
  code: string
): boolean {

  const expected =
    dashboardCode();

  if (
    !expected
  ) {
    return false;
  }

  return safeEqual(
    String(code).trim(),
    expected
  );
}


export function createDashboardSession(
  res: Response
): void {

  const expires =
    String(
      Date.now() +
      SESSION_DURATION_MS
    );

  const signature =
    createSignature(
      expires
    );

  const token =
    `${expires}.${signature}`;

  const secure =
    process.env.NODE_ENV ===
      "production"
      ? "; Secure"
      : "";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`
  );
}


export function clearDashboardSession(
  res: Response
): void {

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}


function validSession(
  req: Request
): boolean {

  if (
    !sessionSecret()
  ) {
    return false;
  }

  const token =
    readCookie(
      req,
      COOKIE_NAME
    );

  if (
    !token
  ) {
    return false;
  }

  const parts =
    token.split(".");

  if (
    parts.length !== 2
  ) {
    return false;
  }

  const [
    expires,
    signature,
  ] = parts;

  const timestamp =
    Number(expires);

  if (
    !Number.isFinite(timestamp) ||
    timestamp <= Date.now()
  ) {
    return false;
  }

  const expected =
    createSignature(
      expires
    );

  return safeEqual(
    signature,
    expected
  );
}


export function requireShippingDashboardAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {

  if (
    validSession(req)
  ) {
    return next();
  }

  if (
    req.path === "/shipping"
  ) {

    return res.redirect(
      "/shipping/login"
    );
  }

  return res
    .status(401)
    .json({
      ok: false,
      error:
        "Anmeldung erforderlich.",
    });
}
