#!/usr/bin/env node
import { inspectPostgresContainer, pgIsReady, runContainer, waitForPostgres } from "./db-local.mjs";

const before = inspectPostgresContainer();
if (before.state !== "running") {
  runContainer(["start", "shipmastr-postgres"]);
}
const readyOutput = waitForPostgres();
const after = inspectPostgresContainer();
const readiness = pgIsReady();
if (!readiness.ready) throw new Error("PostgreSQL container is running but host readiness failed");
console.log(`Apple Container: ${after.state}`);
console.log(`Image: ${after.image}`);
console.log(`Persistent volume: ${after.volume}`);
console.log("Port: 127.0.0.1:5433 -> container:5432/tcp");
console.log(`pg_isready: ${readyOutput}`);
