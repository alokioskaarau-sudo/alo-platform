import {
  Router,
} from "express";

import {
  getStaffUser,
  requireStaffAuth,
} from "../middleware/staffAuth.js";

import {
  deactivateStaffPushToken,
  registerStaffPushToken,
} from "../database/staffPush.js";

const staffPushRouter =
  Router();

staffPushRouter.post(
  "/register",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const staffSessionId =
        String(
          res.locals.staffSessionId ??
          ""
        );

      const expoPushToken =
        String(
          req.body?.expoPushToken ??
          ""
        ).trim();

      const platform =
        String(
          req.body?.platform ??
          ""
        ).toLowerCase();

      const deviceName =
        req.body?.deviceName
          ? String(
              req.body.deviceName
            ).slice(0, 200)
          : null;

      if (
        !staffSessionId ||
        !expoPushToken ||
        (
          platform !== "ios" &&
          platform !== "android"
        )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Push-Registrierung unvollständig.",
          });
      }

      const token =
        await registerStaffPushToken({
          staffUserId:
            staffUser.id,
          staffSessionId,
          expoPushToken,
          platform,
          deviceName,
        });

      return res.json({
        ok: true,
        token: {
          id:
            String(token.id),
          active:
            Boolean(token.active),
        },
      });
    } catch (error: any) {
      console.error(
        "STAFF PUSH REGISTER ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ??
            "Push-Registrierung fehlgeschlagen.",
        });
    }
  }
);

staffPushRouter.post(
  "/unregister",
  requireStaffAuth,
  async (req, res) => {
    try {
      const staffUser =
        getStaffUser(res);

      const expoPushToken =
        String(
          req.body?.expoPushToken ??
          ""
        ).trim();

      if (!expoPushToken) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Push Token fehlt.",
          });
      }

      await deactivateStaffPushToken({
        staffUserId:
          staffUser.id,
        expoPushToken,
      });

      return res.json({
        ok: true,
      });
    } catch (error) {
      console.error(
        "STAFF PUSH UNREGISTER ERROR",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Push-Abmeldung fehlgeschlagen.",
        });
    }
  }
);

export default staffPushRouter;
