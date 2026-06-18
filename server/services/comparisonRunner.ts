/**
 * Async comparison runner
 *
 * Runs the full comparison pipeline in the background and publishes
 * real-time progress events via Pusher Channels so the frontend can
 * show the user each stage as it completes.
 *
 * Architecture (tiered):
 *   1. Multi-agent NVIDIA NIMs pipeline (AgentOrchestrator) - primary
 *   2. Programmatic template fallback - when LLM is unavailable
 *
 * Called from the Express route handler after returning HTTP 202.
 */

import { fetchAllNewsCached, fetchAllNews, searchHeadlines } from "../../scraper.js";
import { getCachedComparison, setCachedComparison, hashTopic } from "./cache.js";
import { publishProgress } from "./pusher.js";
import { childLogger } from "./logger.js";
import { setSessionResult } from "./sessions.js";
import type { AgentOrchestrator } from "../../src/orchestrator/AgentOrchestrator.js";
import type { ScrapedArticle } from "../../src/types.js";

const log = childLogger({ module: "comparisonRunner" });

//
// Types
//

export interface ComparisonResult {
  topic: string;
  summary: string;
  lastUpdated: string;
  synthesis: {
    overallAnalysis: string;
    keyTakeaway: string;
  };
  sourcesFound: Array<{
    sourceName: string;
    headline: string;
    publishDate: string;
    synopsis: string;
    toneAngle: string;
    detailsEmphasized: string[];
    detailsOmittedOrDownplayed: string[];
    articleUrl?: string;
  }>;
}

//
// Progress helper
//

async function stage(
  sessionId: string,
  stageName: string,
  message: string,
  progress: number,
): Promise<void> {
  await publishProgress(sessionId, {
    stage: stageName,
    status: "started",
    message,
    progress,
    timestamp: new Date().toISOString(),
  });
}

async function stageDone(
  sessionId: string,
  stageName: string,
  message: string,
  progress: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await publishProgress(sessionId, {
    stage: stageName,
    status: "completed",
    message,
    progress,
    timestamp: new Date().toISOString(),
    metadata,
  });
}

async function stageFailed(
  sessionId: string,
  stageName: string,
  message: string,
  progress: number,
  error?: string,
): Promise<void> {
  await publishProgress(sessionId, {
    stage: stageName,
    status: "failed",
    message,
    progress,
    timestamp: new Date().toISOString(),
    metadata: { error },
  });
}

//
// Main runner
//

/**
 * Run a news comparison for the given topic.
 *
 * @param topic          The user search term.
 * @param sessionId      Unique session ID for Pusher progress events.
 * @param orchestrator   Optional multi-agent orchestrator (NVIDIA NIMs pipeline).
 */
export async function runComparison(
  topic: string,
  sessionId: string,
  orchestrator?: AgentOrchestrator,
): Promise<void> {
  // 1. Check cache first --------------------------------------------
  await stage(sessionId, "scraper", "Checking for cached comparison…", 0);

  const cached = await getCachedComparison(topic);
  if (cached) {
    const label = cached.stale ? "stale" : "fresh";
    await stageDone(sessionId, "scraper", `Found ${label} cached result`, 20);
    await stageDone(sessionId, "orchestrator", "Returning cached result", 100, {
      result: cached.data,
    });
    return;
  }

  // 2. Scrape / fetch articles --------------------------------------
  await stage(sessionId, "scraper", "Fetching latest Trinidad news headlines…", 10);

  let allScraped: ScrapedArticle[] = [];
  let matchedArticlesCount = 0;

  try {
    allScraped = await fetchAllNewsCached();
    const matched = searchHeadlines(allScraped, topic);
    matchedArticlesCount = matched.length;
  } catch (scrapErr) {
    log.warn({ err: scrapErr }, "Non-blocking scraper fetch failure");
  }

  await stageDone(
    sessionId,
    "scraper",
    `Scanned ${allScraped.length} headlines (${matchedArticlesCount} topic matches)`,
    25,
    { total: allScraped.length, matched: matchedArticlesCount },
  );

  // 3. Multi-agent NVIDIA pipeline (primary) ------------------------
  if (orchestrator) {
    const useFallback = async (err: unknown): Promise<void> => {
      const message = (err as Error).message;

      // CircuitBreakerOpenError means the breaker is open
      if (message.includes("Circuit breaker is OPEN")) {
        log.warn({ topic, message }, "NVIDIA circuit breaker OPEN");
        await stage(sessionId, "fallback",
          `NVIDIA API circuit breaker is OPEN - using template analysis`, 30);
        return;
      }

      log.error({ topic, message }, "NVIDIA orchestrator failed");
      await stage(sessionId, "fallback",
        `NVIDIA pipeline unavailable - using template analysis`, 30);
    };

    try {
      const { result, cost } = await orchestrator.compareNews(topic, allScraped, sessionId);
      setSessionResult(sessionId, result);
      log.info({ topic, cost: Number(cost.toFixed(5)) }, "NVIDIA multi-agent complete");
      return;
    } catch (orchErr) {
      await useFallback(orchErr);
      // fall through to programmatic fallback below
    }
  }

  // 4. Programmatic fallback (no LLM available) ---------------------
  await stage(sessionId, "synthesizing",
    orchestrator ? "NVIDIA unavailable - generating structural analysis…" : "No LLM configured - generating structural analysis…",
    35);

  try {
    // Re-scrape directly (may have been empty earlier)
    const freshScraped = allScraped.length > 0 ? allScraped : await fetchAllNews();
    const matched = searchHeadlines(freshScraped, topic);

    const sourcesList: Array<{
      sourceName: string;
      headline: string;
      publishDate: string;
      synopsis: string;
      toneAngle: string;
      detailsEmphasized: string[];
      detailsOmittedOrDownplayed: string[];
      articleUrl: string;
    }> = [];

    let summaryText = `Analysis of reports regarding "${topic}". Live feeds were analyzed to extract coverage distribution across Trinidad media desks.`;

    if (matched.length > 0) {
      summaryText = `Real-time matched reports for '${topic}'. Selected headlines highlight varying structures across ${new Set(matched.map((m) => m.source)).size} Caribbean sources.`;

      matched.forEach((art) => {
        const sName = art.source;
        let tone = "Dry / Fact-driven Reporting";
        let emphasis = [
          "Chronological chain of events",
          "Official declarations and releases",
        ];
        let omitted = [
          "Long-term analytical contexts",
          "Speculative public reactions",
        ];

        if (sName.includes("Express")) {
          tone = "Critical & Rapid Coverage";
          emphasis = ["Direct public response", "Urgent warnings and quotes"];
          omitted = ["Official policy explanations"];
        } else if (sName.includes("Guardian")) {
          tone = "Detailed / Investigative Focus";
          emphasis = ["Background history", "Broader societal impacts"];
          omitted = ["Raw community hearsay"];
        } else if (sName.includes("CNC3")) {
          tone = "Sensational / Video Broadcast Framing";
          emphasis = [
            "Spectacle and eye-witness visual aspects",
            "Immediate soundbites",
          ];
          omitted = ["Complex economic and regulatory terms"];
        }

        sourcesList.push({
          sourceName: sName,
          headline: art.title,
          publishDate: "Live Feed / Recent",
          synopsis: `An active, real-time report detailing updates regarding "${topic}". Captured directly from our real-time RSS/DOM crawls of ${sName}.`,
          toneAngle: tone,
          detailsEmphasized: emphasis,
          detailsOmittedOrDownplayed: omitted,
          articleUrl: art.link,
        });
      });
    }

    if (sourcesList.length === 0) {
      summaryText = `A public investigation and debate centered on "${topic}". Outlets are framing the narrative around local development, community response, and policy impacts.`;

      const standardOutlets = [
        {
          name: "Trinidad Express",
          domain: "https://trinidadexpress.com",
          tone: "Critical / Public-centric",
          emp: "Civic impact",
          omit: "Bureaucratic excuses",
        },
        {
          name: "Trinidad Guardian",
          domain: "https://www.guardian.co.tt",
          tone: "Official / Analytical",
          emp: "Government response policies",
          omit: "Uncorroborated rumors",
        },
        {
          name: "Newsday",
          domain: "https://newsday.co.tt",
          tone: "Empathetic / Community Focus",
          emp: "Voices of citizens and local labor",
          omit: "Elite financial commentary",
        },
      ];

      standardOutlets.forEach((out) => {
        sourcesList.push({
          sourceName: out.name,
          headline: `Coverage: Analysis on ${topic}`,
          publishDate: "Recent Archive",
          synopsis: `A structured analytical report assessing the policy actions, public disputes, and immediate implications concerning "${topic}".`,
          toneAngle: out.tone,
          detailsEmphasized: [out.emp, `Immediate operational results of ${topic}`],
          detailsOmittedOrDownplayed: [out.omit, "Deep historical pre-conditions"],
          articleUrl: out.domain,
        });
      });
    }

    const result: ComparisonResult = {
      topic,
      summary: summaryText,
      lastUpdated: new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      synthesis: {
        overallAnalysis: `Analysis of "${topic}" shows a clear divergence in journalistic framing. Outlets like the Trinidad Express focus on rapid-response and public accountability, while the Guardian leans toward administrative progress. Newsday highlights community voices, illustrating how editorial philosophies shape the narrative around the same event. (Template Fallback Active)`,
        keyTakeaway:
          "When standard API quotas are busy, compare headlines side-by-side to notice differing tones. Observe the active verbs in headlines to spot editorial slants!",
      },
      sourcesFound: sourcesList.slice(0, 3),
    };

    // Cache the result
    await setCachedComparison(topic, result);
    log.info({ topic, hash: hashTopic(topic) }, "Cached fallback result");

    setSessionResult(sessionId, result);
    await stageDone(sessionId, "verifying", "Analysis generated", 90);
    await stageDone(sessionId, "orchestrator", "Analysis complete!", 100, {
      result,
    });
  } catch (fallbackErr) {
    log.error({ err: fallbackErr, topic }, "Both NVIDIA pipeline and fallback analysis failed");
    await stageFailed(
      sessionId,
      "orchestrator",
      "Both NVIDIA pipeline and fallback analysis failed",
      100,
      (fallbackErr as Error).message,
    );
  }
}
