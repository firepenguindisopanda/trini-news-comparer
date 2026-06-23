/**
 * Output Guardrail
 *
 * Post-processing applied to all results before caching/serving:
 *   1. PII redaction via regex (zero NIM cost)
 *   2. Content safety NIM classifier (optional, only if client available)
 */

import { childLogger } from "./logger.js";

const log = childLogger({ module: "output-guardrail" });

//
// Layer 1: PII redaction patterns
//

type RedactFn = (text: string) => string;

const PII_REDACTORS: Array<{ pattern: RegExp; replacement: string }> = [
  // T&T phone numbers: variations of 868-XXX-XXXX, (868) XXX-XXXX, etc.
  { pattern: /\b\(?868\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, replacement: "[PHONE REDACTED]" },
  // Generic international phone numbers
  { pattern: /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, replacement: "[PHONE REDACTED]" },
  // Email addresses
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[EMAIL REDACTED]" },
  // T&T TRN (Tax Registration Number): 9 digits, sometimes with TT prefix
  { pattern: /\bTT\s?\d{6,9}\b|\b\d{9}\b/g, replacement: "[ID REDACTED]" },
  // Credit card numbers (Luhn checksum not checked - broad coverage)
  { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: "[CARD REDACTED]" },
];

function redactPII(text: string): string {
  let result = text;
  for (const { pattern, replacement } of PII_REDACTORS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Recursively walk a result object and redact PII from all string values.
 */
function redactObjectPII(obj: unknown): void {
  if (typeof obj === "string") {
    // Can't mutate in-place - handled by `applyOutputGuardrail` return
    return;
  }
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const val = (obj as Record<string, unknown>)[key];
      if (typeof val === "string") {
        (obj as Record<string, unknown>)[key] = redactPII(val);
      } else if (val && typeof val === "object") {
        redactObjectPII(val);
      }
    }
  }
}

//
// Layer 2: Content safety classifier (NIM call)
//

const CONTENT_SAFETY_PROMPT = `You are a content safety classifier for a Trinidad & Tobago news comparison tool.

Determine if the following analysis text contains any:
- Hate speech or incitement to violence
- Harassment or personal attacks
- Explicit sexual content
- Dangerous or illegal advice

Reply with exactly one word: "safe" or "unsafe".

Analysis text:`;

/**
 * Apply the output guardrail to a result object.
 *
 * @param result - The result object to redact in-place
 * @param contentCheck - Optional async content safety function (NIM call)
 * @returns true if content is safe (or no classifier configured), false if blocked
 */
export async function applyOutputGuardrail(
  result: Record<string, unknown>,
  contentCheck?: (text: string) => Promise<string>,
): Promise<boolean> {
  // Layer 1: PII redaction
  redactObjectPII(result);

  // Layer 2: Content safety check
  if (contentCheck && typeof result.synthesis === "object" && result.synthesis) {
    const synthesis = result.synthesis as Record<string, unknown>;
    const textsToCheck = [
      synthesis.overallAnalysis,
      synthesis.keyTakeaway,
    ].filter(Boolean) as string[];

    for (const text of textsToCheck) {
      try {
        const verdict = await contentCheck(CONTENT_SAFETY_PROMPT + `\n"""\n${text.slice(0, 2000)}\n"""\n\nAnswer:`);
        const cleaned = verdict.trim().toLowerCase().replace(/[^a-z]/g, "");
        if (cleaned !== "safe") {
          log.warn({ text: text.slice(0, 100) }, "Content safety check flagged");
          return false;
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, "Content safety check failed - allowing");
      }
    }
  }

  return true;
}
