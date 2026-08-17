# Cloud Run Probe Evidence Schema Hardening Design

## Status and scope

This design hardens only the diagnostic evidence path on `hotfix/rate-limit-proxy-probe`. It replaces semantic denylisting of arbitrary Cloud Logging wrapper fields with a recursive, fail-closed schema. The branch remains diagnostic-only and must never be merged to `main`.

No cloud command, deployment, migration, feature enablement, production mutation, n8n/Gmail processing, notification, outbound communication, or push is authorized by this design. Courier Audit Intake remains disabled. Successful implementation authorizes only the existing isolated staging probe after its separate Mac transfer and pre-cloud gates pass.

## Problem statement

The evidence assembler currently validates the structural `jsonPayload` but scans arbitrary Cloud Logging wrapper objects with semantic key and value denylists before projection. Repeated reviews proved that this architecture is incomplete: unanticipated composite names such as `requestUriValue`, `clientIpText`, `responseurltext`, or `socketaddressvalue` can contain prohibited material, evade the denylist, and then disappear during projection while the assembler emits apparently clean evidence.

Adding more words to the denylist cannot close this class. Safety would continue to depend on anticipating every future spelling and Cloud Logging schema addition.

## Chosen approach

The assembler will accept only a complete, explicitly defined Cloud Run container-log schema. It will validate the entire entry recursively before projecting any structural field. Unknown keys, unknown nested keys, alternate payloads, type mismatches, excessive sizes, identity mismatches, and unexpected label data fail the whole assembly with a nonzero status and empty stdout.

Sensitive-value checks remain only as defense in depth after schema validation. Semantic key denylisting is no longer a trust boundary.

This deliberately trades availability for privacy. A new Google field or an unrecognized legitimate label aborts the temporary, human-supervised probe for explicit schema review. It never proceeds by silently discarding the field.

## Authoritative references and observed bounds

Google's current `LogEntry` reference defines the full envelope, including `httpRequest`, `split`, `errorGroups`, three AppHub fields, OpenTelemetry metadata, and the payload union:

- <https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry>

Google's Cloud Run logging documentation confirms that a `cloud_run_revision` has exactly five monitored-resource labels, that user-defined service labels can appear in `LogEntry.labels`, and shows a 145-character hexadecimal `labels.instanceId`:

- <https://docs.cloud.google.com/run/docs/logging>
- <https://docs.cloud.google.com/logging/docs/api/v2/resource-list>

The 256-character `instanceId` maximum below is a conservative margin above the observed 145-character example. It is not claimed to be a Google-documented ceiling. A future longer legitimate value must fail closed for operator review.

No retained local artifact contains a real raw LogEntry from this service. The implementation must not query live logs during development. The first authorized Mac probe remains the empirical schema check; any difference stops safely after cleanup.

## Complete accepted LogEntry envelope

Each of the ten entries must be a plain JSON object containing all of these required keys and no unknown key:

- `jsonPayload`
- `insertId`
- `labels`
- `logName`
- `receiveTimestamp`
- `resource`
- `severity`
- `timestamp`

These keys are optional, but when present must satisfy their complete nested contracts:

- `operation`
- `sourceLocation`
- `spanId`
- `trace`
- `traceSampled`

Every other top-level field is rejected. Known explicit rejects include:

- `httpRequest`
- `metadata`
- `split`
- `errorGroups`
- `apphub`
- `apphubDestination`
- `apphubSource`
- `otel`
- `protoPayload`
- `textPayload`

The default-deny rule also rejects future fields not named here.

## Envelope scalar contracts

- `insertId`: string, 1–256 Unicode code points, with no ASCII control character.
- `logName`: literal `projects/shipmastr-core-prod/logs/run.googleapis.com%2Fstdout`.
- `timestamp` and `receiveTimestamp`: RFC 3339 strings, 20–35 ASCII characters, with a four-digit year, seconds, optional 1–9 fractional digits, and either `Z` or an explicit numeric offset. Parsing must yield a finite time.
- `severity`: literal `INFO`.
- `trace`: when present, literal prefix `projects/shipmastr-core-prod/traces/` followed by exactly 32 lowercase hexadecimal characters.
- `spanId`: when present, exactly 16 lowercase hexadecimal characters.
- `traceSampled`: when present, Boolean.

The complete raw `MATRIX_LOGS_JSON` string must be between 2 and 262,144 UTF-8 bytes before parsing. The matrix object must still contain exactly `gen1` and `gen2`, and each value must still contain exactly five entries in the approved case order.

## Resource identity contract

`resource` must contain exactly `type` and `labels`.

- `resource.type`: literal `cloud_run_revision`.
- `resource.labels`: an object containing exactly these five string keys and no others:
  - `project_id`: literal `shipmastr-core-prod`.
  - `service_name`: literal `shipmastr-api-staging`.
  - `configuration_name`: literal `shipmastr-api-staging`.
  - `location`: literal `asia-south1`.
  - `revision_name`: the generation-specific expected revision.

Gen1's five entries are checked only against `GEN1_REVISION`. Gen2's five entries are checked only against `GEN2_REVISION`. A Gen1/Gen2 swap or any stale/cross-service entry fails before projection.

## Per-generation log-label contract

Cloud Run revisions are immutable after creation. Immediately after each zero-traffic diagnostic revision is created and ownership-validated, the runner captures that revision's label map from the existing read-only revision description, before sending any probe request.

Each captured expected-label map must:

- be a plain JSON object;
- contain at most 64 entries;
- use strings only;
- have keys of 1–128 Unicode code points with no ASCII control character;
- have values of 0–256 Unicode code points with no ASCII control character; and
- have a canonical serialized form no larger than 16,384 UTF-8 bytes.

The runner passes separate canonical maps through `GEN1_EXPECTED_LOG_LABELS_JSON` and `GEN2_EXPECTED_LOG_LABELS_JSON`.

Each entry's `labels` object must contain `instanceId` and may contain no unknown key:

- `instanceId`: hexadecimal string, 1–256 characters.
- Any other key must exist in that generation's captured expected-label map and its value must match exactly.
- A captured expected label may be absent from the LogEntry.
- An unexpected key or a substituted value fails the whole assembly.

This asymmetry accepts under-inclusion but rejects over-inclusion. It supports legitimate configured service/revision labels without accepting arbitrary Cloud Logging metadata.

The raw expected-label maps remain ephemeral. They are never written to `probe-results.json` or `probe-context.json`. The final context records only each canonical map's SHA-256 and entry count. Shell variables are unset and temporary files removed during teardown.

## Optional nested-object contracts

`operation`, when present:

- is a plain object with at least one key;
- permits only `id`, `producer`, `first`, and `last`;
- bounds `id` and `producer` to strings of 1–256 Unicode code points with no ASCII control character; and
- requires `first` and `last` to be Boolean.

`sourceLocation`, when present:

- is a plain object with at least one key;
- permits only `file`, `line`, and `function`;
- bounds `file` and `function` to strings of 1–512 Unicode code points with no ASCII control character; and
- requires `line` to be a decimal int64 string from `0` through `9223372036854775807`.

No recursive arbitrary map is accepted anywhere in these objects.

## `jsonPayload` contract

The existing 13 structural keys remain required and unchanged:

- `eventName`
- `probeCase`
- `path`
- `forwardedPresent`
- `forwardedParseStatus`
- `forwardedElementCount`
- `forwardedMarkerPosition`
- `xForwardedForPresent`
- `xForwardedForElementCount`
- `xForwardedForMarkerPosition`
- `reqIpEqualsSocket`
- `reqIpXForwardedForPosition`
- `socketXForwardedForPosition`

The existing literals, enums, count/position bounds, Booleans, case order, and `/api/health` path checks remain unchanged.

Only these Pino metadata keys are optional:

- `hostname`: string, 1–253 ASCII characters matching `^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`.
- `level`: integer, literal `30`.
- `msg`: literal `rate limit proxy probe`.
- `pid`: integer from 1 through 2,147,483,647.
- `time`: integer from 0 through `Number.MAX_SAFE_INTEGER`.

No other payload key is accepted.

## Validation and projection order

For each generation:

1. Validate the expected revision and expected-label map inputs.
2. Validate the generation array length and exact case order.
3. Validate each complete LogEntry envelope and every nested object.
4. Validate resource identity against the generation-specific revision.
5. Validate the complete LogEntry label map against the generation-specific captured map.
6. Validate the exact payload schema and structural values.
7. Run bounded sensitive-value checks over the already schema-valid entry as defense in depth.
8. Only then project the 13 structural fields.
9. Validate the projected result again before output.

Any failure exits nonzero with empty stdout. Validation errors use fixed numeric statuses or fixed sanitized messages only; rejected keys and values are never echoed.

## Runner data flow and cleanup

The existing staging-only sequence remains unchanged except for label capture:

1. Deploy and ownership-validate the Gen1 zero-traffic revision.
2. Canonicalize its immutable revision-label map, compute count and SHA-256, then send Gen1's five requests.
3. Repeat independently for Gen2.
4. Read exactly five revision-scoped events for each generation.
5. Pass both raw log arrays, both expected revisions, and both ephemeral expected-label maps to the assembler.
6. Publish only validated structural results plus label-map hashes/counts after the existing verified cleanup gate.
7. Unset raw logs and raw label maps and remove their temporary files on success, failure, timeout, `INT`, and `TERM`.

Label capture is read-only. It does not add a cloud mutation. Because revisions are immutable, the captured map cannot drift during that revision's lifetime.

## Failure handling

- Schema mismatch, identity mismatch, label mismatch, excessive input, or sensitive material blocks evidence publication.
- The assembler writes no partial result and emits no rejected material.
- The runner preserves the original nonzero status, executes its existing tag/token cleanup, and retains the reconciliation lock whenever remote cleanup is unresolved.
- A legitimate new Google field is treated as schema drift: teardown completes, the feature stays disabled, and the runner reports only a fixed validation stage/code. Discovering the rejected field path or value requires a separate, explicitly approved local inspection; rejected input is never echoed automatically.
- Production remains read-only and no limiter interpretation occurs.

## TDD and verification

Tests must exercise the real assembler and normal runner fixture, not source-text presence alone.

The RED→GREEN suite must cover:

- a canonical full Cloud Run container-log envelope for both generations;
- every allowed nested object rejecting an unknown key at every depth;
- every explicitly rejected top-level LogEntry field and both alternate payload types;
- an arbitrary future top-level field;
- missing required envelope keys;
- wrong scalar types and each stated lower/upper bound;
- exact Gen1/Gen2 revision attribution and a cross-generation swap;
- the exact five monitored-resource labels, wrong literals, missing labels, and extra labels;
- a 145-character hexadecimal `instanceId` accepted and a 257-character value rejected;
- configured label key/value acceptance;
- missing configured labels accepted;
- unknown and substituted labels rejected;
- expected-label map count, key, value, and serialized-size limits;
- operation/source-location nested schemas and bounds;
- unchanged sensitive-value rejection with empty stdout;
- runner capture and propagation of separate immutable Gen1/Gen2 label maps;
- raw label maps absent from final results/context while hashes/counts are present;
- cleanup on success, failure, timeout, `INT`, and `TERM`;
- unchanged staging-only mutation targets, zero production mutation, disabled feature, and no active traffic shift.

After task review passes, run the focused diagnostic suite, the approved synthetic full-suite process, the privacy/boundary audit, and one final independent review before requesting push approval.

## Rejected alternatives

- **Expand semantic token/context lists:** already failed repeatedly and cannot enumerate future composite names.
- **Project first and validate only output:** can certify contaminated input after silently discarding unknown fields.
- **Accept arbitrary label maps with bounded strings:** closes unbounded-value risk but leaves unknown keys and substituted values trusted.
- **Reject all labels except a fixed `instanceId`:** breaks legitimate configured Cloud Run labels and already conflicts with Google's documented propagation behavior.
- **Persist raw revision-label maps for audit:** unnecessary infrastructure-data retention; hashes/counts plus immutable revision identity are sufficient for this temporary probe.

## Stop gate

Implementation completion does not authorize a cloud run, push, deployment, feature enablement, limiter correction, production action, or merge. It authorizes only the existing exact-head verification and independent review gates. Separate explicit approval remains required before transferring and pushing the final diagnostic head.
