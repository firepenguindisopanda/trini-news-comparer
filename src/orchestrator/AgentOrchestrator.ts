/**
 * AgentOrchestrator
 *
 * Runs the 5-agent NVIDIA NIMs comparison pipeline:
 *   1. TopicExpander  (70B)  - enriches user topic
 *   2. ArticleMatcher (70B)  - scores scraped articles for relevance
 *   3. SourceAnalyst  (8B)   - per-source tone/emphasis/omissions (parallel)
 *   4. CrossSynthesizer (70Bto340B) - cross-source comparison
 *   5. Verifier       (70B)  - fact-check & neutrality check
 *
 * Each agent publishes progress via Pusher, caches intermediate results
 * in Redis, and falls back gracefully on failure.
 */

import { NvidiaNimsClient } from "./NvidiaNimsClient.js";
import {
  TOPIC_EXPANDER_PROMPT,
  ARTICLE_MATCHER_PROMPT,
  SOURCE_ANALYST_PROMPT,
  CROSS_SOURCE_SYNTHESIZER_PROMPT,
  VERIFIER_PROMPT,
  TOPIC_EXPANDER_SCHEMA,
  ARTICLE_MATCHER_SCHEMA,
  SOURCE_ANALYST_SCHEMA,
  CROSS_SOURCE_SYNTHESIZER_SCHEMA,
  VERIFIER_SCHEMA,
} from "./prompts.js";
import type { ScrapedArticle, NewsSourceReport, NewsComparisonResult } from "../types.js";
import { publishProgress, type ProgressPayload } from "../../server/services/pusher.js";
import {
  setCachedComparison,
} from "../../server/services/cache.js";
import { childLogger } from "../../server/services/logger.js";
import { applyOutputGuardrail } from "../../server/services/outputGuardrail.js";
import { getCheckpoint, setCheckpoint } from "../../server/services/cache.js";

const log = childLogger({ module: "orchestrator" });

//
// Pipeline planning (effort scaling)
//

type PipelineMode = "no_coverage" | "single_source" | "cross_source";

interface PipelinePlan {
  mode: PipelineMode;
  skipAnalysts: boolean;
  skipSynthesis: boolean;
}

function planPipeline(matched: MatchedArticle[]): PipelinePlan {
  const matchCount = matched.length;
  if (matchCount === 0) {
    return { mode: "no_coverage", skipAnalysts: true, skipSynthesis: true };
  }

  const sourceCount = new Set(matched.map((a) => a.source)).size;
  if (sourceCount <= 1) {
    return { mode: "single_source", skipAnalysts: false, skipSynthesis: true };
  }

  return { mode: "cross_source", skipAnalysts: false, skipSynthesis: false };
}

/** Quick non-crypto hash for article-set invalidation. */
function simpleHash(items: string[]): string {
  let h = 0;
  for (const s of items) {
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
  }
  return Math.abs(h).toString(36);
}

//
// Types
//

interface TopicExpanderOutput {
  expandedTopic: string; searchTerms: string[]; entities: string[]; originalTopic: string;
}

interface MatchedArticle extends ScrapedArticle {
  relevanceScore: number; relevanceReason: string;
}

interface ArticleMatcherOutput {
  matchedArticles: MatchedArticle[]; summary: string;
  totalArticlesScored: number; topSourceDistribution: Record<string, number>;
}

interface SourceAnalystInput {
  sourceName: string; matchedArticles: MatchedArticle[];
  allArticles: ScrapedArticle[]; topic: string;
}
interface SourceAnalystOutput extends NewsSourceReport {
  confidenceScore: number; articlesAnalyzed: number;
}

interface GroundTruthItem {
  sourceName: string;
  articleTitles: { title: string; link: string }[];
}
interface CrossSourceSynthesizerInput {
  topic: string; summary: string; sourceReports: NewsSourceReport[];
  groundTruth: GroundTruthItem[];
}
interface CrossSourceSynthesizerOutput {
  synthesis: { overallAnalysis: string; keyTakeaway: string; claims?: Array<{ claim: string; sourceName: string; articleUrl?: string }> };
  detectedBiasPatterns: string[];
  sourceAgreementLevel: "high" | "medium" | "low";
  confidenceScore: number;
}

interface VerifierInput {
  originalArticles: ScrapedArticle[];
  sourceReports: NewsSourceReport[];
  synthesis: { overallAnalysis: string; keyTakeaway: string };
  detectedBiasPatterns: string[]; topic: string;
}
interface VerifierOutput {
  verified: boolean; issues: string[];
  corrections: Record<string, string> | null;
  confidenceScore: number; verificationNotes: string;
}

//
// Config
//

export interface OrchestratorConfig {
  nvidiaApiKey: string;
  expanderModel?: string;              // default: meta/llama-3.1-70b-instruct
  matcherModel?: string;               // default: meta/llama-3.1-70b-instruct
  analystModel?: string;               // default: meta/llama-3.1-8b-instruct
  synthesizerModel?: string;           // default: meta/llama-3.1-70b-instruct
  fallbackSynthesizerModel?: string;   // default: nvidia/nemotron-4-340b-instruct
  verifierModel?: string;              // default: meta/llama-3.1-70b-instruct
}

//
// Orchestrator
//

export class AgentOrchestrator {
  private nvidia: NvidiaNimsClient;
  private cfg: Required<OrchestratorConfig>;

  constructor(config: OrchestratorConfig) {
    this.nvidia = new NvidiaNimsClient(config.nvidiaApiKey);
    this.cfg = {
      nvidiaApiKey: config.nvidiaApiKey,
      expanderModel: config.expanderModel ?? "meta/llama-3.1-8b-instruct",
      matcherModel: config.matcherModel ?? "meta/llama-3.1-8b-instruct",
      analystModel: config.analystModel ?? "meta/llama-3.1-8b-instruct",
      synthesizerModel: config.synthesizerModel ?? "meta/llama-3.1-8b-instruct",
      fallbackSynthesizerModel: config.fallbackSynthesizerModel ?? "meta/llama-3.1-70b-instruct",
      verifierModel: config.verifierModel ?? "meta/llama-3.1-8b-instruct",
    };
  }

  /** Expose the NIMs client for circuit-breaker inspection. */
  getCircuitState(): string { return this.nvidia.getCircuitState(); }
  getCircuitSummary(): Record<string, unknown> { return this.nvidia.getCircuitSummary(); }
  resetCircuit(): void { this.nvidia.resetCircuit(); }

  //
  // Progress helper
  //

  private async pub(
    sessionId: string,
    stage: string,
    status: ProgressPayload["status"],
    message: string,
    progress: number,
    metadata?: Record<string, unknown>,
  ) {
    await publishProgress(sessionId, {
      stage, status, message, progress,
      timestamp: new Date().toISOString(),
      metadata,
    });
  }

  //
  // Agent 1 - TopicExpander
  //

  private async expandTopic(
    topic: string,
    sessionId: string,
  ): Promise<TopicExpanderOutput> {
    await this.pub(sessionId, "topicExpander", "started", "Expanding topic with Trinidad context…", 10);

    try {
      const { data } = await this.nvidia.chat<TopicExpanderOutput>({
        model: this.cfg.expanderModel,
        systemPrompt: TOPIC_EXPANDER_PROMPT,
        userContent: JSON.stringify({ topic }),
        requestId: `topic-expand-${sessionId.slice(0, 8)}`,
        responseSchema: TOPIC_EXPANDER_SCHEMA,
      });

      const output: TopicExpanderOutput = {
        expandedTopic: data.expandedTopic || topic,
        searchTerms: Array.isArray(data.searchTerms) && data.searchTerms.length > 0 ? data.searchTerms : [topic],
        entities: Array.isArray(data.entities) ? data.entities : [],
        originalTopic: topic,
      };

      await this.pub(sessionId, "topicExpander", "completed",
        `Expanded to ${output.searchTerms.length} search terms`, 20);
      return output;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "TopicExpander failed, using fallback");
      await this.pub(sessionId, "topicExpander", "failed", "Topic expansion failed, using original", 20);
      return { expandedTopic: topic, searchTerms: [topic], entities: [], originalTopic: topic };
    }
  }

  //
  // Agent 2 - ArticleMatcher
  //

  private async matchArticles(
    expanded: TopicExpanderOutput,
    articles: ScrapedArticle[],
    sessionId: string,
  ): Promise<ArticleMatcherOutput> {
    await this.pub(sessionId, "articleMatcher", "started",
      `Matching ${articles.length} articles to topic…`, 25);

    if (articles.length === 0) {
      await this.pub(sessionId, "articleMatcher", "completed", "No articles to match", 35);
      return { matchedArticles: [], summary: "No articles available.", totalArticlesScored: 0, topSourceDistribution: {} };
    }

    try {
      const { data } = await this.nvidia.chat<ArticleMatcherOutput>({
        model: this.cfg.matcherModel,
        systemPrompt: ARTICLE_MATCHER_PROMPT,
        userContent: JSON.stringify({ expandedTopic: expanded, articles: articles.slice(0, 30) }),
        requestId: `match-${sessionId.slice(0, 8)}`,
        responseSchema: ARTICLE_MATCHER_SCHEMA,
      });

      const matched = (data.matchedArticles ?? []).map((a: any) => ({
        title: a.title ?? "", link: a.link ?? "", pubDate: a.pubDate ?? "",
        source: a.source ?? "", relevanceScore: typeof a.relevanceScore === "number" ? a.relevanceScore : 0.5,
        relevanceReason: a.relevanceReason ?? "",
      }));

      // Fallback if LLM returned nothing
      if (matched.length === 0 && articles.length > 0) {
        return this.keywordFallback(expanded, articles, sessionId);
      }

      const output: ArticleMatcherOutput = {
        matchedArticles: matched,
        summary: data.summary || `${matched.length} articles matched`,
        totalArticlesScored: articles.length,
        topSourceDistribution: data.topSourceDistribution ?? {},
      };

      await this.pub(sessionId, "articleMatcher", "completed",
        `Matched ${matched.length} articles`, 40, { matchCount: matched.length });
      return output;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "ArticleMatcher failed, using keyword fallback");
      return this.keywordFallback(expanded, articles, sessionId);
    }
  }

  private keywordFallback(
    expanded: TopicExpanderOutput,
    articles: ScrapedArticle[],
    sessionId: string,
  ): ArticleMatcherOutput {
    const terms = [...expanded.searchTerms, expanded.originalTopic]
      .flatMap((t) => t.toLowerCase().split(/\s+/))
      .filter((t) => t.length > 2);
    const unique = [...new Set(terms)];

    const matched: MatchedArticle[] = articles
      .map((a) => {
        const lower = a.title.toLowerCase();
        const count = unique.filter((t) => lower.includes(t)).length;
        if (count === 0) return null;
        return {
          ...a,
          relevanceScore: Math.min(1, count / Math.max(3, unique.length) + 0.3),
          relevanceReason: `Matched ${count} keywords`,
        };
      })
      .filter((m): m is MatchedArticle => m !== null)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    this.pub(sessionId, "articleMatcher", "completed",
      `Keyword fallback: ${matched.length} matches`, 40, { matchCount: matched.length });
    return {
      matchedArticles: matched,
      summary: `Keyword matching found ${matched.length} articles.`,
      totalArticlesScored: articles.length,
      topSourceDistribution: this.sourceDist(matched),
    };
  }

  private sourceDist(matches: MatchedArticle[]): Record<string, number> {
    const d: Record<string, number> = {};
    for (const m of matches) d[m.source] = (d[m.source] ?? 0) + 1;
    return d;
  }

  //
  // Agent 3 - SourceAnalyst (parallel per source)
  //

  private async analyzeSource(
    input: SourceAnalystInput,
  ): Promise<SourceAnalystOutput | null> {
    if (input.matchedArticles.length === 0) return null;

    try {
      const { data } = await this.nvidia.chat<SourceAnalystOutput>({
        model: this.cfg.analystModel,
        systemPrompt: SOURCE_ANALYST_PROMPT,
        userContent: JSON.stringify(input),
        requestId: `analyst-${input.sourceName.replace(/\s+/g, "-")}-${Date.now()}`,
        responseSchema: SOURCE_ANALYST_SCHEMA,
      });

      return {
        sourceName: data.sourceName || input.sourceName,
        headline: data.headline || input.matchedArticles[0]?.title || "",
        publishDate: data.publishDate || input.matchedArticles[0]?.pubDate || "",
        synopsis: data.synopsis || "",
        toneAngle: data.toneAngle || "Neutral / Descriptive",
        detailsEmphasized: Array.isArray(data.detailsEmphasized) ? data.detailsEmphasized : [],
        detailsOmittedOrDownplayed: Array.isArray(data.detailsOmittedOrDownplayed) ? data.detailsOmittedOrDownplayed : [],
        articleUrl: data.articleUrl || input.matchedArticles[0]?.link || "",
        confidenceScore: typeof data.confidenceScore === "number" ? data.confidenceScore : 0.8,
        articlesAnalyzed: input.matchedArticles.length,
      };
    } catch (err) {
      log.warn({ err: (err as Error).message, sourceName: input.sourceName }, "SourceAnalyst failed");
      return {
        sourceName: input.sourceName,
        headline: input.matchedArticles[0]?.title || "",
        publishDate: input.matchedArticles[0]?.pubDate || "",
        synopsis: `Coverage from ${input.sourceName} on this topic.`,
        toneAngle: "Unavailable - analysis failed",
        detailsEmphasized: [],
        detailsOmittedOrDownplayed: [],
        articleUrl: input.matchedArticles[0]?.link || "",
        confidenceScore: 0.1,
        articlesAnalyzed: input.matchedArticles.length,
      };
    }
  }

  //
  // Ground-truth compression - extracts raw article titles per source
  // so the Synthesizer reasons against actual headlines, not just summaries.
  //

  private compressGroundTruth(
    matched: MatchedArticle[],
  ): GroundTruthItem[] {
    const bySource = new Map<string, { title: string; link: string }[]>();
    for (const a of matched) {
      const arr = bySource.get(a.source) ?? [];
      arr.push({ title: a.title, link: a.link });
      bySource.set(a.source, arr);
    }
    return [...bySource.entries()].map(([sourceName, articleTitles]) => ({
      sourceName,
      articleTitles: articleTitles.slice(0, 3), // top 3 per source
    }));
  }

  //
  // Agent 4 - CrossSourceSynthesizer
  //

  private async synthesize(
    input: CrossSourceSynthesizerInput,
    sessionId: string,
  ): Promise<CrossSourceSynthesizerOutput> {
    await this.pub(sessionId, "synthesizer", "started",
      `Synthesizing ${input.sourceReports.length} source analyses…`, 70);

    const tryModel = async (model: string): Promise<CrossSourceSynthesizerOutput> => {
      const { data } = await this.nvidia.chat<CrossSourceSynthesizerOutput>({
        model,
        systemPrompt: CROSS_SOURCE_SYNTHESIZER_PROMPT,
        userContent: JSON.stringify(input),
        requestId: `synthesize-${sessionId.slice(0, 8)}`,
        responseSchema: CROSS_SOURCE_SYNTHESIZER_SCHEMA,
      });
      const syn = data.synthesis || data as any;
      return {
        synthesis: {
          overallAnalysis: syn.overallAnalysis ||
            `Analysis of "${input.topic}" across ${input.sourceReports.length} source${input.sourceReports.length !== 1 ? 's' : ''}. ` +
            input.sourceReports.map(s => `${s.sourceName}: ${s.toneAngle}.`).join(" "),
          keyTakeaway: syn.keyTakeaway ||
            `Each outlet framed "${input.topic}" with different editorial priorities. Compare the emphasized vs omitted details above.`,
          claims: Array.isArray(syn.claims) ? syn.claims : [],
        },
        detectedBiasPatterns: Array.isArray(data.detectedBiasPatterns) ? data.detectedBiasPatterns : [],
        sourceAgreementLevel: ["high", "medium", "low"].includes(data.sourceAgreementLevel ?? "")
          ? data.sourceAgreementLevel as "high" | "medium" | "low"
          : "medium",
        confidenceScore: typeof data.confidenceScore === "number" ? data.confidenceScore : 0.5,
      };
    };

    try {
      const primary = await tryModel(this.cfg.synthesizerModel);

      // If confidence is low AND we have a bigger model, retry with it
      if (primary.confidenceScore < 0.5) {
        log.info("Low confidence synthesis, trying Nemotron-340B fallback");
        try {
          const fallback = await tryModel(this.cfg.fallbackSynthesizerModel);
          const merged = fallback.confidenceScore > primary.confidenceScore ? fallback : primary;
          merged.confidenceScore = (fallback.confidenceScore + primary.confidenceScore) / 2;
          await this.pub(sessionId, "synthesizer", "completed", "Synthesis complete", 85,
            { confidenceScore: merged.confidenceScore, agreementLevel: merged.sourceAgreementLevel });
          return merged;
        } catch { /* use primary */ }
      }

      await this.pub(sessionId, "synthesizer", "completed", "Synthesis complete", 85,
        { confidenceScore: primary.confidenceScore, agreementLevel: primary.sourceAgreementLevel });
      return primary;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Synthesizer failed");
      await this.pub(sessionId, "synthesizer", "failed", "Synthesis failed, using template", 85);
      return {
        synthesis: {
          overallAnalysis: `Analysis of "${input.topic}" across ${input.sourceReports.length} sources. ${input.sourceReports.map(s => `${s.sourceName}: ${s.toneAngle}.`).join(" ")}`,
          keyTakeaway: "Compare headlines side-by-side to notice differing editorial priorities.",
        },
        detectedBiasPatterns: ["Sources emphasized different aspects of the story"],
        sourceAgreementLevel: input.sourceReports.length >= 2 ? "medium" : "low",
        confidenceScore: 0.3,
      };
    }
  }

  //
  // Agent 5 - Verifier
  //

  private async verify(
    input: VerifierInput,
    sessionId: string,
  ): Promise<VerifierOutput> {
    await this.pub(sessionId, "verifier", "started", "Verifying synthesis against original articles…", 88);

    try {
      const { data } = await this.nvidia.chat<VerifierOutput>({
        model: this.cfg.verifierModel,
        systemPrompt: VERIFIER_PROMPT,
        userContent: JSON.stringify(input),
        requestId: `verify-${sessionId.slice(0, 8)}`,
        responseSchema: VERIFIER_SCHEMA,
      });

      const output: VerifierOutput = {
        verified: data.verified !== false,
        issues: Array.isArray(data.issues) ? data.issues : [],
        corrections: data.corrections || null,
        confidenceScore: typeof data.confidenceScore === "number" ? data.confidenceScore : 0.8,
        verificationNotes: data.verificationNotes ?? "",
      };

      await this.pub(sessionId, "verifier", "completed",
        `Verification ${output.verified ? "passed" : "flagged with ${output.issues.length} issues"}`, 95,
        { verified: output.verified, issueCount: output.issues.length });
      return output;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Verifier failed");
      await this.pub(sessionId, "verifier", "failed", "Verification unavailable", 95);
      return { verified: false, issues: ["Verification agent failed"], corrections: null, confidenceScore: 0.1, verificationNotes: "" };
    }
  }

  //
  // Public entry point - runs the full 5-agent pipeline
  //

  async compareNews(
    topic: string,
    scrapedArticles: ScrapedArticle[],
    sessionId: string,
  ): Promise<{ result: NewsComparisonResult; cost: number }> {
    await this.pub(sessionId, "orchestrator", "started", `Multi-agent analysis for "${topic}"`, 0,
      { sessionId });

    // Agent 1: Topic Expansion (checkpointable - independent of articles) ---
    const expanderCheck = await getCheckpoint<TopicExpanderOutput>(topic, "expander");
    let expanded: TopicExpanderOutput;
    if (expanderCheck) {
      expanded = expanderCheck.data;
      log.info({ topic }, "Loaded TopicExpander from checkpoint");
      await this.pub(sessionId, "topicExpander", "completed", "Loaded from cache", 20);
    } else {
      expanded = await this.expandTopic(topic, sessionId);
      await setCheckpoint(topic, "expander", expanded);
    }

    // Agent 2: Article Matching (checkpoint invalidated if articles changed) ---
    const matcherCheck = await getCheckpoint<ArticleMatcherOutput>(topic, "matcher");
    let matchedOutput: ArticleMatcherOutput;
    if (matcherCheck && matcherCheck.articleSetHash === simpleHash(scrapedArticles.map(a => a.link))) {
      matchedOutput = matcherCheck.data;
      log.info({ topic }, "Loaded ArticleMatcher from checkpoint");
      await this.pub(sessionId, "articleMatcher", "completed", "Loaded from cache", 40);
    } else {
      matchedOutput = await this.matchArticles(expanded, scrapedArticles, sessionId);
      await setCheckpoint(topic, "matcher", matchedOutput, scrapedArticles);
    }

    // Pipeline planning (effort scaling) ---
    const plan = planPipeline(matchedOutput.matchedArticles);
    await this.pub(sessionId, "planner", "completed",
      `Plan: ${plan.mode}`, 42, { plan });

    let validReports: NewsSourceReport[] = [];

    if (plan.mode === "no_coverage") {
      await this.pub(sessionId, "sourceAnalysts", "skipped",
        "No relevant articles found - skipping analysis", 60);
    } else {
      // Agent 3: Source Analysis (PARALLEL) ---
      const bySource = new Map<string, MatchedArticle[]>();
      for (const article of matchedOutput.matchedArticles) {
        const arr = bySource.get(article.source) ?? [];
        arr.push(article);
        bySource.set(article.source, arr);
      }

      await this.pub(sessionId, "sourceAnalysts", "started",
        `Analyzing ${bySource.size} sources in parallel…`, 45);

      const analystPromises = [...bySource.entries()].map(([sourceName, articles]) =>
        this.analyzeSource({ sourceName, matchedArticles: articles, allArticles: scrapedArticles, topic })
          .catch((err) => {
            log.warn({ sourceName, err: (err as Error).message }, "SourceAnalyst failed");
            return null;
          }),
      );
      const analystResults = await Promise.all(analystPromises);
      validReports = analystResults.filter(
        (r): r is SourceAnalystOutput => r !== null && r.confidenceScore > 0.2,
      );

      await this.pub(sessionId, "sourceAnalysts", "completed",
        `Analyzed ${validReports.length} sources`, 60,
        { sourceCount: validReports.length, sources: validReports.map((r) => r.sourceName) });
    }

    // Agent 4: Cross-Source Synthesis (skip if single_source mode or no coverage) ---
    let synthesizerOutput: CrossSourceSynthesizerOutput | null = null;
    if (!plan.skipSynthesis && validReports.length >= 2) {
      const synthesizerCheck = await getCheckpoint<CrossSourceSynthesizerOutput>(topic, "synthesizer");
      if (synthesizerCheck) {
        synthesizerOutput = synthesizerCheck.data;
        log.info({ topic }, "Loaded Synthesizer from checkpoint");
        await this.pub(sessionId, "synthesizer", "completed", "Loaded from cache", 85);
      } else {
        const groundTruth = this.compressGroundTruth(matchedOutput.matchedArticles);
        synthesizerOutput = await this.synthesize({
          topic: expanded.expandedTopic,
          summary: matchedOutput.summary,
          sourceReports: validReports,
          groundTruth,
        }, sessionId);
        await setCheckpoint(topic, "synthesizer", synthesizerOutput);
      }
    } else {
      await this.pub(sessionId, "synthesizer", "skipped",
        plan.mode === "single_source" ? "Single source - no cross-source synthesis needed" : "No coverage", 85);
    }

    // Agent 5: Verification (skip if no synthesis) ---
    let verifierOutput: VerifierOutput = { verified: true, issues: [], corrections: null, confidenceScore: 1, verificationNotes: "" };
    if (synthesizerOutput) {
      const verifierCheck = await getCheckpoint<VerifierOutput>(topic, "verifier");
      if (verifierCheck) {
        verifierOutput = verifierCheck.data;
        log.info({ topic }, "Loaded Verifier from checkpoint");
        await this.pub(sessionId, "verifier", "completed", "Loaded from cache", 95);
      } else {
        verifierOutput = await this.verify({
          originalArticles: scrapedArticles,
          sourceReports: validReports,
          synthesis: synthesizerOutput.synthesis,
          detectedBiasPatterns: synthesizerOutput.detectedBiasPatterns,
          topic,
        }, sessionId);
        await setCheckpoint(topic, "verifier", verifierOutput);
      }
    }

    // Assemble final result ---
    const result: NewsComparisonResult = {
      topic,
      summary: plan.mode === "no_coverage"
        ? `No coverage found for "${topic}".`
        : matchedOutput.summary,
      lastUpdated: new Date().toISOString(),
      synthesis: synthesizerOutput
        ? {
            overallAnalysis: synthesizerOutput.synthesis.overallAnalysis,
            keyTakeaway: synthesizerOutput.synthesis.keyTakeaway,
          }
        : {
            overallAnalysis: plan.mode === "no_coverage"
              ? `No news articles found covering "${topic}". Try a different search term.`
              : `Analysis of "${topic}" is based on a single source. Cross-source comparison requires articles from multiple outlets.`,
            keyTakeaway: "Cross-referencing multiple news sources reveals editorial framing differences.",
          },
      sourcesFound: validReports,
      verificationStatus: verifierOutput.verified ? "verified" : "flagged",
      verificationIssues: verifierOutput.issues,
    };

    // Output guardrail: PII redaction + optional content safety check
    const contentCheck = this.cfg.nvidiaApiKey
      ? async (prompt: string) => {
          const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.cfg.nvidiaApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "mistralai/mistral-7b-instruct-v0.3",
              messages: [{ role: "user", content: prompt }],
              temperature: 0.1,
              max_tokens: 10,
            }),
          });
          const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          return json.choices?.[0]?.message?.content ?? "no";
        }
      : undefined;

    const safe = await applyOutputGuardrail(result as unknown as Record<string, unknown>, contentCheck);
    if (!safe) {
      result.verificationStatus = "flagged";
      result.verificationIssues.push("Content flagged by output safety check.");
      log.warn({ topic }, "Output guardrail flagged content");
    }

    // Cache result
    await setCachedComparison(topic, result);

    const totalCost = this.nvidia.getTotalCost();
    log.info({ sources: validReports.length, verified: verifierOutput.verified, cost: Number(totalCost.toFixed(5)) }, "Pipeline complete");

    await this.pub(sessionId, "orchestrator", "completed", "Analysis complete!", 100, {
      result,
      sourceCount: validReports.length,
      verified: verifierOutput.verified,
      cost: totalCost,
      costBreakdown: this.nvidia.getCostBreakdown(),
      circuitState: this.getCircuitState(),
    });

    return { result, cost: totalCost };
  }
}
