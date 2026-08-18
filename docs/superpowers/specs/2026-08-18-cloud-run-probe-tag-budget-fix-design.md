# Cloud Run Probe Tag-Budget Fix Design

Date: 2026-08-18

Branch: `hotfix/rate-limit-proxy-probe`

Failed probe head: `13123c4ebf2aab6bef89b7d5e2fc429144c74927`

## Problem and evidence

The approved staging-only probe built and pushed its diagnostic image successfully, then Cloud Run rejected the first no-traffic deployment before creating a revision:

```text
spec.traffic.tag: traffic tag 'rlp-20260818051610-13123c4ebf2a-5004c74d6a49-g1'
and service name 'shipmastr-api-staging' together are too long.
Combined traffic tag and service name cannot exceed 46 characters.
```

The target service is 21 characters and the generated tag is 47, for a combined length of 68. The observed 46-character ceiling is target-specific platform evidence, not a portable Cloud Run constant.

The failure occurred at request validation. No diagnostic revision was created, no probe evidence was published, the Courier Audit Intake feature remained disabled, and the runner contains no production mutation path.

## Considered approaches

### A. Compact readable identity — selected

Use a 25-character tag:

```text
rlp-<6-digit UTC suffix><4-hex source SHA><8-hex nonce>-g1
rlp-<6-digit UTC suffix><4-hex source SHA><8-hex nonce>-g2
```

Arithmetic for the fixed staging target:

```text
tag:     4 + 6 + 4 + 8 + 3 = 25
service: 21
combined:                    46
```

This retains visible time, source, nonce, and generation components. Truncating the visible SHA and nonce reduces at-a-glance identity strength, but cleanup never trusts the tag alone: it still proves the exact recorded revision, immutable image digest, generation, and concurrency before removal. The operator lock prevents concurrent publication in the same worktree, while the 8-hex nonce supplies 32 bits of per-run randomness.

### B. Hash the complete run identity

A fixed 18-hex digest would fit and provide strong compact uniqueness, but it would remove the human-readable time/source/nonce cues used during operator review.

### C. Remove traffic tags

Rejected because tags are the addressable no-traffic probe endpoint and the first link in the cleanup ownership proof.

## Implementation boundary

Change only:

- `scripts/rate-limit-proxy-probe.sh`
- `scripts/rate-limit-proxy-probe.test.mjs`
- this design and the matching implementation plan

`create_run_identity` will accept the existing full timestamp, source SHA, and nonce inputs, validate them first, derive the compact components, and build distinct `g1`/`g2` tags. The full tested/source heads remain recorded in probe context; only the Cloud Run tag is compacted.

No limiter behavior, application route, logger, evidence schema, Prisma model, Courier Audit Intake implementation, service traffic, feature flag, production access, cleanup ownership proof, or artifact format changes.

## TDD and verification

Before production edits, add a test that reads the actual runner service constant and asserts for both generations:

- the existing tag violates the observed target constraint, establishing genuine RED;
- generated tags match the compact lowercase grammar;
- `service.length + tag.length <= 46`;
- tags remain distinct and contain the expected compact timestamp, source, nonce, and generation components;
- Bash 3.2 self-test exercises the same identity function.

After the minimum correction:

- run Bash syntax and the actual self-test;
- run the focused runner/parser/evidence tests;
- run the existing exact-head focused package gate;
- perform independent review;
- commit and request approval for the new exact SHA.

No cloud retry occurs until that new exact head is separately approved. Before retry, the operator performs a read-only staging residue check. The retry remains two no-traffic staging revisions with `COURIER_AUDIT_INTAKE_ENABLED=false`; production remains read-only and fingerprinted.

## Success criteria

- The structural service-plus-tag test passes at 46 or less without hardcoding service length separately.
- Existing ownership, deadline, signal, cleanup, publication, privacy, and production-fingerprint tests remain green.
- No diagnostic branch merge or PR is created.
- A second cloud probe requires explicit approval for the newly tested head.
