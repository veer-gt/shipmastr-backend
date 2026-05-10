import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../../lib/httpError.js";
import { getJournalAdminAuthDebug, requireJournalAdmin } from "./journal-auth.js";

function makeReq(headers: Record<string, string | undefined> = {}, query: Record<string, string | undefined> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    query
  } as any;
}

function withJournalToken<T>(value: string | undefined, run: () => T) {
  const previous = process.env.JOURNAL_ADMIN_TOKEN;
  if (value === undefined) {
    delete process.env.JOURNAL_ADMIN_TOKEN;
  } else {
    process.env.JOURNAL_ADMIN_TOKEN = value;
  }

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.JOURNAL_ADMIN_TOKEN;
    } else {
      process.env.JOURNAL_ADMIN_TOKEN = previous;
    }
  }
}

describe("journal admin auth", () => {
  it("allows a valid Authorization Bearer token", () => {
    withJournalToken("a".repeat(64), () => {
      assert.doesNotThrow(() => {
        requireJournalAdmin(makeReq({ authorization: `Bearer ${"a".repeat(64)}\n` }));
      });
    });
  });

  it("allows a valid X-Journal-Secret token", () => {
    withJournalToken("b".repeat(64), () => {
      assert.doesNotThrow(() => {
        requireJournalAdmin(makeReq({ "x-journal-secret": ` ${"b".repeat(64)} ` }));
      });
    });
  });

  it("rejects an invalid token without comparing unequal buffers", () => {
    withJournalToken("c".repeat(64), () => {
      assert.throws(
        () => requireJournalAdmin(makeReq({ authorization: `Bearer ${"c".repeat(63)}` })),
        (err) => err instanceof HttpError && err.status === 401 && err.message === "UNAUTHORIZED_JOURNAL_ADMIN"
      );
    });
  });

  it("reports missing env as not configured and returns a status error", () => {
    withJournalToken(undefined, () => {
      assert.deepEqual(getJournalAdminAuthDebug(), {
        journalAdminTokenConfigured: false,
        journalAdminTokenLength: 0,
        acceptedAuthHeaders: ["Authorization: Bearer", "X-Journal-Secret"]
      });
      assert.throws(
        () => requireJournalAdmin(makeReq({ authorization: "Bearer anything" })),
        (err) => err instanceof HttpError && err.status === 500 && err.message === "JOURNAL_ADMIN_TOKEN_NOT_CONFIGURED"
      );
    });
  });
});
