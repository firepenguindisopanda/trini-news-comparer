/**
 * CircuitBreaker
 *
 * A generic circuit-breaker implementation for protecting external API calls
 * from cascading failures. When the failure threshold is reached the circuit
 * "opens" and all subsequent calls fail-fast for `timeout` ms, giving the
 * downstream service time to recover.
 *
 * States:
 *   CLOSED    - normal operation, calls pass through
 *   OPEN      - failing fast; after `timeout` ms transitions to HALF_OPEN
 *   HALF_OPEN - limited calls allowed; success -> CLOSED, failure -> OPEN
 *
 * Usage:
 *   const cb = new CircuitBreaker('NVIDIA NIMs', { failureThreshold: 3 });
 *   const result = await cb.call(() => api.fetch());
 */

import { childLogger } from "../../server/services/logger.js";

//
// Error type
//

export class CircuitBreakerOpenError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

//
// Types
//

export enum CircuitState {
  CLOSED,
  OPEN,
  HALF_OPEN,
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening (default: 3). */
  failureThreshold?: number;
  /** Consecutive successes in HALF_OPEN before closing (default: 2). */
  successThreshold?: number;
  /** Milliseconds before transitioning from OPEN -> HALF_OPEN (default: 30_000). */
  timeout?: number;
  /** Max concurrent calls allowed in HALF_OPEN (default: 1). */
  halfOpenMaxRequests?: number;
}

//
// CircuitBreaker
//

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private halfOpenInFlight = 0;
  private log;

  public readonly name: string;
  public readonly failureThreshold: number;
  public readonly successThreshold: number;
  public readonly timeout: number;
  public readonly halfOpenMaxRequests: number;

  // Stats
  public totalCalls = 0;
  public totalFailures = 0;
  public totalFastFails = 0; // calls rejected while OPEN
  public totalTimeouts = 0;  // OPENtoHALF_OPEN transitions

  constructor(name: string, opts?: CircuitBreakerOptions) {
    this.name = name;
    this.log = childLogger({ module: "circuit-breaker", name });
    this.failureThreshold = opts?.failureThreshold ?? 3;
    this.successThreshold = opts?.successThreshold ?? 2;
    this.timeout = opts?.timeout ?? 30_000;
    this.halfOpenMaxRequests = opts?.halfOpenMaxRequests ?? 1;
  }

  //
  // Public API
  //

  /**
   * Call a function through the circuit breaker.
   *
   * - If the circuit is OPEN and hasn't timed out -> throws CircuitBreakerOpenError
   * - If the circuit is HALF_OPEN and at max in-flight -> throws CircuitBreakerOpenError
   * - On success -> records success (may close the circuit)
   * - On failure -> records failure (may open the circuit)
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    // Check state --------------------------------------------------
    if (this.state === CircuitState.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.timeout) {
        this.totalFastFails++;
        throw new CircuitBreakerOpenError(
          `[${this.name}] Circuit breaker is OPEN - failing fast. Retry in ${Math.ceil((this.timeout - elapsed) / 1000)}s`,
          this.timeout - elapsed,
        );
      }
      // Timeout expired to half-open
      this.log.info({ timeout: this.timeout }, "Timeout expired, transitioning to HALF_OPEN");
      this.state = CircuitState.HALF_OPEN;
      this.successCount = 0;
      this.totalTimeouts++;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenInFlight >= this.halfOpenMaxRequests) {
        this.totalFastFails++;
        throw new CircuitBreakerOpenError(
          `[${this.name}] Circuit HALF_OPEN - at max in-flight requests (${this.halfOpenMaxRequests})`,
          this.timeout,
        );
      }
      this.halfOpenInFlight++;
    }

    // Execute ------------------------------------------------------
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      if (this.state === CircuitState.HALF_OPEN) {
        this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      }
    }
  }

  //
  // State transitions
  //

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.log.info({ successes: this.successCount }, "Consecutive successes in HALF_OPEN, transitioning to CLOSED");
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else {
      // Reset failure count on any success when CLOSED
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.totalFailures++;
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.log.warn({ failures: this.failureCount, timeoutMs: this.timeout }, "Consecutive failures - opening circuit");
      this.state = CircuitState.OPEN;
      this.successCount = 0;
    }
  }

  //
  // Inspection
  //

  getState(): CircuitState {
    return this.state;
  }

  getStateLabel(): string {
    switch (this.state) {
      case CircuitState.CLOSED:   return "CLOSED";
      case CircuitState.OPEN:     return "OPEN";
      case CircuitState.HALF_OPEN: return "HALF_OPEN";
    }
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenInFlight = 0;
  }

  getSummary(): Record<string, unknown> {
    return {
      name: this.name,
      state: this.getStateLabel(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      halfOpenInFlight: this.halfOpenInFlight,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalFastFails: this.totalFastFails,
      totalTimeouts: this.totalTimeouts,
      failureThreshold: this.failureThreshold,
      successThreshold: this.successThreshold,
      timeout: this.timeout,
    };
  }
}
