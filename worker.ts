/**
 * Background Worker
 *
 * Runs alongside the web service on Render.  Responsibilities:
 *
 *   1. **Periodic scrape** – crawls all Trinidad news sources every N minutes
 *      and seeds the Upstash Redis cache so the web service always finds a
 *      warm cache.
 *   2. **Cache warming** – optionally pre-generates comparisons for trending
 *      topics so they are ready before users ask.
 *
 * Start command:  `node dist/worker.cjs`
 * Dev command:    `tsx worker.ts`
 */

import dotenv from "dotenv";
dotenv.config();

import { fetchAllNews, fetchAllNewsCached, ScrapedArticle } from "./scraper.js";
import {
  setCachedArticles,
  setCachedAllArticles,
  TTL,
} from "./server/services/cache.js";

//
// Config
//

const SCRAPE_INTERVAL_MS =
  (parseInt(process.env.WORKER_SCRAPE_INTERVAL_MINUTES || "5", 10)) * 60_000;

//
// Helpers
//

function log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: "background-worker",
    message,
    ...meta,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

//
// Core scrape to cache cycle
//

async function scrapeAndCache(): Promise<void> {
  const startedAt = Date.now();
  log("info", "Scrape cycle starting");

  try {
    // 1. Run the full scraper
    const articles: ScrapedArticle[] = await fetchAllNews();
    const elapsed = Date.now() - startedAt;

    // 2. Cache the aggregated list (short TTL so it stays reasonably fresh)
    await setCachedAllArticles(articles, TTL.ALL_ARTICLES);

    // 3. Cache per source
    const bySource = new Map<string, ScrapedArticle[]>();
    for (const article of articles) {
      const arr = bySource.get(article.source) || [];
      arr.push(article);
      bySource.set(article.source, arr);
    }

    for (const [source, srcArticles] of bySource) {
      await setCachedArticles(srcArticles, source, TTL.SOURCE_SCRAPE);
    }

    // 4. Stats
    const sourceCount = bySource.size;
    log("info", "Scrape cycle complete", {
      articles: articles.length,
      sources: sourceCount,
      elapsedMs: elapsed,
      nextIntervalMs: SCRAPE_INTERVAL_MS,
      sourcesDetail: Object.fromEntries(
        [...bySource.entries()].map(([k, v]) => [k, v.length]),
      ),
    });
  } catch (err) {
    log("error", "Scrape cycle failed", {
      error: (err as Error).message,
      elapsedMs: Date.now() - startedAt,
    });
  }
}

//
// Health-report endpoint (for Render health checks)
//

function printHealth(): void {
  log("info", "Worker health report", {
    uptimeSeconds: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    nextScrapeInMs: SCRAPE_INTERVAL_MS,
    nodeVersion: process.version,
    platform: process.platform,
  });
}

//
// Graceful shutdown
//

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `Received ${signal} - shutting down gracefully`);
  // Allow current scrape to finish (up to 30 s)
  setTimeout(() => {
    log("info", "Shutdown complete");
    process.exit(0);
  }, 30_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

//
// Main loop
//

async function main(): Promise<void> {
  log("info", "Worker starting", {
    scrapeIntervalMs: SCRAPE_INTERVAL_MS,
    redisConfigured: Boolean(process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN),
  });

  // Run once immediately on startup so the cache is seeded ASAP
  await scrapeAndCache();

  // Print health every 10 cycles
  let cycleCount = 0;

  // Then repeat on the interval
  setInterval(async () => {
    await scrapeAndCache();
    cycleCount++;

    if (cycleCount % 10 === 0) {
      printHealth();
    }
  }, SCRAPE_INTERVAL_MS);

  // Print health every hour regardless
  setInterval(printHealth, 3_600_000).unref();
}

main().catch((err) => {
  log("error", "Fatal worker error", { error: (err as Error).message });
  process.exit(1);
});
