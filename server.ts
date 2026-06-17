import express from "express";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { fetchAllNewsCached, refreshAllNews } from "./scraper.js";
import { cacheHealth } from "./server/services/cache.js";
import { rateLimiter } from "./server/middleware/rateLimiter.js";
import { runComparison } from "./server/services/comparisonRunner.js";
import { AgentOrchestrator } from "./src/orchestrator/AgentOrchestrator.js";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

// Initialize NVIDIA NIMs multi-agent orchestrator
const nvidiaApiKey = process.env.NVIDIA_NIM_API_KEY || "";
if (!nvidiaApiKey) {
  console.warn("[Server] NVIDIA_NIM_API_KEY not set - multi-agent pipeline disabled");
}

const orchestrator: AgentOrchestrator | undefined = nvidiaApiKey
  ? new AgentOrchestrator({ nvidiaApiKey })
  : undefined;

// Log circuit breaker + model config on startup
if (orchestrator) {
  console.log("[Server] NVIDIA orchestrator initialised with models:");
  console.log("  expander:  meta/llama-3.1-70b-instruct");
  console.log("  matcher:   meta/llama-3.1-70b-instruct");
  console.log("  analyst:   meta/llama-3.1-8b-instruct (parallel)");
  console.log("  synthesizer: meta/llama-3.1-70b-instruct (to nvidia/nemotron-4-340b-instruct fallback)");
  console.log("  verifier:  meta/llama-3.1-70b-instruct");
}

// Regular Express middleware
app.use(express.json());

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
    console.error("Error fetching latest scraped news:", error);
    res.status(500).json({ error: "Failed to fetch live scraped headlines", details: error.message });
  }
});

//
// In-memory session store (maps sessionId to { topic, status })
// Used as a fallback when Pusher is not available.
//

const sessions = new Map<string, { topic: string; status: string; createdAt: number }>();

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
    sessions.set(sessionId, { topic, status: "queued", createdAt: Date.now() });

    // Fire-and-forget the comparison in the background.
    // The frontend receives the sessionId and subscribes to Pusher.
    // Pass the NVIDIA orchestrator if available (falls back to Gemini otherwise).
    runComparison(topic, sessionId, orchestrator)
      .then(() => {
        const s = sessions.get(sessionId);
        if (s) s.status = "completed";
      })
      .catch((err) => {
        const s = sessions.get(sessionId);
        if (s) s.status = "failed";
        console.error(`[Compare] Background runner failed for "${topic}":`, err);
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
  const session = sessions.get(sessionId);

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Return the status so the frontend can poll
  res.json({
    sessionId,
    topic: session.topic,
    status: session.status,
    elapsed: Date.now() - session.createdAt,
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
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
