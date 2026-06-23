/**
 * Structured JSON logger (Pino)
 *
 * Outputs JSON logs to stdout/stderr - ideal for Docker log aggregation.
 * In development, uses pino-pretty for human-readable output.
 */

import pino from "pino";
import type { Logger } from "pino";

const isDev = process.env.NODE_ENV !== "production";

const transport = isDev
  ? pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    })
  : undefined;

const logger: Logger = pino(
  {
    level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "body.password"],
      censor: "[REDACTED]",
    },
    serializers: {
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
      err: pino.stdSerializers.err,
    },
  },
  transport,
);

/**
 * Create a child logger with a fixed set of bindings.
 * Use this per-module so every log line includes the module name.
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export default logger;
