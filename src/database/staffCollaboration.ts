import { db } from "./db.js";

export type AloChannelType =
  | "GLOBAL"
  | "WORKSPACE"
  | "DRIVERS"
  | "DIRECT";

export type AloChatChannel = {
  id: string;
  channel_key: string;
  name: string;
  channel_type: AloChannelType;
  workspace: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AloChatMessage = {
  id: string;
  channel_id: string;
  sender_user_id: string;
  body: string;
  created_at: Date;
  updated_at: Date;
  sender_display_name?: string | null;
  sender_username?: string | null;
};

export async function ensureDefaultChannels() {
  const channels = [
    {
      key: "crew",
      name: "ALO Crew",
      type: "GLOBAL",
      workspace: null,
    },
    {
      key: "drivers",
      name: "ALO Fahrer",
      type: "DRIVERS",
      workspace: null,
    },
    {
      key: "aarau",
      name: "Aarau",
      type: "WORKSPACE",
      workspace: "aarau",
    },
    {
      key: "olten",
      name: "Olten",
      type: "WORKSPACE",
      workspace: "olten",
    },
    {
      key: "online",
      name: "Online",
      type: "WORKSPACE",
      workspace: "online",
    },
  ];

  for (const channel of channels) {
    await db.query(
      `
        INSERT INTO staff_chat_channels (
          channel_key,
          name,
          channel_type,
          workspace
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (channel_key)
        DO UPDATE SET
          name = EXCLUDED.name,
          channel_type = EXCLUDED.channel_type,
          workspace = EXCLUDED.workspace,
          updated_at = NOW()
      `,
      [
        channel.key,
        channel.name,
        channel.type,
        channel.workspace,
      ]
    );
  }
}

export async function listChatChannels() {
  const result =
    await db.query<AloChatChannel>(
      `
        SELECT
          id,
          channel_key,
          name,
          channel_type,
          workspace,
          created_at,
          updated_at
        FROM staff_chat_channels
        WHERE is_active = TRUE
        ORDER BY
          CASE channel_key
            WHEN 'crew' THEN 1
            WHEN 'drivers' THEN 2
            WHEN 'aarau' THEN 3
            WHEN 'olten' THEN 4
            WHEN 'online' THEN 5
            ELSE 100
          END,
          name ASC
      `
    );

  return result.rows;
}

export async function listChannelMessages(
  channelId: string,
  limit = 100
) {
  const safeLimit =
    Math.max(
      1,
      Math.min(Number(limit) || 100, 200)
    );

  const result =
    await db.query<AloChatMessage>(
      `
        SELECT
          message.id,
          message.channel_id,
          message.sender_user_id,
          message.body,
          message.created_at,
          message.updated_at,
          staff.display_name
            AS sender_display_name,
          staff.username
            AS sender_username
        FROM staff_chat_messages message
        JOIN staff_users staff
          ON staff.id =
            message.sender_user_id
        WHERE
          message.channel_id = $1
          AND message.deleted_at IS NULL
        ORDER BY
          message.created_at DESC
        LIMIT $2
      `,
      [channelId, safeLimit]
    );

  return result.rows.reverse();
}

export async function createChatMessage(
  channelId: string,
  senderUserId: string,
  body: string
) {
  const cleanBody =
    String(body || "").trim();

  if (!cleanBody) {
    throw new Error(
      "Nachricht darf nicht leer sein."
    );
  }

  if (cleanBody.length > 4000) {
    throw new Error(
      "Nachricht ist zu lang."
    );
  }

  const result =
    await db.query<AloChatMessage>(
      `
        INSERT INTO staff_chat_messages (
          channel_id,
          sender_user_id,
          body
        )
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [
        channelId,
        senderUserId,
        cleanBody,
      ]
    );

  return result.rows[0];
}

export async function getOrCreateDirectChannel(
  firstUserId: string,
  secondUserId: string
) {
  if (firstUserId === secondUserId) {
    throw new Error(
      "Direktchat mit sich selbst ist nicht möglich."
    );
  }

  const members =
    [firstUserId, secondUserId]
      .map(String)
      .sort(
        (a, b) =>
          Number(a) - Number(b)
      );

  const key =
    `dm:${members[0]}:${members[1]}`;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const channelResult =
      await client.query<AloChatChannel>(
        `
          INSERT INTO staff_chat_channels (
            channel_key,
            name,
            channel_type
          )
          VALUES (
            $1,
            'Direktnachricht',
            'DIRECT'
          )
          ON CONFLICT (channel_key)
          DO UPDATE SET
            updated_at = staff_chat_channels.updated_at
          RETURNING
            id,
            channel_key,
            name,
            channel_type,
            workspace,
            created_at,
            updated_at
        `,
        [key]
      );

    const channel =
      channelResult.rows[0];

    for (const memberId of members) {
      await client.query(
        `
          INSERT INTO staff_chat_members (
            channel_id,
            staff_user_id
          )
          VALUES ($1, $2)
          ON CONFLICT (
            channel_id,
            staff_user_id
          )
          DO NOTHING
        `,
        [channel.id, memberId]
      );
    }

    await client.query("COMMIT");

    return channel;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listDirectChannels(
  staffUserId: string
) {
  const result =
    await db.query(
      `
        SELECT
          channel.id,
          channel.channel_key,
          channel.name,
          channel.channel_type,
          channel.updated_at,

          other_user.id
            AS other_user_id,

          other_user.display_name
            AS other_display_name,

          other_user.username
            AS other_username,

          latest.body
            AS latest_message,

          latest.created_at
            AS latest_message_at

        FROM staff_chat_members mine

        JOIN staff_chat_channels channel
          ON channel.id =
            mine.channel_id
          AND channel.channel_type =
            'DIRECT'

        JOIN staff_chat_members other_member
          ON other_member.channel_id =
            channel.id
          AND other_member.staff_user_id <>
            $1

        JOIN staff_users other_user
          ON other_user.id =
            other_member.staff_user_id

        LEFT JOIN LATERAL (
          SELECT
            body,
            created_at
          FROM staff_chat_messages
          WHERE
            channel_id = channel.id
            AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) latest ON TRUE

        WHERE mine.staff_user_id = $1

        ORDER BY
          COALESCE(
            latest.created_at,
            channel.updated_at
          ) DESC
      `,
      [staffUserId]
    );

  return result.rows;
}


export async function listTasks(
  staffUserId: string
) {
  const result =
    await db.query(
      `
        SELECT
          task.*,
          creator.display_name
            AS creator_name,
          assignee.display_name
            AS assignee_name
        FROM staff_tasks task

        JOIN staff_users creator
          ON creator.id =
            task.created_by_user_id

        LEFT JOIN staff_users assignee
          ON assignee.id =
            task.assigned_to_user_id

        WHERE
          task.archived_at IS NULL
          AND (
            task.assigned_to_user_id = $1
            OR task.assigned_to_user_id IS NULL
          )

        ORDER BY
          CASE task.status
            WHEN 'OPEN' THEN 1
            WHEN 'IN_PROGRESS' THEN 2
            WHEN 'DONE' THEN 3
            ELSE 4
          END,
          task.due_at ASC NULLS LAST,
          task.created_at DESC
      `,
      [staffUserId]
    );

  return result.rows;
}

export async function createTask(input: {
  title: string;
  description?: string | null;
  createdByUserId: string;
  assignedToUserId?: string | null;
  workspace?: string | null;
  priority?: string | null;
  dueAt?: string | null;
}) {
  const title =
    String(input.title || "").trim();

  if (!title) {
    throw new Error(
      "Aufgabentitel fehlt."
    );
  }

  const result =
    await db.query(
      `
        INSERT INTO staff_tasks (
          title,
          description,
          created_by_user_id,
          assigned_to_user_id,
          workspace,
          priority,
          due_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7
        )
        RETURNING *
      `,
      [
        title,
        input.description?.trim() || null,
        input.createdByUserId,
        input.assignedToUserId || null,
        input.workspace?.trim() || null,
        input.priority || "NORMAL",
        input.dueAt || null,
      ]
    );

  return result.rows[0];
}

export async function updateTaskStatus(
  taskId: string,
  status: string
) {
  const allowed =
    new Set([
      "OPEN",
      "IN_PROGRESS",
      "DONE",
    ]);

  if (!allowed.has(status)) {
    throw new Error(
      "Ungültiger Aufgabenstatus."
    );
  }

  const result =
    await db.query(
      `
        UPDATE staff_tasks
        SET
          status = $2,
          completed_at =
            CASE
              WHEN $2 = 'DONE'
                THEN COALESCE(
                  completed_at,
                  NOW()
                )
              ELSE NULL
            END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [taskId, status]
    );

  return result.rows[0] || null;
}


export async function listCalendarEvents(
  from?: string,
  to?: string
) {
  const result =
    await db.query(
      `
        SELECT
          event.*,
          creator.display_name
            AS creator_name
        FROM staff_calendar_events event

        JOIN staff_users creator
          ON creator.id =
            event.created_by_user_id

        WHERE
          event.cancelled_at IS NULL

          AND (
            $1::timestamptz IS NULL
            OR event.ends_at >=
              $1::timestamptz
          )

          AND (
            $2::timestamptz IS NULL
            OR event.starts_at <=
              $2::timestamptz
          )

        ORDER BY
          event.starts_at ASC
      `,
      [
        from || null,
        to || null,
      ]
    );

  return result.rows;
}

export async function createCalendarEvent(
  input: {
    title: string;
    description?: string | null;
    createdByUserId: string;
    workspace?: string | null;
    startsAt: string;
    endsAt: string;
    eventType?: string | null;
  }
) {
  const title =
    String(input.title || "").trim();

  if (!title) {
    throw new Error(
      "Terminname fehlt."
    );
  }

  const result =
    await db.query(
      `
        INSERT INTO staff_calendar_events (
          title,
          description,
          created_by_user_id,
          workspace,
          starts_at,
          ends_at,
          event_type
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7
        )
        RETURNING *
      `,
      [
        title,
        input.description?.trim() || null,
        input.createdByUserId,
        input.workspace?.trim() || null,
        input.startsAt,
        input.endsAt,
        input.eventType || "GENERAL",
      ]
    );

  return result.rows[0];
}

