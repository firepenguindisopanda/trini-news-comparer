/**
 * NVIDIA NIMs API Client
 *
 * Wraps the NVIDIA NIMs chat-completion endpoint with:
 *   - Circuit breaker pattern (fail-fast when API is unhealthy)
 *   - Redis-backed rate limiting (token bucket, with in-memory fallback)
 *   - Exponential-backoff retry (2 retries for retryable errors)
 *   - JSON extraction from responses (handles markdown fences)
 *   - Per-model cost tracking
 *   - Graceful degradation when Redis is unavailable
 *
 * API docs: https://integrate.api.nvidia.com/v1/chat/completions
 */

import axios, { AxiosInstance } from "axios";
import { checkRateLimit } from "../../server/services/cache.js";
import { CircuitBreaker, CircuitBreakerOpenError } from "./CircuitBreaker.js";

//
// Types
//

export interface NvidiaNimRequest {
  model: string;
  systemPrompt: string;
  userContent: string;
  temperature?: number;
  maxTokens?: number;
  requestId: string;
}

export interface NvidiaNimCost {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

// Per‑1K‑token pricing (USD) for common NIMs models
const MODEL_COST: Record<string, { input: number; output: number }> = {
  "meta/llama-3.1-70b-instruct":     { input: 0.0009, output: 0.0009 },
  "meta/llama-3.1-8b-instruct":      { input: 0.0001, output: 0.0001 },
  "nvidia/nemotron-4-340b-instruct": { input: 0.0035, output: 0.0035 },
  "mistralai/mistral-7b-instruct-v0.3": { input: 0.0001, output: 0.0001 },
};

//
// Client
//

export class NvidiaNimsClient {
  private http: AxiosInstance;
  private costs: NvidiaNimCost[] = [];
  private endpoint: string;
  private circuitBreaker: CircuitBreaker;

  constructor(
    apiKey: string,
    opts?: {
      endpoint?: string;
      /** HTTP request timeout in ms (default: 120_000). */
      timeout?: number;
      /** Circuit breaker failure threshold (default: 3). */
      circuitFailureThreshold?: number;
      /** Circuit breaker OPEN timeout in ms (default: 30_000). */
      circuitTimeout?: number;
    },
  ) {
    this.endpoint = opts?.endpoint ?? "https://integrate.api.nvidia.com/v1/chat/completions";

    this.http = axios.create({
      // 70B models can take 60s+ for large payloads (e.g. 100 articles to match).
      timeout: opts?.timeout ?? 120_000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    this.circuitBreaker = new CircuitBreaker("NVIDIA NIMs", {
      failureThreshold: opts?.circuitFailureThreshold ?? 3,
      timeout: opts?.circuitTimeout ?? 30_000,
      successThreshold: 2,
      halfOpenMaxRequests: 1,
    });
  }

  //
  // Circuit breaker inspection
  //

  getCircuitState(): string {
    return this.circuitBreaker.getStateLabel();
  }

  getCircuitSummary(): Record<string, unknown> {
    return this.circuitBreaker.getSummary();
  }

  resetCircuit(): void {
    this.circuitBreaker.reset();
    console.log("[NvidiaNimsClient] Circuit breaker manually reset");
  }

  //
  // Cost tracking
  //

  getTotalCost(): number {
    return this.costs.reduce((s, c) => s + c.costUsd, 0);
  }

  getCostBreakdown(): Record<string, { calls: number; totalUsd: number; totalTokens: number }> {
    const map: Record<string, { calls: number; totalUsd: number; totalTokens: number }> = {};
    for (const c of this.costs) {
      if (!map[c.model]) map[c.model] = { calls: 0, totalUsd: 0, totalTokens: 0 };
      map[c.model].calls++;
      map[c.model].totalUsd += c.costUsd;
      map[c.model].totalTokens += c.totalTokens;
    }
    return map;
  }

  private trackCost(model: string, prompt: number, completion: number) {
    const rates = MODEL_COST[model] ?? { input: 0.001, output: 0.001 };
    const costUsd = (prompt / 1000) * rates.input + (completion / 1000) * rates.output;
    this.costs.push({ model, promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, costUsd });
  }

  //
  // JSON extraction from LLM responses
  //

  private extractJson<T>(raw: string): T {
    const trimmed = raw.trim();
    // Strip markdown code fences
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fence ? fence[1].trim() : trimmed;
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      // Try to find the first JSON object
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          return JSON.parse(objMatch[0]) as T;
        } catch { /* fall through */ }
      }
      throw new Error(`Failed to parse JSON from response. First 200 chars: ${jsonStr.slice(0, 200)}`);
    }
  }

  //
  // Rate-limit check (Redis-backed, with in-memory fallback)
  //

  private async checkRateLimit(requestId: string): Promise<void> {
    const { allowed, resetIn } = await checkRateLimit("rate:nim:minute", 60, 60);
    if (!allowed) {
      const wait = Math.min(resetIn, 30) * 1000;
      console.warn(`[NvidiaNims:${requestId}] Rate limited - waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  //
  // Core execution with retry (called through the circuit breaker)
  //

  private async executeWithRetry<T>(req: NvidiaNimRequest): Promise<{ data: T; tokens: number; cost: NvidiaNimCost }> {
    const { model, systemPrompt, userContent, temperature = 0.1, maxTokens = 2048, requestId } = req;
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        await this.checkRateLimit(requestId);

        const response = await this.http.post(this.endpoint, {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          temperature,
          max_tokens: maxTokens,
        });

        const choice = response.data.choices?.[0];
        if (!choice?.message?.content) {
          throw new Error("Empty response from model");
        }

        if (choice.finish_reason === "length") {
          console.warn(`[NvidiaNims:${requestId}] Response truncated (finish_reason=length)`);
        }

        const usage = response.data.usage;
        if (usage) {
          this.trackCost(model, usage.prompt_tokens, usage.completion_tokens);
        }

        const parsed = this.extractJson<T>(choice.message.content);
        const cost = this.costs[this.costs.length - 1] ?? {
          model, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
        };

        console.log(`[NvidiaNims:${requestId}] ${model} - OK (attempt ${attempt}, tokens: ${usage?.total_tokens ?? "?"})`);
        return { data: parsed, tokens: usage?.total_tokens ?? 0, cost };
      } catch (err) {
        lastError = err as Error;
        const retryable = this.isRetryable(err);
        if (retryable && attempt <= maxRetries) {
          const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
          console.warn(`[NvidiaNims:${requestId}] Attempt ${attempt} failed - retry in ${Math.round(delay)}ms: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, delay));
        } else if (!retryable) {
          throw err;
        }
      }
    }
    throw lastError ?? new Error("Unknown error in NvidiaNimsClient.executeWithRetry");
  }

  //
  // Main chat method (protected by circuit breaker)
  //

  /**
   * Send a chat request to the NVIDIA NIMs API.
   *
   * Protected by the circuit breaker - if the API has had `failureThreshold`
   * consecutive failures, all calls fail-fast with CircuitBreakerOpenError
   * for `timeout` ms, then allow one probe request.
   */
  async chat<T>(req: NvidiaNimRequest): Promise<{ data: T; tokens: number; cost: NvidiaNimCost }> {
    return this.circuitBreaker.call(() => this.executeWithRetry<T>(req));
  }

  //
  // Error classification
  //

  private isRetryable(err: unknown): boolean {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 429) return true;
      if (status && status >= 500 && status < 600) return true;
      if (!err.response && (err.code === "ECONNABORTED" || err.code === "ECONNRESET" || err.code === "ETIMEDOUT")) return true;
      if (status && status >= 400 && status < 500 && status !== 429) return false;
    }
    // JSON parse errors - retryable (model may fix output)
    if (err instanceof SyntaxError && err.message.includes("JSON")) return true;
    return false;
  }
}
