#!/usr/bin/env node
import { inspectPostgresContainer, pgIsReady } from "./db-local.mjs";

const container = inspectPostgresContainer();
const readiness = pgIsReady();
console.log(`Apple Container: ${container.state}`);
console.log(`Image: ${container.image}`);
console.log(`Persistent volume: ${container.volume}`);
console.log("Port: 127.0.0.1:5433 -> container:5432/tcp");
console.log(`pg_isready: ${readiness.ready ? readiness.output : `NOT READY (${readiness.output})`}`);
if (container.state !== "running" || !readiness.ready) process.exitCode = 1;
