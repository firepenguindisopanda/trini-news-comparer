/**
 * Upstash Redis Cache Service
 *
 * Provides read-through / write-through caching for:
 *   - Scraped articles (short TTL: 5 min)
 *   - LLM comparison results (long TTL: 24 h)
 *
 * Every method is safe to call even when Redis is unavailable -
 * it gracefully falls through to the live code path.
 */

import { Redis } from "@upstash/redis";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "cache" });

//
// Singleton client
//

let client: Redis | null = null;

function getClient(): Redis | null {
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;

  if (!url || !token) {
    log.warn("UPSTASH_REDIS_URL or UPSTASH_REDIS_TOKEN not set - caching disabled");
    return null;
  }

  try {
    client = new Redis({ url, token });
    log.info("Upstash Redis client initialised");
    return client;
  } catch (err) {
    log.error({ err }, "Failed to initialise Redis client");
    return null;
  }
}

//
// TTL constants (in seconds)
//

export const TTL = {
  /** Scraped articles – 5 minutes */
  SCRAPED_ARTICLES: 300,
  /** Aggregated "all articles" – 4 minutes (shorter so trending list stays fresh) */
  ALL_ARTICLES: 240,
  /** Per‑source scrape result – 5 minutes */
  SOURCE_SCRAPE: 300,
  /** LLM comparison result – 24 hours */
  COMPARISON: 86_400,
  /** Trending topic list – 1 hour */
  TRENDING: 3_600,
} as const;

//
// Generic helpers
//

async function cacheGet<T>(key: string): Promise<T | null> {
  const r = getClient();
  if (!r) return null;

  try {
    const raw = await r.get<T>(key);
    // Upstash Redis client handles JSON deserialization automatically.
    // If raw is null/undefined, the key does not exist.
    if (raw === null || raw === undefined) return null;
    return raw;
  } catch (err) {
    log.warn({ err, key }, "Cache GET error");
    return null;
  }
}

async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const r = getClient();
  if (!r) return;

  try {
    // Upstash Redis client handles JSON serialization automatically.
    // Pass the value directly, not JSON.stringify'd.
    await r.setex(key, ttlSeconds, value);
  } catch (err) {
    log.warn({ err, key }, "Cache SET error");
  }
}

async function cacheDel(key: string): Promise<void> {
  const r = getClient();
  if (!r) return;

  try {
    await r.del(key);
  } catch (err) {
    log.warn({ err, key }, "Cache DEL error");
  }
}

//
// Health check
//

export async function cacheHealth(): Promise<{
  ok: boolean;
  latencyMs: number;
  message: string;
}> {
  const start = Date.now();
  const r = getClient();
  if (!r) {
    return { ok: false, latencyMs: Date.now() - start, message: "Not configured" };
  }

  try {
    await r.ping();
    return { ok: true, latencyMs: Date.now() - start, message: "Connected" };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      message: (err as Error).message,
    };
  }
}

//
// Scraped-article cache keys
//

function articlesKey(source?: string): string {
  const base = "scrape:articles";
  return source ? `${base}:${sourceSlug(source)}` : `${base}:all`;
}

function sourceSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Cache-fetch scraped articles for one source (or aggregated). */
export async function getCachedArticles(
  source?: string,
): Promise<unknown | null> {
  return cacheGet<unknown>(articlesKey(source));
}

/** Store scraped articles in cache. */
export async function setCachedArticles(
  data: unknown,
  source?: string,
  ttl = TTL.SOURCE_SCRAPE,
): Promise<void> {
  return cacheSet(articlesKey(source), data, ttl);
}

/** Cache-fetch aggregated articles from ALL sources. */
export async function getCachedAllArticles(): Promise<unknown | null> {
  return cacheGet<unknown>(articlesKey());
}

/** Store aggregated all‑source articles. */
export async function setCachedAllArticles(
  data: unknown,
  ttl = TTL.ALL_ARTICLES,
): Promise<void> {
  return cacheSet(articlesKey(), data, ttl);
}

/** Invalidate scraped-article caches (e.g. after a manual refresh). */
export async function invalidateArticleCaches(): Promise<void> {
  // We can't list keys in Upstash Redis REST, so we delete the known keys.
  await cacheDel(articlesKey());
  // We can't enumerate per-source keys easily, so rely on TTL expiry.
}

//
// Comparison-result cache keys
//

function comparisonKey(topicHash: string): string {
  return `compare:result:${topicHash}`;
}

/** Simple hash for topic normalisation (not crypto-secure, just for keys). */
export function hashTopic(topic: string): string {
  const normalized = topic.toLowerCase().replace(/\s+/g, " ").trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit int
  }
  return Math.abs(hash).toString(36);
}

/** Cache-fetch a comparison result. */
export async function getCachedComparison(
  topic: string,
): Promise<{ data: unknown; stale: boolean } | null> {
  const key = comparisonKey(hashTopic(topic));
  const raw = await cacheGet<{ data: unknown; cachedAt: string }>(key);
  if (!raw) return null;

  const age = Date.now() - new Date(raw.cachedAt).getTime();
  const stale = age > 43_200_000; // stale after 12 h (half the 24 h TTL)

  return { data: raw.data, stale };
}

/** Store a comparison result in cache. */
export async function setCachedComparison(
  topic: string,
  data: unknown,
  ttl = TTL.COMPARISON,
): Promise<void> {
  const key = comparisonKey(hashTopic(topic));
  return cacheSet(key, { data, cachedAt: new Date().toISOString() }, ttl);
}

//
// Rate-limit helpers
//

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const r = getClient();
  if (!r) {
    // No Redis - allow (but log a warning every 100 calls)
    return { allowed: true, remaining: 1, resetIn: 0 };
  }

  try {
    const multi = r.multi();
    multi.incr(key);
    multi.ttl(key);
    const [countRaw, ttlRaw] = (await multi.exec()) as [number, number];

    const count = countRaw ?? 0;

    // First increment - set expiry
    if (count === 1) {
      await r.expire(key, windowSeconds);
      return { allowed: true, remaining: maxRequests - 1, resetIn: windowSeconds };
    }

    const ttl = ttlRaw > 0 ? ttlRaw : windowSeconds;
    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      resetIn: ttl,
    };
  } catch (err) {
    log.warn({ err, key }, "Rate-limit error");
    return { allowed: true, remaining: 1, resetIn: 0 };
  }
}
