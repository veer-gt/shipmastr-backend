#!/usr/bin/env bash
set -euo pipefail
set -f

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deployment-governance.sh"

[[ "$#" -eq 0 ]] || {
  shipmastr_governance_fail "ARGUMENTS_NOT_SUPPORTED"
  exit 64
}

PROJECT_ID="${PROJECT_ID:-shipmastr-core-prod}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-shipmastr-api}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-shipmastr-core-prod:asia-south1:shipmastr-postgres}"
readonly CLOUD_SQL_INSTANCE_ID="shipmastr-postgres"
readonly DATABASE_URL_SECRET="DATABASE_URL"
readonly MIGRATION_JOB="shipmastr-prisma-migrate-prod"
readonly MIGRATION_JOB_TIMEOUT="600s"
readonly EXPECTED_MIGRATION_1="20260712180000_h2a_platform_webhook_credentials"
readonly EXPECTED_MIGRATION_2="20260714100000_h2a_synthetic_tenant_lifecycle"

INVOCATION_UTC=""
if ! INVOCATION_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
  shipmastr_governance_fail "PRODUCTION_MIGRATION_INVOCATION_TIMESTAMP_INVALID"
  exit 1
fi
if ! shipmastr_governance_is_rfc3339_utc "$INVOCATION_UTC"; then
  shipmastr_governance_fail "PRODUCTION_MIGRATION_INVOCATION_TIMESTAMP_INVALID"
  exit 1
fi
readonly INVOCATION_UTC

INVOCATION_PID_FRAGMENT=""
if ! INVOCATION_PID_FRAGMENT="$(
  shipmastr_governance_format_pid_fragment "$$"
)"; then
  exit 1
fi
readonly INVOCATION_PID_FRAGMENT

APPROVED_COMMIT_PREFIX="${SHIPMASTR_APPROVED_COMMIT_SHA:-}"
APPROVED_COMMIT_PREFIX="${APPROVED_COMMIT_PREFIX:0:7}"
readonly APPROVED_COMMIT_PREFIX
readonly BACKUP_DESCRIPTION="shipmastr-prod-migration-${INVOCATION_UTC//[-:TZ]/}-${APPROVED_COMMIT_PREFIX}-${INVOCATION_PID_FRAGMENT}"

base64_encode() {
  base64 | tr -d '\n'
}

base64_decode() {
  local encoded="$1"

  if printf '%s' "$encoded" | base64 --decode 2>/dev/null; then
    return 0
  fi
  printf '%s' "$encoded" | base64 -D
}

production_migration_check_program() {
  cat <<'NODE'
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { PrismaClient } = require("@prisma/client");

const phase = process.argv[2] || "";
const expectedMigrations = [
  "20260712180000_h2a_platform_webhook_credentials",
  "20260714100000_h2a_synthetic_tenant_lifecycle",
];
const expectedRolledBackMigrationNames = [
  "20260519160000_storefront_renderer_phase3",
];
const expectedUnexpectedAppliedMigrationNames = [
  "202605070001_add_refined_user_roles",
  "202605071_master_admin_user_type",
];
const expectedSchemaObjects = [
  "enum:PlatformCredentialPurpose",
  "enum:SecurityFixtureKind",
  "enum:SecurityFixtureStatus",
  "foreign_key:platform_webhook_credentials_connection_id_fkey",
  "foreign_key:security_fixture_tenants_creator_internal_user_id_fkey",
  "foreign_key:security_fixture_tenants_merchant_id_fkey",
  "foreign_key:security_fixture_tenants_owner_user_id_fkey",
  "index:platform_webhook_credentials_connection_id_idx",
  "index:platform_webhook_credentials_connection_id_purpose_key",
  "index:platform_webhook_credentials_merchant_id_idx",
  "index:platform_webhook_credentials_merchant_id_platform_idx",
  "index:platform_webhook_credentials_pkey",
  "index:security_fixture_tenants_active_slot_key",
  "index:security_fixture_tenants_expires_at_idx",
  "index:security_fixture_tenants_fixture_kind_status_idx",
  "index:security_fixture_tenants_merchant_id_key",
  "index:security_fixture_tenants_owner_user_id_key",
  "index:security_fixture_tenants_pkey",
  "table:platform_webhook_credentials",
  "table:security_fixture_tenants",
].sort();
const marker = "SHIPMASTR_PROD_MIGRATION_RESULT=";

function same(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function emit(result) {
  process.stdout.write(`${marker}${Buffer.from(JSON.stringify(result), "utf8").toString("base64")}\n`);
}

async function main() {
  if (!new Set(["precheck", "postcheck"]).has(phase)) process.exit(2);
  if (process.env.APP_ENV !== "production" || !process.env.DATABASE_URL) process.exit(3);

  const status = spawnSync(
    "npx",
    ["prisma", "migrate", "status", "--schema", "prisma/schema.prisma"],
    {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 1024 * 1024,
    },
  );
  if (status.error || status.signal) process.exit(4);

  const statusText = `${status.stdout || ""}\n${status.stderr || ""}`;
  const prismaReportedDrift = /\bdrift\b/i.test(statusText);
  const prismaPendingNames = [...new Set(
    statusText.match(/\b\d{14}_[A-Za-z0-9_]+\b/g) || [],
  )].sort();

  const localMigrationNames = fs.readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_[A-Za-z0-9_]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const prisma = new PrismaClient();
  try {
    const databaseRows = await prisma.$queryRawUnsafe(
      "SELECT current_database()::text AS database_name",
    );
    const migrationRows = await prisma.$queryRawUnsafe(`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY migration_name
    `);

    const databaseName = databaseRows.length === 1
      ? String(databaseRows[0].database_name || "")
      : "";
    const appliedNames = new Set(
      migrationRows
        .filter((row) => row.finished_at && !row.rolled_back_at)
        .map((row) => String(row.migration_name)),
    );
    const structuredPendingNames = localMigrationNames
      .filter((name) => !appliedNames.has(name))
      .sort();
    const failedMigrationNames = migrationRows
      .filter((row) => !row.finished_at && !row.rolled_back_at)
      .map((row) => String(row.migration_name))
      .sort();
    const rolledBackMigrationNames = migrationRows
      .filter((row) => row.rolled_back_at)
      .map((row) => String(row.migration_name))
      .sort();
    const unexpectedAppliedMigrationNames = [...appliedNames]
      .filter((name) => !localMigrationNames.includes(name))
      .sort();
    const verifiedMigrationNames = migrationRows
      .filter((row) => expectedMigrations.includes(String(row.migration_name)) && row.finished_at && !row.rolled_back_at)
      .map((row) => String(row.migration_name))
      .sort();

    let schemaObjects = [];
    if (phase === "postcheck") {
      const enumRows = await prisma.$queryRawUnsafe(`
        SELECT t.typname::text AS name
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = current_schema()
          AND t.typname IN ('PlatformCredentialPurpose', 'SecurityFixtureKind', 'SecurityFixtureStatus')
      `);
      const tableRows = await prisma.$queryRawUnsafe(`
        SELECT table_name::text AS name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('platform_webhook_credentials', 'security_fixture_tenants')
      `);
      const indexRows = await prisma.$queryRawUnsafe(`
        SELECT indexname::text AS name
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname IN (
            'platform_webhook_credentials_pkey',
            'platform_webhook_credentials_connection_id_purpose_key',
            'platform_webhook_credentials_merchant_id_idx',
            'platform_webhook_credentials_connection_id_idx',
            'platform_webhook_credentials_merchant_id_platform_idx',
            'security_fixture_tenants_pkey',
            'security_fixture_tenants_active_slot_key',
            'security_fixture_tenants_merchant_id_key',
            'security_fixture_tenants_owner_user_id_key',
            'security_fixture_tenants_fixture_kind_status_idx',
            'security_fixture_tenants_expires_at_idx'
          )
      `);
      const foreignKeyRows = await prisma.$queryRawUnsafe(`
        SELECT c.conname::text AS name
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = current_schema()
          AND c.contype = 'f'
          AND c.conname IN (
            'platform_webhook_credentials_connection_id_fkey',
            'security_fixture_tenants_merchant_id_fkey',
            'security_fixture_tenants_owner_user_id_fkey',
            'security_fixture_tenants_creator_internal_user_id_fkey'
          )
      `);
      schemaObjects = [
        ...enumRows.map((row) => `enum:${row.name}`),
        ...tableRows.map((row) => `table:${row.name}`),
        ...indexRows.map((row) => `index:${row.name}`),
        ...foreignKeyRows.map((row) => `foreign_key:${row.name}`),
      ].sort();
    }

    const result = {
      phase,
      databaseName,
      prismaStatusExit: status.status,
      prismaReportedDrift,
      prismaPendingNames,
      structuredPendingNames,
      failedMigrationNames,
      rolledBackMigrationNames,
      unexpectedAppliedMigrationNames,
      verifiedMigrationNames,
      schemaObjects,
    };
    emit(result);

    const commonValid = databaseName
      && !prismaReportedDrift
      && failedMigrationNames.length === 0
      && same(rolledBackMigrationNames, expectedRolledBackMigrationNames)
      && same(
        unexpectedAppliedMigrationNames,
        expectedUnexpectedAppliedMigrationNames,
      );
    if (!commonValid) process.exit(10);

    if (phase === "precheck") {
      if (
        status.status !== 1
        || !same(prismaPendingNames, expectedMigrations)
        || !same(structuredPendingNames, expectedMigrations)
        || verifiedMigrationNames.length !== 0
        || schemaObjects.length !== 0
      ) process.exit(11);
      return;
    }

    if (
      status.status !== 0
      || prismaPendingNames.length !== 0
      || structuredPendingNames.length !== 0
      || !same(verifiedMigrationNames, expectedMigrations)
      || !same(schemaObjects, expectedSchemaObjects)
    ) process.exit(12);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => process.exit(20));
NODE
}

migration_task_payload() {
  local phase="$1"
  local task_source
  local node_payload

  case "$phase" in
    precheck|postcheck)
      node_payload="$(production_migration_check_program | base64_encode)"
      task_source="printf '%s' '${node_payload}' | base64 --decode | node - '${phase}'"
      ;;
    deploy)
      task_source="exec npx prisma migrate deploy --schema prisma/schema.prisma"
      ;;
    *)
      shipmastr_governance_fail "PRODUCTION_MIGRATION_JOB_PHASE_INVALID"
      return 1
      ;;
  esac

  printf '%s' "$task_source" | base64_encode
}

verify_migration_job_configuration() {
  local job_json="$1"
  local expected_task_argument="$2"

  EXPECTED_IMAGE_DIGEST="$IMAGE_DIGEST" \
  EXPECTED_SERVICE_ACCOUNT="$SERVICE_ACCOUNT" \
  EXPECTED_CLOUD_SQL_INSTANCE="$CLOUD_SQL_INSTANCE" \
  EXPECTED_TASK_ARGUMENT="$expected_task_argument" \
  JOB_JSON_TO_VERIFY="$job_json" \
  node <<'NODE'
const fs = require("node:fs");
const job = JSON.parse(process.env.JOB_JSON_TO_VERIFY || "null");
const expectedImage = process.env.EXPECTED_IMAGE_DIGEST || "";
const expectedServiceAccount = process.env.EXPECTED_SERVICE_ACCOUNT || "";
const expectedCloudSql = process.env.EXPECTED_CLOUD_SQL_INSTANCE || "";
const expectedTaskArgument = process.env.EXPECTED_TASK_ARGUMENT || "";
const outer = job?.spec?.template?.spec || job?.template || {};
const task = outer?.template?.spec || outer?.template || job?.template?.template || {};
const containers = task?.containers || [];
const container = containers[0] || {};
const env = container?.env || [];
const volumes = task?.volumes || [];
const annotations = job?.spec?.template?.metadata?.annotations || {};
const cloudSqlAnnotationKey = "run.googleapis.com/cloudsql-instances";
const cloudSqlNamePattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z](?:[a-z0-9-]*[a-z0-9])?:[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

function normalizeCloudSqlValues(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    return { valid: false, values: [] };
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (
    normalized.some((value) => !cloudSqlNamePattern.test(value))
    || new Set(normalized).size !== normalized.length
  ) {
    return { valid: false, values: [] };
  }
  return { valid: true, values: normalized };
}

const annotationPresent = Object.prototype.hasOwnProperty.call(
  annotations,
  cloudSqlAnnotationKey,
);
const rawAnnotation = annotations[cloudSqlAnnotationKey];
const annotationInstances = annotationPresent && typeof rawAnnotation === "string"
  ? normalizeCloudSqlValues(rawAnnotation.split(","))
  : { valid: !annotationPresent, values: [] };

let volumeMetadataPresent = false;
let volumeMetadataValid = true;
const rawVolumeInstances = [];
for (const volume of volumes) {
  if (!Object.prototype.hasOwnProperty.call(volume || {}, "cloudSqlInstance")) continue;
  volumeMetadataPresent = true;
  const instances = volume?.cloudSqlInstance?.instances;
  if (!Array.isArray(instances)) {
    volumeMetadataValid = false;
    continue;
  }
  rawVolumeInstances.push(...instances);
}
const volumeInstances = volumeMetadataValid
  ? normalizeCloudSqlValues(rawVolumeInstances)
  : { valid: false, values: [] };

const annotationUnambiguous = !annotationPresent
  || (annotationInstances.valid && annotationInstances.values.length === 1);
const volumeUnambiguous = !volumeMetadataPresent
  || (volumeInstances.valid && volumeInstances.values.length === 1);
const representationsAgree = !annotationPresent
  || !volumeMetadataPresent
  || annotationInstances.values[0] === volumeInstances.values[0];
const cloudSqlInstances = [
  ...annotationInstances.values,
  ...volumeInstances.values,
];
const uniqueCloudSqlInstances = [...new Set(cloudSqlInstances)];

if (containers.length !== 1 || container.image !== expectedImage) process.exit(2);
if ((task.serviceAccountName || task.serviceAccount) !== expectedServiceAccount) process.exit(3);
if (Number(task.maxRetries) !== 0) process.exit(4);
if (!new Set(["600", "600s"]).has(String(task.timeoutSeconds || task.timeout || ""))) process.exit(5);
if (Number(outer.taskCount || 1) !== 1 || Number(outer.parallelism || 1) !== 1) process.exit(6);
if (
  !annotationUnambiguous
  || !volumeUnambiguous
  || !representationsAgree
  || uniqueCloudSqlInstances.length !== 1
  || uniqueCloudSqlInstances[0] !== expectedCloudSql
) process.exit(7);
if (env.length !== 2) process.exit(8);

const byName = new Map(env.map((entry) => [entry.name, entry]));
const appEnv = byName.get("APP_ENV");
const databaseUrl = byName.get("DATABASE_URL");
if (appEnv?.value !== "production") process.exit(9);
const secretRef = databaseUrl?.valueFrom?.secretKeyRef || databaseUrl?.valueSource?.secretKeyRef || {};
if (secretRef.name !== "DATABASE_URL" || String(secretRef.key || secretRef.version || "") !== "latest") process.exit(10);
if ([...byName.keys()].sort().join(",") !== "APP_ENV,DATABASE_URL") process.exit(11);

if (JSON.stringify(container.command || []) !== JSON.stringify(["/bin/bash"])) process.exit(12);
if (JSON.stringify(container.args || []) !== JSON.stringify(["-ceu", expectedTaskArgument])) process.exit(13);
NODE
}

configure_migration_job() {
  local phase="$1"
  local task_payload
  local task_argument
  local job_json

  task_payload="$(migration_task_payload "$phase")"
  task_argument="printf '%s' '${task_payload}' | base64 --decode | /bin/bash"

  gcloud run jobs deploy "$MIGRATION_JOB" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --image "$IMAGE_DIGEST" \
    --service-account "$SERVICE_ACCOUNT" \
    --set-cloudsql-instances "$CLOUD_SQL_INSTANCE" \
    --set-env-vars "APP_ENV=production" \
    --set-secrets "DATABASE_URL=${DATABASE_URL_SECRET}:latest" \
    --command "/bin/bash" \
    --args "-ceu,${task_argument}" \
    --tasks 1 \
    --parallelism 1 \
    --max-retries 0 \
    --task-timeout "$MIGRATION_JOB_TIMEOUT" \
    --quiet

  job_json="$(gcloud run jobs describe "$MIGRATION_JOB" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --format=json)"
  verify_migration_job_configuration "$job_json" "$task_argument"
}

execution_name_from_json() {
  local execution_json="$1"

  EXECUTION_JSON_TO_VERIFY="$execution_json" node <<'NODE'
const value = JSON.parse(process.env.EXECUTION_JSON_TO_VERIFY || "null");
const raw = String(value?.metadata?.name || value?.name || "");
const name = raw.split("/").pop() || "";
if (!/^shipmastr-prisma-migrate-prod-[a-z0-9-]+$/.test(name)) process.exit(2);
process.stdout.write(`${name}\n`);
NODE
}

execute_migration_job() {
  local phase="$1"
  local execution_json
  local execution_name
  local filter
  local log_output=""
  local marker_lines=""
  local marker_count="0"
  local attempt
  local encoded

  if ! execution_json="$(gcloud run jobs execute "$MIGRATION_JOB" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --wait \
    --format=json)"; then
    shipmastr_governance_fail "PRODUCTION_MIGRATION_JOB_EXECUTION_FAILED"
    return 1
  fi
  if ! execution_name="$(execution_name_from_json "$execution_json")"; then
    shipmastr_governance_fail "PRODUCTION_MIGRATION_EXECUTION_IDENTITY_INVALID"
    return 1
  fi

  if [[ "$phase" == "deploy" ]]; then
    printf '%s\n' "$execution_name"
    return 0
  fi

  filter="resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${MIGRATION_JOB}\" AND labels.\"run.googleapis.com/execution_name\"=\"${execution_name}\" AND textPayload:\"SHIPMASTR_PROD_MIGRATION_RESULT=\""
  for attempt in {1..12}; do
    log_output="$(gcloud logging read "$filter" \
      --project "$PROJECT_ID" \
      --order=asc \
      --limit=10 \
      --format='value(textPayload)')"
    marker_lines="$(printf '%s\n' "$log_output" | awk '/^SHIPMASTR_PROD_MIGRATION_RESULT=/{print}')"
    marker_count="$(printf '%s\n' "$marker_lines" | awk 'NF { count += 1 } END { print count + 0 }')"
    if [[ "$marker_count" == "1" ]]; then
      break
    fi
    sleep 5
  done

  if [[ "$marker_count" != "1" ]]; then
    shipmastr_governance_fail "PRODUCTION_MIGRATION_RESULT_LOG_INVALID"
    return 1
  fi

  encoded="${marker_lines#SHIPMASTR_PROD_MIGRATION_RESULT=}"
  if ! base64_decode "$encoded"; then
    shipmastr_governance_fail "PRODUCTION_MIGRATION_RESULT_ENCODING_INVALID"
    return 1
  fi
}

shipmastr_production_migration_guard
readonly PROJECT_ID REGION SERVICE SERVICE_ACCOUNT CLOUD_SQL_INSTANCE

PRODUCTION_SERVICE_BEFORE_JSON="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format=json)"
PRODUCTION_SERVICE_BEFORE_SAFE="$(
  printf '%s' "$PRODUCTION_SERVICE_BEFORE_JSON" |
    shipmastr_governance_production_service_snapshot
)"
IFS=$'\t' read -r PRODUCTION_REVISION_BEFORE PRODUCTION_SNAPSHOT_BEFORE \
  <<< "$PRODUCTION_SERVICE_BEFORE_SAFE"
readonly PRODUCTION_REVISION_BEFORE PRODUCTION_SNAPSHOT_BEFORE
unset PRODUCTION_SERVICE_BEFORE_JSON PRODUCTION_SERVICE_BEFORE_SAFE

echo "Creating governed on-demand Cloud SQL backup"
gcloud sql backups create \
  --instance "$CLOUD_SQL_INSTANCE_ID" \
  --project "$PROJECT_ID" \
  --description "$BACKUP_DESCRIPTION" \
  --quiet \
  --format=json >/dev/null

BACKUP_LIST_JSON="$(gcloud sql backups list \
  --instance "$CLOUD_SQL_INSTANCE_ID" \
  --project "$PROJECT_ID" \
  --filter "description=${BACKUP_DESCRIPTION}" \
  --format=json)"
BACKUP_ID="$(
  printf '%s' "$BACKUP_LIST_JSON" |
    shipmastr_governance_backup_id_for_invocation \
      "$CLOUD_SQL_INSTANCE_ID" \
      "$BACKUP_DESCRIPTION"
)"
unset BACKUP_LIST_JSON

BACKUP_JSON="$(gcloud sql backups describe "$BACKUP_ID" \
  --instance "$CLOUD_SQL_INSTANCE_ID" \
  --project "$PROJECT_ID" \
  --format=json)"
BACKUP_VERIFIED_UTC=""
if ! BACKUP_VERIFIED_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
  shipmastr_governance_fail "PRODUCTION_MIGRATION_BACKUP_VERIFICATION_TIMESTAMP_INVALID"
  exit 1
fi
BACKUP_SAFE="$(
  printf '%s' "$BACKUP_JSON" |
    shipmastr_governance_verify_backup_run \
      "$CLOUD_SQL_INSTANCE_ID" \
      "$BACKUP_DESCRIPTION" \
      "$INVOCATION_UTC" \
      "$BACKUP_VERIFIED_UTC"
)"
IFS=$'\t' read -r VERIFIED_BACKUP_ID BACKUP_START_UTC BACKUP_END_UTC \
  <<< "$BACKUP_SAFE"
if [[ "$VERIFIED_BACKUP_ID" != "$BACKUP_ID" ]]; then
  shipmastr_governance_fail "PRODUCTION_MIGRATION_BACKUP_ID_MISMATCH"
  exit 1
fi
readonly BACKUP_ID BACKUP_START_UTC BACKUP_END_UTC
unset BACKUP_JSON BACKUP_SAFE VERIFIED_BACKUP_ID

BACKUP_EVIDENCE_SHA256="$(
  shipmastr_governance_write_production_backup_evidence \
    "$SHIPMASTR_PRODUCTION_BACKUP_EVIDENCE_OUTPUT" \
    "$SHIPMASTR_APPROVED_COMMIT_SHA" \
    "$IMAGE_DIGEST" \
    "$CLOUD_SQL_INSTANCE" \
    "$BACKUP_ID" \
    "$BACKUP_DESCRIPTION" \
    "$INVOCATION_UTC" \
    "$BACKUP_START_UTC" \
    "$BACKUP_END_UTC"
)"
shipmastr_governance_verify_production_backup_evidence \
  "$SHIPMASTR_PRODUCTION_BACKUP_EVIDENCE_OUTPUT" \
  "$BACKUP_EVIDENCE_SHA256" \
  "$SHIPMASTR_APPROVED_COMMIT_SHA" \
  "$IMAGE_DIGEST" \
  "$CLOUD_SQL_INSTANCE" \
  "$BACKUP_ID" \
  "$BACKUP_DESCRIPTION" \
  "$INVOCATION_UTC"

echo "Backup verified; running exact pending-migration gate"
configure_migration_job precheck
PRECHECK_JSON="$(execute_migration_job precheck)"
DATABASE_NAME="$(
  printf '%s' "$PRECHECK_JSON" |
    shipmastr_governance_verify_production_migration_result precheck
)"
shipmastr_governance_validate_production_database_name "$DATABASE_NAME"
readonly DATABASE_NAME
unset PRECHECK_JSON

echo "Exact pending migration set verified; applying approved migrations"
configure_migration_job deploy
MIGRATION_EXECUTION_NAME="$(execute_migration_job deploy)"
readonly MIGRATION_EXECUTION_NAME

echo "Migration execution passed; verifying final migration and schema state"
configure_migration_job postcheck
POSTCHECK_JSON="$(execute_migration_job postcheck)"
POSTCHECK_DATABASE_NAME="$(
  printf '%s' "$POSTCHECK_JSON" |
    shipmastr_governance_verify_production_migration_result postcheck
)"
if [[ "$POSTCHECK_DATABASE_NAME" != "$DATABASE_NAME" ]]; then
  shipmastr_governance_fail "PRODUCTION_MIGRATION_DATABASE_CHANGED"
  exit 1
fi
unset POSTCHECK_JSON POSTCHECK_DATABASE_NAME

PRODUCTION_SERVICE_AFTER_JSON="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format=json)"
PRODUCTION_SERVICE_AFTER_SAFE="$(
  printf '%s' "$PRODUCTION_SERVICE_AFTER_JSON" |
    shipmastr_governance_production_service_snapshot
)"
IFS=$'\t' read -r PRODUCTION_REVISION_AFTER PRODUCTION_SNAPSHOT_AFTER \
  <<< "$PRODUCTION_SERVICE_AFTER_SAFE"
if [[ "$PRODUCTION_REVISION_AFTER" != "$PRODUCTION_REVISION_BEFORE" || \
  "$PRODUCTION_SNAPSHOT_AFTER" != "$PRODUCTION_SNAPSHOT_BEFORE" ]]; then
  shipmastr_governance_fail "PRODUCTION_SERVICE_OR_TRAFFIC_CHANGED_DURING_MIGRATION"
  exit 1
fi
unset PRODUCTION_SERVICE_AFTER_JSON PRODUCTION_SERVICE_AFTER_SAFE PRODUCTION_SNAPSHOT_AFTER

MIGRATION_EVIDENCE_SHA256="$(
  shipmastr_governance_write_production_migration_evidence \
    "$SHIPMASTR_PRODUCTION_MIGRATION_EVIDENCE_OUTPUT" \
    "$SHIPMASTR_APPROVED_COMMIT_SHA" \
    "$IMAGE_DIGEST" \
    "$DATABASE_NAME" \
    "$CLOUD_SQL_INSTANCE" \
    "$BACKUP_ID" \
    "$PRODUCTION_REVISION_BEFORE" \
    "$PRODUCTION_REVISION_AFTER"
)"
shipmastr_governance_verify_production_migration_evidence \
  "$SHIPMASTR_PRODUCTION_MIGRATION_EVIDENCE_OUTPUT" \
  "$MIGRATION_EVIDENCE_SHA256" \
  "$SHIPMASTR_APPROVED_COMMIT_SHA" \
  "$IMAGE_DIGEST"

echo "Production database migration and verification completed"
echo "Backup evidence path: ${SHIPMASTR_PRODUCTION_BACKUP_EVIDENCE_OUTPUT}"
echo "Backup evidence SHA-256: ${BACKUP_EVIDENCE_SHA256}"
echo "Migration evidence path: ${SHIPMASTR_PRODUCTION_MIGRATION_EVIDENCE_OUTPUT}"
echo "Migration evidence SHA-256: ${MIGRATION_EVIDENCE_SHA256}"
echo "Production service revision unchanged: ${PRODUCTION_REVISION_AFTER}"
