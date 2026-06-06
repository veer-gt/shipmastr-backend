import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../../lib/httpError.js";
import { handleRunDailyJournal } from "./journal.routes.js";

function makeReq(input: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}) {
  const headers = Object.fromEntries(
    Object.entries(input.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    body: input.body || {},
    query: {},
    header: (name: string) => headers[name.toLowerCase()]
  } as any;
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  } as any;
}

async function withJournalToken<T>(value: string | undefined, run: () => Promise<T>) {
  const previous = process.env.JOURNAL_ADMIN_TOKEN;
  if (value === undefined) {
    delete process.env.JOURNAL_ADMIN_TOKEN;
  } else {
    process.env.JOURNAL_ADMIN_TOKEN = value;
  }

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.JOURNAL_ADMIN_TOKEN;
    } else {
      process.env.JOURNAL_ADMIN_TOKEN = previous;
    }
  }
}

describe("journal run-daily route", () => {
  it("returns a safe skipped response when journal admin token config is missing", async () => {
    await withJournalToken(undefined, async () => {
      const res = makeRes();
      await handleRunDailyJournal(makeReq({
        body: {
          publish: true,
          sendEmail: true
        }
      }), res);

      const serialized = JSON.stringify(res.body);
      assert.equal(res.statusCode, 202);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.status, "SKIPPED");
      assert.equal(res.body.skipped, true);
      assert.equal(res.body.reason, "JOURNAL_ADMIN_TOKEN_NOT_CONFIGURED");
      assert.equal(res.body.published, false);
      assert.equal(res.body.emailSent, false);
      assert.doesNotMatch(serialized, /Bearer/);
    });
  });

  it("keeps the journal admin secret requirement enforced", async () => {
    await withJournalToken("j".repeat(64), async () => {
      const res = makeRes();
      await assert.rejects(
        () => handleRunDailyJournal(makeReq({
          headers: {
            "x-journal-secret": "wrong-token"
          },
          body: {
            publish: true,
            sendEmail: false
          }
        }), res),
        (error) => error instanceof HttpError && error.status === 401 && error.message === "UNAUTHORIZED_JOURNAL_ADMIN"
      );
    });
  });
});
