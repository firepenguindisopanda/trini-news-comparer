import express from "express";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import pinoHttp from "pino-http";
import { createServer as createViteServer } from "vite";
import { fetchAllNewsCached, refreshAllNews } from "./scraper.js";
import { cacheHealth } from "./server/services/cache.js";
import { rateLimiter } from "./server/middleware/rateLimiter.js";
import { runComparison } from "./server/services/comparisonRunner.js";
import { AgentOrchestrator } from "./src/orchestrator/AgentOrchestrator.js";
import logger, { childLogger } from "./server/services/logger.js";
import { getSession, setSession, setSessionStatus } from "./server/services/sessions.js";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

const log = childLogger({ module: "server" });

// Initialize NVIDIA NIMs multi-agent orchestrator
const nvidiaApiKey = process.env.NVIDIA_NIM_API_KEY || "";
if (!nvidiaApiKey) {
  log.warn("NVIDIA_NIM_API_KEY not set - multi-agent pipeline disabled");
}

const orchestrator: AgentOrchestrator | undefined = nvidiaApiKey
  ? new AgentOrchestrator({ nvidiaApiKey })
  : undefined;

// Log circuit breaker + model config on startup
if (orchestrator) {
    log.info({
      expander: "meta/llama-3.1-70b-instruct",
      matcher: "meta/llama-3.1-70b-instruct",
      analyst: "meta/llama-3.1-8b-instruct (parallel)",
      synthesizer: "meta/llama-3.1-70b-instruct (to nvidia/nemotron-4-340b-instruct fallback)",
      verifier: "meta/llama-3.1-70b-instruct",
    }, "NVIDIA orchestrator initialised");
}

// Regular Express middleware
app.use(express.json());

// Request logging via pino-http
app.use(
  pinoHttp({
    logger: logger as any,
    autoLogging: {
      ignore: (req) => req.url === "/api/cache/health",
    },
  }),
);

// Cache health check --------------------------------------------------
app.get("/api/cache/health", async (_req, res) => {
  const health = await cacheHealth();
  res.json(health);
});

// Latest scraped articles (cached) -----------------------------------
app.get("/api/news/latest", async (req, res) => {
  const force = req.query.force === "true";

  try {
    const allArticles = force ? await refreshAllNews() : await fetchAllNewsCached();

    // Tell the client whether this is cached data
    res.setHeader("X-Cache", force ? "MISS" : "HIT");

    res.json({
      count: allArticles.length,
      articles: allArticles.slice(0, 50),
      cached: !force,
    });
  } catch (error: any) {
    log.error({ err: error }, "Error fetching latest scraped news");
    res.status(500).json({ error: "Failed to fetch live scraped headlines", details: error.message });
  }
});

//
// Compare coverage (cached + async with Pusher progress) ---------------
app.post(
  "/api/news/compare",
  rateLimiter({ max: 10, windowSec: 60, prefix: "rate:compare" }),
  async (req, res) => {
    const { topic } = req.body;

    if (!topic || typeof topic !== "string") {
      res.status(400).json({ error: "A valid 'topic' string is required." });
      return;
    }

    // Generate a unique session ID for Pusher progress events
    const sessionId = crypto.randomUUID();

    // Track the session in memory (for polling fallback)
    setSession(sessionId, { topic, status: "queued", createdAt: Date.now() });

    // Fire-and-forget the comparison in the background.
    // The frontend receives the sessionId and subscribes to Pusher.
    runComparison(topic, sessionId, orchestrator)
      .then(() => {
        setSessionStatus(sessionId, "completed");
      })
      .catch((err) => {
        setSessionStatus(sessionId, "failed");
        log.error({ err, topic }, "Background comparison runner failed");
      });

    // Return 202 Accepted immediately with the sessionId
    res.status(202).json({
      sessionId,
      status: "queued",
      message: "Comparison started. Subscribe to Pusher channel for progress.",
    });
  },
);

// Polling fallback (when Pusher is not available) ----------------------
app.get("/api/news/compare/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Return status + result (if completed)
  res.json({
    sessionId,
    topic: session.topic,
    status: session.status,
    elapsed: Date.now() - session.createdAt,
    result: session.result || null,
  });
});

// Configure Vite middleware for development or Static Asset serving for production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");

    // Static assets (JS/CSS bundles are hashed - safe to cache forever)
    app.use(
      express.static(distPath, {
        maxAge: "1y",
        immutable: true,
        setHeaders(res, filePath) {
          // HTML must never be cached (it contains the SPA shell)
          if (filePath.endsWith(".html")) {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          }
        },
      }),
    );

    // SPA fallback - serve index.html for all non-asset routes
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"), {
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    log.info({ port: PORT }, "Server started");
  });
}

startServer();
