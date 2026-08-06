# Safe Error Response Boundary Design

## Context

The backend global error handler currently returns `HttpError.details` and
Prisma `P2002` metadata directly to clients. Those values are useful while
debugging but are not a public API contract and may contain internal values,
database identifiers, provider responses, tokens, URLs, or future sensitive
fields.

The accepted compatibility audit found three controlled clients that consume
Zod `VALIDATION_ERROR` field details and no controlled client that consumes
ordinary `HttpError.details` or Prisma uniqueness metadata. External partner
consumers remain unobservable, and no partner API program is in scope for the
controlled one-merchant pilot.

This reconstruction starts from backend commit
`b26bd723357f4b1f73601d35e606f0155967fcba`. The previous local-only branch is
historical evidence only; its commit objects are unavailable in this runtime.

## Goals

- Make ordinary `HttpError.details` internal-only by default.
- Provide an explicit, fail-closed subtype for deliberately public details.
- Remove Prisma `P2002` metadata from HTTP responses.
- Preserve bounded, redaction-safe operational diagnostics for both branches.
- Preserve the existing Zod, `P2025`, payload-too-large, and generic `500`
  response contracts.

## Non-goals

- Migrating existing `HttpError` call sites to the public subtype.
- Changing routes, RBAC, schemas, migrations, dependencies, deployment,
  infrastructure, frontend code, or production state.
- Publishing a partner API contract.
- Logging raw errors, raw detail values, raw Prisma metadata, SQL, or request
  query strings.

## Public error contract

`HttpError` keeps its existing constructor and `details?: unknown` property so
internal call sites and service-layer inspection remain source-compatible.
The global handler stops serializing that property.

`PublicHttpError` extends `HttpError` and adds a separately validated
`publicDetails` property. Public details are a flat record whose values are
JSON primitives (`string`, `number`, `boolean`, or `null`) or arrays of those
primitives. Nested objects, nested arrays, functions, symbols, bigint values,
dates, and non-record roots are rejected. Runtime validation is mandatory even
though TypeScript also expresses the intended shape. Invalid public details
fail closed: they remain on the inherited internal `details` property but are
not assigned to `publicDetails` and are not returned to the client.

The handler returns:

- ordinary `HttpError`: `{ "error": err.message }`
- valid `PublicHttpError`: `{ "error": err.message, "details": err.publicDetails }`
- invalid `PublicHttpError`: `{ "error": err.message }`

No existing call site is migrated in this task, so all existing details become
private automatically.

## Bounded HttpError logging

Every `HttpError` branch writes one `warn` event named
`request_http_error_rejected`. The event contains only:

- numeric status and stable error code/message;
- request method;
- query-free route path;
- `clientNetworkKey(req)`, which is already an irreversible, truncated network
  pseudonym;
- detail root type;
- object key count or array item count where applicable; and
- at most 12 detail key names drawn from a fixed approved allowlist.

No detail value or raw error object is logged. Arbitrary key names are counted
but never emitted. The summary must remain bounded even for hostile objects.

## Prisma P2002 boundary

The client response for every Prisma `P2002` error is exactly:

```json
{"error":"UNIQUE_CONSTRAINT_VIOLATION"}
```

The handler writes one `warn` event named
`database_unique_constraint_rejected`. It includes the same bounded request
context plus optional schema identifiers only after validation against
`Prisma.dmmf.datamodel.models`:

- model names must be known and no longer than 64 characters; and
- constraint field names must belong to that model, be no longer than 64
  characters, and are capped at 12.

Raw `err.meta`, unknown model/field/constraint values, database URLs, tokens,
provider data, and constraint payloads are never logged.

## Preserved branches

- Zod remains `400 { error: "VALIDATION_ERROR", details: err.flatten() }` and
  keeps its existing bounded warning event.
- Prisma `P2025` remains `404 { error: "NOT_FOUND" }`.
- body-parser oversized input remains
  `413 { error: "PAYLOAD_TOO_LARGE" }`.
- unhandled errors remain `500 { error: "INTERNAL_SERVER_ERROR" }` with the
  existing server-side error logging.

## Test strategy

Tests use real Express requests for response behavior and bounded logger spies
for diagnostic behavior. Sentinel strings resembling tokens, database URLs,
and secrets are planted in `HttpError.details` and Prisma metadata; serialized
responses and warning arguments must not contain them. Positive assertions
also prove that the approved bounded metadata is actually logged.

Prisma metadata tests cover known identifiers, unknown identifiers, oversized
names, more than 12 fields, hostile scalar/object shapes, and fresh module
imports from both TypeScript-source and compiled JavaScript paths.

## Baseline and final verification

On this exact base and an exact lockfile install:

- focused error middleware baseline: 1 passed, 0 failed;
- full compiled baseline: 1,981 passed, 2 skipped, 2 failed;
- both failures are `ENOENT` reads of root-monorepo sibling artifacts:
  `seller-panel/src/pages/MerchantSetupCrudPage.jsx` and
  `docs/n8n/shipmastr-domains-mock-provisioning.workflow.json`.

Final full-suite proof requires exact copies of those two artifacts from root
commit `3fdabff1bfe8bb819c176562e37e22907ab10e85`. Anonymous Git and the connected
GitHub installation cannot read that private repository in this runtime. The
files must be supplied or access restored; they may only be used as temporary
sibling fixtures and must be removed after verification. They are never
backend product changes.
