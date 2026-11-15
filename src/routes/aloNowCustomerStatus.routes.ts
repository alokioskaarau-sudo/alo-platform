import { buildAloNowCustomerTimeline } from "../modules/aloNow/aloNowCustomerTimeline.js";

import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "../database/db.js";

export const aloNowCustomerStatusRouter = Router();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

aloNowCustomerStatusRouter.get(
  "/order-requests/:requestId/customer-status",
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");

    if (process.env.ALO_NOW_REQUESTS_ENABLED !== "true") {
      return res.status(503).json({
        ok: false,
        error: "ALO_NOW_REQUESTS_NOT_ENABLED"
      });
    }

    const requestId = String(req.params.requestId ?? "");
    const token = req.get("x-alo-customer-token") ?? "";

    if (!UUID_PATTERN.test(requestId) ||
        !TOKEN_PATTERN.test(token)) {
      return res.status(404).json({
        ok: false,
        error: "REQUEST_NOT_FOUND"
      });
    }

    try {
      const result = await db.query<{
        id: string;
        status: string;
        created_at: Date;
        updated_at: Date;
        customer_status_token_hash: string | null;
      }>(
        `SELECT id, status, created_at, updated_at,
                customer_status_token_hash
         FROM alo_now_order_requests
         WHERE id = $1::uuid
         LIMIT 1`,
        [requestId]
      );

      const row = result.rows[0];
      const storedHash = row?.customer_status_token_hash;

      if (!row ||
          typeof storedHash !== "string" ||
          !/^[0-9a-f]{64}$/i.test(storedHash)) {
        return res.status(404).json({
          ok: false,
          error: "REQUEST_NOT_FOUND"
        });
      }

      const actualHash = createHash("sha256")
        .update(token)
        .digest();

      const expectedHash = Buffer.from(storedHash, "hex");

      if (!timingSafeEqual(actualHash, expectedHash)) {
        return res.status(404).json({
          ok: false,
          error: "REQUEST_NOT_FOUND"
        });
      }

      return res.status(200).json({
        ok: true,
        requestId: row.id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        timeline: buildAloNowCustomerTimeline(
          row.status,
          new Date(row.created_at)
        )
      });

    } catch (error) {
      console.error(
        "ALO NOW CUSTOMER STATUS ERROR",
        error instanceof Error ? error.name : "UNKNOWN"
      );

      return res.status(503).json({
        ok: false,
        error: "CUSTOMER_STATUS_UNAVAILABLE"
      });
    }
  }
);
