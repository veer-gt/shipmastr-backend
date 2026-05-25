import pino from "pino";

export const loggerRedactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-auth-token",
  "req.headers.x-internal-secret",
  "req.headers.x-journal-secret",
  "req.headers.x-shipmastr-courier-key",
  "req.headers.x-shipmastr-signature",
  "req.headers.x-shipmastr-task-secret",
  "req.headers['x-internal-secret']",
  "req.headers['x-journal-secret']",
  "req.headers['x-shipmastr-courier-key']",
  "req.headers['x-shipmastr-signature']",
  "req.headers['x-shipmastr-task-secret']",
  "res.headers.authorization",
  "*.password",
  "*.passwordHash",
  "*.pan",
  "*.panEncrypted",
  "*.panIv",
  "*.panAuthTag",
  "*.apiKey",
  "*.token",
  "*.clientSecret",
  "*.webhookSecret",
  "*.credentials",
  "*.secret",
  "*.secretRef",
  "body.password",
  "body.pan",
  "body.credentials",
  "payload.pan",
  "payload.credentials"
];

export const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: loggerRedactPaths,
    censor: "[redacted]"
  }
});
