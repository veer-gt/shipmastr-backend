# Safe Error Response Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep internal HTTP and Prisma diagnostics out of API responses while preserving explicit public validation details and bounded operational logs.

**Architecture:** Preserve `HttpError` as the internal error container, add a fail-closed `PublicHttpError` subtype for deliberate public data, and centralize all serialization and safe summaries in the existing global error middleware. Validate Prisma identifiers against the generated DMMF before logging them; never serialize or log raw metadata.

**Tech Stack:** TypeScript, Express, Node test runner, Prisma 6, Pino, Zod.

## Global Constraints

- Base commit is exactly `b26bd723357f4b1f73601d35e606f0155967fcba`.
- Product-code scope is only `src/lib/httpError.ts`, `src/middleware/error.ts`, `src/lib/httpError.test.ts`, and `src/middleware/error.test.ts`.
- Do not change routes, RBAC, schemas, migrations, dependencies, lockfiles, frontend code, infrastructure, deployment configuration, or production state.
- Do not migrate any existing `HttpError` call site to `PublicHttpError`.
- Ordinary `HttpError` responses are exactly `{ error: err.message }`.
- Only runtime-validated `PublicHttpError.publicDetails` may be serialized.
- Public detail values are JSON primitives or flat arrays of JSON primitives; nested structures fail closed.
- Prisma `P2002` responses are exactly `{ error: "UNIQUE_CONSTRAINT_VIOLATION" }`.
- Never log raw `HttpError.details`, raw `PublicHttpError.details`, raw Prisma errors, raw Prisma metadata, request query strings, tokens, secrets, database URLs, or provider values.
- Warning events are `request_http_error_rejected` and `database_unique_constraint_rejected`.
- Request logs use query-free routes and the existing `clientNetworkKey(req)` pseudonym.
- Detail key names come only from a fixed allowlist and are capped at 12.
- Prisma model and constraint-field names must be DMMF-known, no longer than 64 characters, and field lists are capped at 12.
- Zod, Prisma `P2025`, payload `413`, and generic `500` HTTP contracts remain unchanged.
- Tests must show RED before production changes, then GREEN, and planted secret/token/database-URL sentinels must be absent from responses and warning logs.
- No push, PR, merge, deployment, live enablement, or production mutation.

The test commands below use only local test placeholders:

```bash
export NODE_ENV=test APP_ENV=test
export DATABASE_URL='postgresql://test:test@127.0.0.1:5432/shipmastr_test'
export JWT_SECRET='test-jwt-secret-32-characters-minimum'
export APP_SECRET_PEPPER='test-app-secret-pepper'
export WEBHOOK_SECRET='test-webhook-secret-32-characters-minimum'
```

---

### Task 1: Explicit public error type

**Files:**
- Create: `src/lib/httpError.test.ts`
- Modify: `src/lib/httpError.ts`

**Interfaces:**
- Consumes: existing `HttpError(status, message, details?)` constructor.
- Produces: `PublicErrorPrimitive`, `PublicErrorDetails`,
  `isPublicErrorDetails(value)`, and
  `PublicHttpError.publicDetails?: PublicErrorDetails`.

- [ ] **Step 1: Write the failing public-contract tests**

Create three tests using the real classes:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HttpError,
  PublicHttpError,
  isPublicErrorDetails
} from "./httpError.js";

describe("PublicHttpError", () => {
  it("accepts a flat record of JSON primitives and primitive arrays", () => {
    const details = { field: "email", retryable: false, attempts: 2, empty: null, reasons: ["taken", 409, false, null] };
    assert.equal(isPublicErrorDetails(details), true);
    assert.deepEqual(new PublicHttpError(409, "EMAIL_TAKEN", details).publicDetails, details);
  });

  it("fails closed for nested or non-JSON detail values", () => {
    for (const details of [{ nested: { token: "secret" } }, { nested: [["secret"]] }, { count: 1n }, new Date()]) {
      const error = new PublicHttpError(400, "INVALID_PUBLIC_DETAILS", details as never);
      assert.equal(error.publicDetails, undefined);
      assert.equal(error.details, details);
    }
  });

  it("keeps ordinary HttpError details available only on the internal error object", () => {
    const details = { providerResponse: "internal" };
    assert.equal(new HttpError(502, "PROVIDER_FAILED", details).details, details);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsc --noEmit
```

Expected: compile failure because `PublicHttpError` and
`isPublicErrorDetails` do not exist.

- [ ] **Step 3: Implement the minimal fail-closed subtype**

Add the following shape without changing `HttpError`:

```ts
export type PublicErrorPrimitive = string | number | boolean | null;
export type PublicErrorDetails = Record<string, PublicErrorPrimitive | PublicErrorPrimitive[]>;

function isPrimitive(value: unknown): value is PublicErrorPrimitive {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

export function isPublicErrorDetails(value: unknown): value is PublicErrorDetails {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.values(value).every((entry) =>
      isPrimitive(entry) || (Array.isArray(entry) && entry.every(isPrimitive))
    );
  } catch {
    return false;
  }
}

export class PublicHttpError extends HttpError {
  readonly publicDetails?: PublicErrorDetails;

  constructor(status: number, message: string, details: PublicErrorDetails) {
    super(status, message, details);
    if (isPublicErrorDetails(details)) this.publicDetails = details;
  }
}
```

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm run build
node --test dist/lib/httpError.test.js
```

Expected: 3 tests pass and TypeScript compilation succeeds.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/httpError.ts src/lib/httpError.test.ts
git commit -m "feat: add explicit public http error contract"
```

---

### Task 2: Private HttpError responses and bounded diagnostics

**Files:**
- Modify: `src/middleware/error.test.ts`
- Modify: `src/middleware/error.ts`

**Interfaces:**
- Consumes: `HttpError`, `PublicHttpError.publicDetails`, `logger.warn`, and
  `clientNetworkKey(req)`.
- Produces: private-by-default `HttpError` responses and bounded
  `request_http_error_rejected` events.

- [ ] **Step 1: Extend the real Express test harness**

Allow `withApp` to accept a route callback that throws a supplied error and
add a warning spy that restores `logger.warn` in `finally`. The spy must store
the actual arguments and tests must serialize those arguments to check for
sentinels.

```ts
async function captureWarnings<T>(callback: (warnings: unknown[][]) => Promise<T>) {
  const warnings: unknown[][] = [];
  const original = logger.warn;
  logger.warn = ((...args: unknown[]) => { warnings.push(args); }) as typeof logger.warn;
  try { return await callback(warnings); }
  finally { logger.warn = original; }
}
```

- [ ] **Step 2: Write failing response and log tests**

Add tests proving:

```ts
const sentinel = "postgresql://db-user:db-pass@internal.example/shipmastr?token=sk-private";
const error = new HttpError(409, "ORDER_ALREADY_EXISTS", {
  field: "externalOrderId",
  token: sentinel,
  nested: { secret: sentinel }
});
```

- the response is exactly `{ error: "ORDER_ALREADY_EXISTS" }`;
- serialized warning arguments do not contain the sentinel, `externalOrderId`,
  `token`, `secret`, or the query string from `/failure?token=<sentinel>`;
- the warning does contain `request_http_error_rejected`, status `409`, code
  `ORDER_ALREADY_EXISTS`, method, query-free `/failure`, a 24-character
  `clientNetworkKey`, detail type `object`, key count `3`, and approved key name
  `field`;
- valid `PublicHttpError` details are returned unchanged;
- invalid runtime public details fail closed and are not returned.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm run build
node --test dist/lib/httpError.test.js dist/middleware/error.test.js
```

Expected: ordinary details still appear in the response and the new bounded
warning assertions fail.

- [ ] **Step 4: Implement bounded summaries and response selection**

Use a fixed allowlist and never read detail values:

```ts
const HTTP_DETAIL_KEY_ALLOWLIST = new Set([
  "field", "fields", "index", "limit", "reason", "reasons", "status",
  "mode", "event", "events", "fromState", "toState"
]);
const MAX_LOGGED_NAMES = 12;

function detailType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function summarizeHttpDetails(value: unknown) {
  try {
    const type = detailType(value);
    if (Array.isArray(value)) return { type, itemCount: value.length };
    if (!value || typeof value !== "object") return { type };
    const keys = Object.keys(value);
    return {
      type,
      keyCount: keys.length,
      keys: keys.filter((key) => HTTP_DETAIL_KEY_ALLOWLIST.has(key)).slice(0, MAX_LOGGED_NAMES)
    };
  } catch {
    return { type: "uninspectable" };
  }
}
```

Log one bounded event for every `HttpError`, then choose the response:

```ts
const body = err instanceof PublicHttpError && err.publicDetails
  ? { error: err.message, details: err.publicDetails }
  : { error: err.message };
return res.status(err.status).json(body);
```

The warning object contains only the approved fields from Global Constraints;
do not pass `err`, `err.details`, or request headers.

- [ ] **Step 5: Run focused GREEN checks**

Run:

```bash
npm run build
node --test dist/lib/httpError.test.js dist/middleware/error.test.js
```

Expected: all focused tests pass and planted sentinels are absent.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/middleware/error.ts src/middleware/error.test.ts
git commit -m "fix: keep http error details private"
```

---

### Task 3: Sanitize Prisma P2002 responses and logs

**Files:**
- Modify: `src/middleware/error.test.ts`
- Modify: `src/middleware/error.ts`

**Interfaces:**
- Consumes: `Prisma.PrismaClientKnownRequestError` and
  `Prisma.dmmf.datamodel.models`.
- Produces: exact P2002 response and bounded
  `database_unique_constraint_rejected` warning metadata.

- [ ] **Step 1: Add a real P2002 error factory**

```ts
function p2002(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: Prisma.prismaVersion.client,
    meta
  });
}
```

When a fresh middleware import is needed for isolation, always import the
runtime path with `new URL("./error.js", import.meta.url)` plus a query nonce.
Never hard-code `./error.ts`; compiled tests must be able to resolve the helper.

- [ ] **Step 2: Write failing P2002 boundary tests**

Tests must prove:

- response is exactly `{ error: "UNIQUE_CONSTRAINT_VIOLATION" }`;
- a known DMMF model and known fields appear in the positive warning;
- an unknown model causes all model/field/constraint metadata to be omitted;
- unknown fields are omitted while known fields are retained;
- unknown or hostile target strings are omitted;
- model and field names over 64 characters are omitted;
- more than 12 supplied fields are truncated to 12;
- scalar, nested-object, and malformed target shapes do not throw;
- planted token, secret, database URL, provider, and arbitrary metadata values
  appear in neither response nor serialized warning arguments;
- the warning still contains `database_unique_constraint_rejected`, method,
  query-free route, and `clientNetworkKey`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm run build
node --test dist/lib/httpError.test.js dist/middleware/error.test.js
```

Expected: the response still contains `details: err.meta` and the bounded
metadata assertions fail.

- [ ] **Step 4: Implement DMMF-known bounded metadata**

Build immutable lookup data from the generated DMMF:

```ts
const MAX_SCHEMA_NAME_LENGTH = 64;
const MAX_SCHEMA_FIELDS = 12;

const schemaModels = new Map(Prisma.dmmf.datamodel.models.map((model) => [
  model.name,
  {
    fields: new Set(model.fields.map((field) => field.name))
  }
]));
```

Accept names only when they are strings, no longer than 64 characters, and
present in the relevant DMMF set. Treat `meta.target` as constraint fields only
when it is an array of strings or one known field string. Cap logged fields at
12. If the model is missing or unknown, return an empty schema summary. Never
return the input metadata object.

Replace the P2002 response with the exact safe body and write one bounded warn
event. Do not change P2025.

- [ ] **Step 5: Run focused GREEN, type, and compiled-import checks**

Run:

```bash
npm run build
node --test dist/lib/httpError.test.js dist/middleware/error.test.js
npx tsc --noEmit
```

Expected: all focused tests pass, the compiled fresh-import test passes, and
TypeScript succeeds.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/middleware/error.ts src/middleware/error.test.ts
git commit -m "fix: sanitize prisma uniqueness errors"
```

---

### Task 4: Lock unchanged global error contracts

**Files:**
- Modify: `src/middleware/error.test.ts`

**Interfaces:**
- Consumes: completed global `errorHandler`.
- Produces: regression coverage for unchanged branches.

- [ ] **Step 1: Write behavior tests for unchanged branches**

Using real Express requests, add exact response assertions for:

```ts
new ZodError([{ code: "custom", path: ["email"], message: "invalid" }])
// 400 { error: "VALIDATION_ERROR", details: <flattened Zod details> }

new Prisma.PrismaClientKnownRequestError("missing", {
  code: "P2025",
  clientVersion: Prisma.prismaVersion.client
})
// 404 { error: "NOT_FOUND" }

new Error("sentinel-internal-message")
// 500 { error: "INTERNAL_SERVER_ERROR" }
```

Keep the existing real oversized-body test for exact `413` behavior. The Zod
test must also confirm the existing warning contains only field path/rule and
does not expose the invalid value.

- [ ] **Step 2: Mutation-check the tests**

Temporarily alter each expected branch locally, run the focused suite to prove
the relevant test fails, then restore the production code before continuing.
Do not commit the mutation.

- [ ] **Step 3: Run focused verification**

```bash
npm run build
node --test dist/lib/httpError.test.js dist/middleware/error.test.js
npx tsc --noEmit
```

Expected: all focused tests pass and compilation succeeds.

- [ ] **Step 4: Commit Task 4**

```bash
git add src/middleware/error.test.ts
git commit -m "test: lock global error response contracts"
```

---

### Task 5: Final verification and repository hygiene

**Files:**
- Verify only; no product file is expected to change.

**Interfaces:**
- Consumes: exact root fixtures at root commit
  `3fdabff1bfe8bb819c176562e37e22907ab10e85`.
- Produces: final test, security, provenance, and clean-tree evidence.

- [ ] **Step 1: Verify branch scope and lockfile integrity**

Record HEAD, merge base, commit list, `git diff --stat`, changed filenames,
`package-lock.json` SHA-256, and `git status --short`. Fail if product changes
extend beyond the four allowed source/test files and the two Superpowers docs.

- [ ] **Step 2: Run focused verification fresh**

```bash
npm run build
node --test dist/lib/httpError.test.js dist/middleware/error.test.js
npx tsc --noEmit
```

- [ ] **Step 3: Stage temporary sibling fixtures**

Obtain exact copies of:

- `seller-panel/src/pages/MerchantSetupCrudPage.jsx`
- `docs/n8n/shipmastr-domains-mock-provisioning.workflow.json`

from root commit `3fdabff1bfe8bb819c176562e37e22907ab10e85`.
Record source commit and SHA-256 for each. Place only temporary sibling copies
at the paths expected by the backend tests. If exact provenance cannot be
established, stop and report the full suite as blocked; never fabricate the
files or weaken the tests.

- [ ] **Step 4: Run the complete backend suite**

```bash
npm test
```

Expected: all executed tests pass. Record pass/fail/skip counts and exit code.

- [ ] **Step 5: Remove temporary fixtures and generated output**

Remove only the temporary sibling files/directories created in Step 3. Inspect
Git status before cleanup. Restore only generated tracked changes under
`dist/` and `node_modules/` after proving no product changes are mixed in.

- [ ] **Step 6: Run security and scope audits**

Confirm by source/diff inspection and tests that:

- ordinary HttpError and P2002 response bodies contain no `details`, `meta`, or
  `target` fields;
- logger calls contain no raw `err.details`, raw `err.meta`, or raw Prisma error;
- sentinel strings are absent from captured logs and responses;
- Zod still returns public field errors;
- no routes, roles, schemas, migrations, dependency manifests, or deployment
  files changed;
- final Git status is clean.

- [ ] **Step 7: Request final whole-branch review**

Generate a review package from base `b26bd723357f4b1f73601d35e606f0155967fcba`
to HEAD and dispatch the most capable reviewer. If findings exist, use exactly
one fix wave and one scoped re-review as required by
`superpowers:subagent-driven-development`.
