import pino from "pino";

export const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.x-auth-token",
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
    ],
    censor: "[redacted]"
  }
});
