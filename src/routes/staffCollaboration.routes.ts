import {
  Router,
  type Response,
} from "express";

import {
  db,
} from "../database/db.js";

import {
  requireStaffAuth,
  getStaffUser,
  type AuthenticatedStaffUser,
} from "../middleware/staffAuth.js";

import {
  requireStaffCapability,
} from "../middleware/staffRbac.js";

import {
  ensureDefaultChannels,
  listChatChannels,
  listChannelMessages,
  createChatMessage,
  getOrCreateDirectChannel,
  listDirectChannels,
  listTasks,
  createTask,
  updateTaskStatus,
  listCalendarEvents,
  createCalendarEvent,
} from "../database/staffCollaboration.js";


const router = Router();


/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function normalizeWorkspace(
  value: unknown
): string | null {
  if (value == null) {
    return null;
  }

  const clean =
    String(value)
      .trim()
      .toUpperCase();

  if (
    clean !== "AARAU" &&
    clean !== "OLTEN" &&
    clean !== "ONLINE"
  ) {
    return null;
  }

  return clean;
}


function userWorkspaces(
  user: AuthenticatedStaffUser
): Set<string> {
  return new Set(
    [
      user.defaultWorkspace,
      ...(user.allowedWorkspaces || []),
    ]
      .map((value) =>
        String(value)
          .trim()
          .toUpperCase()
      )
      .filter(Boolean)
  );
}


function isDriver(
  user: AuthenticatedStaffUser
): boolean {
  return (
    user.role === "ADMIN" ||
    user.role === "MANAGER" ||
    user.jobKey === "driver"
  );
}


async function getChannel(
  channelId: string
) {
  const result =
    await db.query(
      `
        SELECT
          id,
          channel_key,
          name,
          channel_type,
          workspace,
          is_active
        FROM staff_chat_channels
        WHERE id = $1
        LIMIT 1
      `,
      [channelId]
    );

  return result.rows[0] || null;
}


async function isDirectMember(
  channelId: string,
  userId: string
): Promise<boolean> {
  const result =
    await db.query(
      `
        SELECT 1
        FROM staff_chat_members
        WHERE
          channel_id = $1
          AND staff_user_id = $2
        LIMIT 1
      `,
      [
        channelId,
        userId,
      ]
    );

  return result.rows.length > 0;
}


async function canAccessChannel(
  user: AuthenticatedStaffUser,
  channel: any
): Promise<boolean> {
  if (!channel || channel.is_active === false) {
    return false;
  }

  if (
    user.role === "ADMIN" ||
    user.role === "MANAGER"
  ) {
    return true;
  }

  const type =
    String(
      channel.channel_type || ""
    ).toUpperCase();

  if (type === "GLOBAL") {
    return true;
  }

  if (type === "DRIVERS") {
    return isDriver(user);
  }

  if (type === "WORKSPACE") {
    const workspace =
      normalizeWorkspace(
        channel.workspace
      );

    if (!workspace) {
      return false;
    }

    return userWorkspaces(user)
      .has(workspace);
  }

  if (type === "DIRECT") {
    return isDirectMember(
      String(channel.id),
      user.id
    );
  }

  return false;
}


function sendError(
  res: Response,
  error: unknown,
  fallback: string
) {
  console.error(
    "[staff-collaboration]",
    error
  );

  const message =
    error instanceof Error
      ? error.message
      : fallback;

  return res.status(500).json({
    ok: false,
    error: message || fallback,
  });
}


/*
 * ============================================================
 * AUTH FOR ALL ROUTES
 * ============================================================
 */

router.use(
  requireStaffAuth
);


/*
 * ============================================================
 * BOOTSTRAP
 * ============================================================
 */

router.get(
  "/bootstrap",
  async (_req, res) => {
    try {
      const user =
        getStaffUser(res);

      await ensureDefaultChannels();

      const [
        channels,
        directChannels,
        tasks,
        calendar,
      ] =
        await Promise.all([
          listChatChannels(),
          listDirectChannels(
            user.id
          ),
          listTasks(
            user.id
          ),
          listCalendarEvents(),
        ]);

      const visibleChannels = [];

      for (
        const channel of channels
      ) {
        if (
          await canAccessChannel(
            user,
            channel
          )
        ) {
          visibleChannels.push(
            channel
          );
        }
      }

      return res.json({
        ok: true,

        collaboration: {
          channels:
            visibleChannels,

          directChannels,

          tasks,

          calendar,
        },
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "Collaboration konnte nicht geladen werden."
      );
    }
  }
);


/*
 * ============================================================
 * CHANNELS
 * ============================================================
 */

router.get(
  "/channels",
  async (_req, res) => {
    try {
      const user =
        getStaffUser(res);

      await ensureDefaultChannels();

      const channels =
        await listChatChannels();

      const visible = [];

      for (
        const channel of channels
      ) {
        if (
          await canAccessChannel(
            user,
            channel
          )
        ) {
          visible.push(channel);
        }
      }

      return res.json({
        ok: true,
        channels: visible,
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "Chats konnten nicht geladen werden."
      );
    }
  }
);


router.get(
  "/channels/:channelId/messages",
  async (req, res) => {
    try {
      const user =
        getStaffUser(res);

      const channelId =
        String(
          req.params.channelId || ""
        ).trim();

      const channel =
        await getChannel(
          channelId
        );

      if (!channel) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Chat wurde nicht gefunden.",
          });
      }

      if (
        !await canAccessChannel(
          user,
          channel
        )
      ) {
        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Kein Zugriff auf diesen Chat.",
            code:
              "CHANNEL_ACCESS_DENIED",
          });
      }

      const limit =
        Number(
          req.query.limit || 100
        );

      const messages =
        await listChannelMessages(
          channelId,
          limit
        );

      return res.json({
        ok: true,
        channel,
        messages,
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "Nachrichten konnten nicht geladen werden."
      );
    }
  }
);


router.post(
  "/channels/:channelId/messages",
  async (req, res) => {
    try {
      const user =
        getStaffUser(res);

      const channelId =
        String(
          req.params.channelId || ""
        ).trim();

      const channel =
        await getChannel(
          channelId
        );

      if (!channel) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Chat wurde nicht gefunden.",
          });
      }

      if (
        !await canAccessChannel(
          user,
          channel
        )
      ) {
        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Kein Zugriff auf diesen Chat.",
            code:
              "CHANNEL_ACCESS_DENIED",
          });
      }

      const message =
        await createChatMessage(
          channelId,
          user.id,
          String(
            req.body?.body || ""
          )
        );

      return res
        .status(201)
        .json({
          ok: true,
          message,
        });

    } catch (error) {
      return sendError(
        res,
        error,
        "Nachricht konnte nicht gesendet werden."
      );
    }
  }
);


/*
 * ============================================================
 * DIRECT MESSAGES
 * ============================================================
 */

router.get(
  "/direct",
  async (_req, res) => {
    try {
      const user =
        getStaffUser(res);

      const channels =
        await listDirectChannels(
          user.id
        );

      return res.json({
        ok: true,
        channels,
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "Direktnachrichten konnten nicht geladen werden."
      );
    }
  }
);


router.post(
  "/direct/:userId",
  async (req, res) => {
    try {
      const user =
        getStaffUser(res);

      const targetUserId =
        String(
          req.params.userId || ""
        ).trim();

      if (!targetUserId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Mitarbeiter fehlt.",
          });
      }

      const target =
        await db.query(
          `
            SELECT
              id,
              display_name,
              username,
              active
            FROM staff_users
            WHERE id = $1
            LIMIT 1
          `,
          [targetUserId]
        );

      if (
        target.rows.length === 0 ||
        target.rows[0].active !== true
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Mitarbeiter wurde nicht gefunden.",
          });
      }

      const channel =
        await getOrCreateDirectChannel(
          user.id,
          targetUserId
        );

      return res.json({
        ok: true,
        channel,
        otherUser:
          target.rows[0],
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "Direktchat konnte nicht erstellt werden."
      );
    }
  }
);


/*
 * ============================================================
 * TASKS
 * ============================================================
 */

router.get(
  "/tasks",
  requireStaffCapability(
    "tasks.view"
  ),
  async (_req, res) => {
    try {
      const user =
        getStaffUser(res);

      const tasks =
        await listTasks(
          user.id
        );

      return res.json({
        ok: true,
        tasks,
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "Aufgaben konnten nicht geladen werden."
      );
    }
  }
);


router.post(
  "/tasks",
  requireStaffCapability(
    "tasks.manage"
  ),
  async (req, res) => {
    try {
      const user =
        getStaffUser(res);

      const assignedToUserId =
        req.body?.assignedToUserId == null
          ? null
          : String(
              req.body.assignedToUserId
            ).trim();

      if (assignedToUserId) {
        const target =
          await db.query(
            `
              SELECT id
              FROM staff_users
              WHERE
                id = $1
                AND active = TRUE
              LIMIT 1
            `,
            [assignedToUserId]
          );

        if (
          target.rows.length === 0
        ) {
          return res
            .status(400)
            .json({
              ok: false,
              error:
                "Zugewiesener Mitarbeiter existiert nicht.",
            });
        }
      }

      const workspace =
        req.body?.workspace == null ||
        String(
          req.body.workspace
        ).trim() === ""
          ? null
          : normalizeWorkspace(
              req.body.workspace
            );

      if (
        req.body?.workspace &&
        !workspace
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Ungültiger Standort.",
          });
      }

      const task =
        await createTask({
          title:
            String(
              req.body?.title || ""
            ),

          description:
            req.body?.description == null
              ? null
              : String(
                  req.body.description
                ),

          createdByUserId:
            user.id,

          assignedToUserId,

          workspace,

          priority:
            req.body?.priority == null
              ? "NORMAL"
              : String(
                  req.body.priority
                ).toUpperCase(),

          dueAt:
            req.body?.dueAt == null ||
            String(
              req.body.dueAt
            ).trim() === ""
              ? null
              : String(
                  req.body.dueAt
                ),
        });

      return res
        .status(201)
        .json({
          ok: true,
          task,
        });

    } catch (error) {
      return sendError(
        res,
        error,
        "Aufgabe konnte nicht erstellt werden."
      );
    }
  }
);


router.patch(
  "/tasks/:taskId/status",
  requireStaffCapability(
    "tasks.view"
  ),
  async (req, res) => {
    try {
      const user =
        getStaffUser(res);

      const taskId =
        String(
          req.params.taskId || ""
        ).trim();

      const access =
        await db.query(
          `
            SELECT
              id,
              assigned_to_user_id,
              created_by_user_id
            FROM staff_tasks
            WHERE
              id = $1
              AND archived_at IS NULL
            LIMIT 1
          `,
          [taskId]
        );

      if (
        access.rows.length === 0
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Aufgabe wurde nicht gefunden.",
          });
      }

      const taskRow =
        access.rows[0];

      const privileged =
        user.role === "ADMIN" ||
        user.role === "MANAGER" ||
        user.permissions?.includes(
          "tasks.manage"
        );

      const ownsTask =
        taskRow.assigned_to_user_id == null ||
        String(
          taskRow.assigned_to_user_id
        ) === user.id ||
        String(
          taskRow.created_by_user_id
        ) === user.id;

      if (
        !privileged &&
        !ownsTask
      ) {
        return res
          .status(403)
          .json({
            ok: false,
            error:
              "Du darfst diese Aufgabe nicht ändern.",
          });
      }

      const status =
        String(
          req.body?.status || ""
        ).toUpperCase();

      const task =
        await updateTaskStatus(
          taskId,
          status
        );

      return res.json({
        ok: true,
        task,
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "Aufgabenstatus konnte nicht geändert werden."
      );
    }
  }
);


/*
 * ============================================================
 * CALENDAR
 * ============================================================
 */

router.get(
  "/calendar",
  async (req, res) => {
    try {
      const user =
        getStaffUser(res);

      const from =
        req.query.from == null
          ? undefined
          : String(
              req.query.from
            );

      const to =
        req.query.to == null
          ? undefined
          : String(
              req.query.to
            );

      const events =
        await listCalendarEvents(
          from,
          to
        );

      const workspaces =
        userWorkspaces(user);

      const visible =
        events.filter(
          (event: any) => {
            if (
              user.role === "ADMIN" ||
              user.role === "MANAGER"
            ) {
              return true;
            }

            if (!event.workspace) {
              return true;
            }

            const workspace =
              normalizeWorkspace(
                event.workspace
              );

            return (
              workspace != null &&
              workspaces.has(
                workspace
              )
            );
          }
        );

      return res.json({
        ok: true,
        events: visible,
      });

    } catch (error) {
      return sendError(
        res,
        error,
        "Kalender konnte nicht geladen werden."
      );
    }
  }
);


router.post(
  "/calendar",
  requireStaffCapability(
    "tasks.manage"
  ),
  async (req, res) => {
    try {
      const user =
        getStaffUser(res);

      const workspace =
        req.body?.workspace == null ||
        String(
          req.body.workspace
        ).trim() === ""
          ? null
          : normalizeWorkspace(
              req.body.workspace
            );

      if (
        req.body?.workspace &&
        !workspace
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Ungültiger Standort.",
          });
      }

      const startsAt =
        String(
          req.body?.startsAt || ""
        ).trim();

      const endsAt =
        String(
          req.body?.endsAt || ""
        ).trim();

      if (
        !startsAt ||
        !endsAt
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Start und Ende fehlen.",
          });
      }

      const startDate =
        new Date(startsAt);

      const endDate =
        new Date(endsAt);

      if (
        Number.isNaN(
          startDate.getTime()
        ) ||
        Number.isNaN(
          endDate.getTime()
        ) ||
        endDate.getTime() <
          startDate.getTime()
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Ungültiger Zeitraum.",
          });
      }

      const event =
        await createCalendarEvent({
          title:
            String(
              req.body?.title || ""
            ),

          description:
            req.body?.description == null
              ? null
              : String(
                  req.body.description
                ),

          createdByUserId:
            user.id,

          workspace,

          startsAt,
          endsAt,

          eventType:
            req.body?.eventType == null
              ? "GENERAL"
              : String(
                  req.body.eventType
                ).toUpperCase(),
        });

      return res
        .status(201)
        .json({
          ok: true,
          event,
        });

    } catch (error) {
      return sendError(
        res,
        error,
        "Termin konnte nicht erstellt werden."
      );
    }
  }
);


export default router;
