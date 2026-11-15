import { Router } from "express";
import {
  requireHuntWeb,
  requireHuntSameOrigin,
  readHuntSession,
  setHuntSession,
  clearHuntSession,
} from "../modules/cityHunt/webSecurity.js";

const router = Router();

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

function failure(res: import("express").Response, error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code) : "";

  const known: Record<string, number> = {
    INVALID_SESSION: 401,
    INVALID_VERIFICATION: 400,
    INVALID_LOGIN_LINK: 400,
    EVENT_NOT_AVAILABLE: 409,
    DOCUMENTS_CHANGED: 409,
    INVALID_PARTICIPATION: 400,
    EVENT_SCHEDULE_CHANGED: 409,
    EVENT_FULL: 409,
    PLAYER_NOT_READY: 409,
    PARTICIPATION_NOT_CONFIRMED: 409,
    INVALID_QUEST: 400,
    INVALID_STATION: 400,
    INVALID_STATION_ACTION: 400,
    INVALID_STATION_CODE: 400,
    INVALID_ANSWER: 400,
    STATION_NOT_CURRENT: 409,
    STATION_NOT_DISCOVERED: 409,
    QUEST_NOT_AVAILABLE: 409,
  };

  if (Object.prototype.hasOwnProperty.call(known, code)) {
    return res.status(known[code]!).json({ ok: false, code });
  }
  // Keine Datenbankfehler oder Bestätigungscodes ausgeben.
  return res.status(503).json({
    ok: false, code: "HUNT_TEMPORARILY_UNAVAILABLE",
  });
}

router.get("/pass", requireHuntWeb, async (req, res) => {
  const session = readHuntSession(req);
  if (!session) {
    return res.status(401).json({ ok: false, code: "INVALID_SESSION" });
  }
  try {
    const { getHuntPlayerPass } =
      await import("../modules/cityHunt/playerPass.js");
    const pass = await getHuntPlayerPass(session);
    return res.json({ ok: true, ...pass });
  } catch (error) {
    return failure(res, error);
  }
});

router.post(
  "/verify-contact",
  requireHuntWeb,
  requireHuntSameOrigin,
  async (req, res) => {
    try {
      const { verifyHuntContact } =
        await import("../modules/cityHunt/verification.js");
      const result = await verifyHuntContact(req.body?.code);
      setHuntSession(res, result.sessionCode);
      return res.json({ ok: true, player: result.player });
    } catch (error) {
      return failure(res, error);
    }
  }
);

router.post(
  "/login/consume",
  requireHuntWeb,
  requireHuntSameOrigin,
  async (req, res) => {
    try {
      const { consumeHuntLoginLink } =
        await import("../modules/cityHunt/login.js");
      const result = await consumeHuntLoginLink(req.body?.code);
      setHuntSession(res, result.sessionCode);
      return res.json({
        ok: true,
        player: { id: result.playerId, status: result.status },
      });
    } catch (error) {
      return failure(res, error);
    }
  }
);

router.post(
  "/logout",
  requireHuntWeb,
  requireHuntSameOrigin,
  async (req, res) => {
    const session = readHuntSession(req);
    try {
      if (session) {
        const { logoutHuntPlayer } =
          await import("../modules/cityHunt/playerPass.js");
        await logoutHuntPlayer(session);
      }
      clearHuntSession(res);
      return res.json({ ok: true });
    } catch (error) {
      return failure(res, error);
    }
  }
);

router.post(
  "/participation/confirm",
  requireHuntWeb,
  requireHuntSameOrigin,
  async (req, res) => {
    const session = readHuntSession(req);
    if (!session) {
      return res.status(401).json({ ok: false, code: "INVALID_SESSION" });
    }
    try {
      const { confirmHuntParticipation } =
        await import("../modules/cityHunt/participation.js");
      const result = await confirmHuntParticipation(session, req.body);
      return res.json(result);
    } catch (error) {
      return failure(res, error);
    }
  }
);

router.post(
  "/participation/withdraw",
  requireHuntWeb,
  requireHuntSameOrigin,
  async (req, res) => {
    const session = readHuntSession(req);
    if (!session) {
      return res.status(401).json({ ok: false, code: "INVALID_SESSION" });
    }
    if (req.body?.confirmWithdrawal !== true) {
      return res.status(400).json({
        ok: false, code: "INVALID_PARTICIPATION",
      });
    }
    try {
      const { withdrawHuntParticipation } =
        await import("../modules/cityHunt/withdrawParticipation.js");
      const result = await withdrawHuntParticipation(session);
      return res.json(result);
    } catch (error) {
      return failure(res, error);
    }
  }
);

function requireHuntGame(
  _req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  if (process.env.HUNT_GAME_ENABLED !== "true") {
    return res.status(503).json({
      ok: false, code: "HUNT_GAME_NOT_READY",
    });
  }
  next();
}

router.get(
  "/quests/:questKey",
  requireHuntWeb,
  requireHuntGame,
  async (req, res) => {
    const session = readHuntSession(req);
    if (!session) {
      return res.status(401).json({ ok: false, code: "INVALID_SESSION" });
    }
    try {
      const { getHuntQuestView } =
        await import("../modules/cityHunt/questView.js");
      const view = await getHuntQuestView(session, req.params.questKey);
      return res.json({ ok: true, ...view });
    } catch (error) {
      return failure(res, error);
    }
  }
);

router.post(
  "/quests/:questKey/stations/:stationKey/action",
  requireHuntWeb,
  requireHuntGame,
  requireHuntSameOrigin,
  async (req, res) => {
    const session = readHuntSession(req);
    if (!session) {
      return res.status(401).json({ ok: false, code: "INVALID_SESSION" });
    }
    try {
      const { performHuntStationAction } =
        await import("../modules/cityHunt/stationAction.js");
      const result = await performHuntStationAction(
        session,
        req.params.questKey,
        req.params.stationKey,
        req.body
      );
      return res.json(result);
    } catch (error) {
      return failure(res, error);
    }
  }
);

export default router;
