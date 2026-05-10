import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

import { HttpError } from "../../lib/httpError.js";

export const JOURNAL_ADMIN_AUTH_HEADERS = ["Authorization: Bearer", "X-Journal-Secret"] as const;

export function getExpectedJournalAdminToken() {
  return String(process.env.JOURNAL_ADMIN_TOKEN || "").trim();
}

export function getJournalAdminAuthDebug() {
  const expected = getExpectedJournalAdminToken();
  return {
    journalAdminTokenConfigured: expected.length > 0,
    journalAdminTokenLength: expected.length,
    acceptedAuthHeaders: [...JOURNAL_ADMIN_AUTH_HEADERS]
  };
}

export function normalizeJournalAdminToken(value: unknown) {
  return String(value || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function tokenMatches(provided: string, expected: string) {
  if (!provided || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function getJournalAdminTokenFromRequest(req: Request) {
  const authorizationToken = normalizeJournalAdminToken(req.header("authorization"));
  if (authorizationToken) return authorizationToken;

  const journalSecretToken = normalizeJournalAdminToken(req.header("x-journal-secret"));
  if (journalSecretToken) return journalSecretToken;

  // Backward-compatible for existing internal tools; not advertised in public config.
  const legacyHeaderToken = normalizeJournalAdminToken(req.header("x-journal-admin-token"));
  if (legacyHeaderToken) return legacyHeaderToken;

  const queryToken = normalizeJournalAdminToken(req.query.token);
  if (queryToken) return queryToken;

  return "";
}

export function requireJournalAdmin(req: Request) {
  const expected = getExpectedJournalAdminToken();
  if (!expected) {
    throw new HttpError(500, "JOURNAL_ADMIN_TOKEN_NOT_CONFIGURED");
  }

  const provided = getJournalAdminTokenFromRequest(req);
  if (!tokenMatches(provided, expected)) {
    throw new HttpError(401, "UNAUTHORIZED_JOURNAL_ADMIN");
  }
}
