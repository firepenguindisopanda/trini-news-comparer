/**
 * Pusher Channels service
 *
 * Pushes real-time progress events from the comparison pipeline to the
 * frontend so users see each agent stage as it completes.
 *
 * Gracefully degrades when Pusher is not configured - every method is
 * safe to call even without credentials.
 */

import Pusher from "pusher";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "pusher" });

//
// Singleton
//

let client: Pusher | null = null;

function getClient(): Pusher | null {
  if (client) return client;

  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  const cluster = process.env.PUSHER_CLUSTER || "us2";

  if (!appId || !key || !secret) {
    log.warn("Missing PUSHER_APP_ID, PUSHER_KEY, or PUSHER_SECRET - events disabled");
    return null;
  }

  try {
    client = new Pusher({ appId, key, secret, cluster, useTLS: true });
    log.info({ cluster }, "Pusher client initialised");
    return client;
  } catch (err) {
    log.error({ err }, "Failed to initialise Pusher");
    return null;
  }
}

//
// Public helpers
//

/** Validate that a channel name is well-formed for Pusher. */
function validChannel(channel: string): boolean {
  return /^[a-zA-Z0-9_\-=@.,;]+$/.test(channel);
}

/**
 * Publish an event on a channel.
 * Returns `true` if published, `false` if Pusher is not configured.
 */
export async function publish(
  channel: string,
  event: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const p = getClient();
  if (!p) return false;

  if (!validChannel(channel)) {
    log.warn({ channel }, "Invalid channel name - dropping event");
    return false;
  }

  try {
    await p.trigger(channel, event, data);
    return true;
  } catch (err) {
    log.warn({ err, channel, event }, "Failed to publish Pusher event");
    return false;
  }
}

//
// Typed progress-event helpers
//

export interface ProgressPayload {
  stage: string;
  status: "started" | "completed" | "failed" | "skipped";
  message: string;
  progress: number; // 0-100
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Publish a progress event for a comparison job.
 *
 * @param sessionId  Unique ID shared with the frontend (returned by the API)
 * @param payload    Progress payload
 */
export async function publishProgress(
  sessionId: string,
  payload: ProgressPayload,
): Promise<boolean> {
  const channel = `news-comparer-${sessionId}`;
  return publish(channel, `progress:${payload.stage}`, payload as unknown as Record<string, unknown>);
}

//
// Health check
//

export function pusherHealth(): { configured: boolean; appId: string | null } {
  const p = getClient();
  return {
    configured: p !== null,
    appId: process.env.PUSHER_APP_ID || null,
  };
}
