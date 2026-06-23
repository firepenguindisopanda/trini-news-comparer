/**
 * Redis-backed rate‑limiting middleware using @upstash/ratelimit.
 *
 * Uses sliding window algorithm for smooth rate enforcement.
 * Drops back to allow-all when Redis is unavailable.
 *
 * Usage:
 *   app.get("/api/news/latest", rateLimiter({ max: 30, windowSec: 60 }), handler);
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { Request, Response, NextFunction } from "express";

import { childLogger } from "../services/logger.js";

const log = childLogger({ module: "rateLimiter" });

export interface RateLimiterOptions {
  /** Maximum requests in the window (default: 30). */
  max?: number;
  /** Window size in seconds (default: 60). */
  windowSec?: number;
  /** Optional key prefix (default: "default"). */
  prefix?: string;
}

// ---------------------------------------------------------------------------
// Redis client factory (matches cache.ts convention)
// ---------------------------------------------------------------------------

function createRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;
  if (!url || !token) {
    log.warn("UPSTASH_REDIS_URL/TOKEN not set - rate limiting disabled");
    return null;
  }
  try {
    return new Redis({ url, token });
  } catch (err) {
    log.error({ err }, "Failed to initialise Redis for rate limiter");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Module‑level Ratelimit instance cache (create once per config)
// ---------------------------------------------------------------------------

const limiters = new Map<string, Ratelimit | null>();

function getLimiter(
  prefix: string,
  max: number,
  windowSec: number,
): Ratelimit | null {
  const key = `${prefix}:${max}:${windowSec}`;
  let limiter = limiters.get(key);
  if (limiter !== undefined) return limiter;

  const redis = createRedis();
  if (!redis) {
    limiters.set(key, null);
    return null;
  }

  limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(max, `${windowSec} s`),
    prefix: `rate:${prefix}`,
    analytics: true,
    // Fail open if Redis takes too long
    timeout: 1000,
  });

  limiters.set(key, limiter);
  return limiter;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function rateLimiter(opts: RateLimiterOptions = {}) {
  const { max = 30, windowSec = 60, prefix = "default" } = opts;

  return async (req: Request, res: Response, next: NextFunction) => {
    const limiter = getLimiter(prefix, max, windowSec);

    // No Redis → allow-all
    if (!limiter) {
      next();
      return;
    }

    // Caller identifier: X-Forwarded-For behind nginx, else remote IP
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)
        ?.split(",")[0]
        ?.trim() || req.socket.remoteAddress ||
      "unknown";

    const { success, limit, remaining, reset } = await limiter.limit(ip);

    // Standard rate‑limit headers (RFC 6585)
    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(reset / 1000)));

    if (!success) {
      res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfterSeconds: Math.max(1, Math.ceil((reset - Date.now()) / 1000)),
      });
      return;
    }

    next();
  };
}
