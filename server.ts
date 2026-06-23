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
import { checkInput } from "./server/services/inputGuardrail.js";
import { getOrGenerateBrief, generateBrief } from "./server/services/briefComposer.js";

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
      expander: "meta/llama-3.1-8b-instruct",
      matcher: "meta/llama-3.1-8b-instruct",
      analyst: "meta/llama-3.1-8b-instruct (parallel)",
      synthesizer: "meta/llama-3.1-8b-instruct (-> 70b fallback on low confidence)",
      verifier: "meta/llama-3.1-8b-instruct",
    }, "NVIDIA orchestrator initialised");
}

// Input guardrail classifier (layer 3: NIM topic check)
const inputClassifier: ((prompt: string) => Promise<string>) | undefined = nvidiaApiKey
  ? async (prompt: string) => {
      const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${nvidiaApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mistralai/mistral-7b-instruct-v0.3",
          messages: [
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 10,
        }),
      });
      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? "no";
    }
  : undefined;

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

// General health check -------------------------------------------------
app.get("/api/health", async (_req, res) => {
  const redis = await cacheHealth();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    redis,
    nim: { configured: Boolean(nvidiaApiKey) },
    timestamp: new Date().toISOString(),
  });
});

// Cache health check --------------------------------------------------
app.get("/api/cache/health", async (_req, res) => {
  const health = await cacheHealth();
  res.json(health);
});

// Latest scraped articles (cached) -----------------------------------
app.get("/api/news/latest", rateLimiter({ max: 30, windowSec: 60, prefix: "rate:news" }), async (req, res) => {
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

    // Fetch cached articles to check if the topic matches a known headline
    let knownHeadlines: string[] = [];
    try {
      const allArticles = await fetchAllNewsCached();
      knownHeadlines = allArticles.map((a: { title: string }) => a.title);
    } catch {
      // Non-blocking - headlines from the feed just won't auto-pass Layer 3
    }

    // Input guardrail (3 layers: structural -> regex -> NIM classifier)
    const guardrailResult = await checkInput(topic, inputClassifier, knownHeadlines);
    if (!guardrailResult.allowed) {
      const sessionId = crypto.randomUUID();
      setSession(sessionId, { topic, status: "rejected", createdAt: Date.now() });
      res.status(202).json({
        sessionId,
        status: "rejected",
        message: guardrailResult.reason,
      });
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

// Daily brief -----------------------------------------------
app.get("/api/brief/latest", rateLimiter({ max: 10, windowSec: 60, prefix: "rate:brief" }), async (_req, res) => {
  try {
    const brief = await getOrGenerateBrief(inputClassifier);
    if (!brief) {
      res.status(404).json({ error: "No brief available yet." });
      return;
    }
    res.json(brief);
  } catch (error: any) {
    log.error({ err: error }, "Failed to get brief");
    res.status(500).json({ error: "Failed to generate brief." });
  }
});

// Admin: force brief refresh (gated by ADMIN_KEY)
app.post("/api/admin/brief/refresh", rateLimiter({ max: 3, windowSec: 60, prefix: "rate:admin-brief" }), async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.headers.authorization !== `Bearer ${adminKey}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const sessionId = crypto.randomUUID();
    setSession(sessionId, { topic: "brief-refresh", status: "queued", createdAt: Date.now() });

    // Fire-and-forget brief generation
    generateBrief(inputClassifier)
      .then((brief) => {
        setSessionStatus(sessionId, "completed");
        log.info({ stories: brief.topStories.length }, "Admin brief refresh complete");
      })
      .catch((err) => {
        setSessionStatus(sessionId, "failed");
        log.error({ err }, "Admin brief refresh failed");
      });

    res.status(202).json({
      sessionId,
      status: "queued",
      message: "Brief refresh started.",
    });
  } catch (error: any) {
    log.error({ err: error }, "Failed to trigger brief refresh");
    res.status(500).json({ error: "Failed to trigger brief refresh." });
  }
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
