/**
 * React hook that subscribes to Pusher progress events for a comparison job.
 *
 * Usage:
 *   const { result, progress, status, error } = useComparisonJob(sessionId);
 */

import { useEffect, useState, useRef } from "react";
import Pusher from "pusher-js";
import type { NewsComparisonResult } from "../types";

//
// Types
//

export type JobStatus =
  | "idle"           // no job yet
  | "queued"         // job accepted, waiting to start
  | "scraping"       // fetching articles
  | "expanding"      // expanding topic
  | "matching"       // matching articles
  | "analyzing"      // per-source analysis
  | "synthesizing"   // cross-source synthesis
  | "verifying"      // fact-checking
  | "completed"      // done
  | "failed";        // error

export interface ProgressData {
  stage: string;
  status: "started" | "completed" | "failed" | "skipped";
  message: string;
  progress: number;
  metadata?: Record<string, unknown>;
}

export interface ComparisonJobState {
  /** Current job status (maps stages to user-facing labels). */
  status: JobStatus;
  /** Progress percentage 0–100. */
  progress: number;
  /** Human-readable step message. */
  message: string;
  /** Final result (only when status === "completed"). */
  result: NewsComparisonResult | null;
  /** Error message (only when status === "failed"). */
  error: string | null;
}

//
// Stage to status mapping
//

function stageToStatus(stage: string): JobStatus {
  switch (stage) {
    case "topicExpander":
    case "scraper":
      return "scraping";
    case "articleMatcher":
      return "matching";
    case "sourceAnalysts":
      return "analyzing";
    case "synthesizer":
    case "crossSourceSynthesizer":
      return "synthesizing";
    case "verifier":
      return "verifying";
    case "orchestrator":
      return "completed";
    default:
      return "queued";
  }
}

//
// Hook
//

export function useComparisonJob(
  sessionId: string | null,
): ComparisonJobState {
  const [state, setState] = useState<ComparisonJobState>({
    status: "idle",
    progress: 0,
    message: "",
    result: null,
    error: null,
  });

  const pusherRef = useRef<any>(null);

  useEffect(() => {
    if (!sessionId) {
      setState({ status: "idle", progress: 0, message: "", result: null, error: null });
      return;
    }

    // Connect Pusher --
    const pusherKey = import.meta.env.VITE_PUSHER_KEY;
    const pusherCluster = import.meta.env.VITE_PUSHER_CLUSTER || "us2";

    if (!pusherKey) {
      // Pusher not configured on frontend - silently fall back to polling
      return;
    }

    const pusher = new Pusher(pusherKey, { cluster: pusherCluster });
    pusherRef.current = pusher;

    const channelName = `news-comparer-${sessionId}`;
    const channel = pusher.subscribe(channelName);

    // Generic progress handler --
    const onProgress = (data: ProgressData) => {
      setState(prev => ({
        ...prev,
        status: stageToStatus(data.stage),
        progress: data.progress,
        message: data.message,
        error: data.status === "failed" ? data.message : prev.error,
      }));
    };

    // Bind all agent-stage events
    const stages = [
      "topicExpander",
      "articleMatcher",
      "sourceAnalysts",
      "synthesizer",
      "verifier",
      "orchestrator",
    ];

    const unbindFns: Array<() => void> = [];

    for (const stage of stages) {
      const eventName = `progress:${stage}`;
      channel.bind(eventName, onProgress);
      unbindFns.push(() => channel.unbind(eventName));
    }

    // Completion event --
    const onCompleted = (data: { result?: NewsComparisonResult; error?: string }) => {
      if (data.error) {
        setState(prev => ({
          ...prev,
          status: "failed",
          error: data.error!,
          progress: 100,
          message: `Failed: ${data.error}`,
        }));
      } else if (data.result) {
        setState(prev => ({
          ...prev,
          status: "completed",
          result: data.result!,
          progress: 100,
          message: "Analysis complete!",
        }));
      }
    };

    // Bind completion on any stage that might carry the result
    channel.bind("progress:orchestrator", onCompleted);

    return () => {
      for (const unbind of unbindFns) unbind();
      channel.unbind("progress:orchestrator");
      pusher.unsubscribe(channelName);
      pusher.disconnect();
      pusherRef.current = null;
    };
  }, [sessionId]);

  return state;
}
