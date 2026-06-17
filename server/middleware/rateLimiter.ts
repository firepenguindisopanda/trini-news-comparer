/**
 * Redis-backed rate‑limiting middleware.
 *
 * Uses the Upstash Redis REST client (not a local Lua script) so it works
 * in serverless/edge environments as well as on Render.
 *
 * Usage:
 *   app.use("/api/news/compare", rateLimiter({ max: 10, windowSec: 60 }));
 */

import { Request, Response, NextFunction } from "express";
import { checkRateLimit } from "../services/cache.js";

export interface RateLimiterOptions {
  /** Maximum requests in the window (default: 30). */
  max?: number;
  /** Window size in seconds (default: 60). */
  windowSec?: number;
  /** Optional key prefix (default: "rate:default"). */
  prefix?: string;
}

/**
 * Factory that returns an Express middleware function.
 */
export function rateLimiter(opts: RateLimiterOptions = {}) {
  const { max = 30, windowSec = 60, prefix = "rate:default" } = opts;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Use X-Forwarded-For if behind a proxy (Render, Cloudflare), else remote IP.
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)
        ?.split(",")[0]
        ?.trim() || req.socket.remoteAddress ||
      "unknown";

    const key = `${prefix}:${ip}`;

    const { allowed, remaining, resetIn } = await checkRateLimit(
      key,
      max,
      windowSec,
    );

    // Always set standard rate‑limit headers (RFC 6585).
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + resetIn));

    if (!allowed) {
      res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfterSeconds: resetIn,
      });
      return;
    }

    next();
  };
}
