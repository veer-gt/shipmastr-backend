#!/usr/bin/env node
import { buildProductionReadinessSmokeReport } from "./production-readiness-smoke.mjs";

const report = buildProductionReadinessSmokeReport();
const flow = {
  verdict: report.verdict,
  checked_at: report.checked_at,
  controlled_pilot_flow: [
    "connect_store",
    "credentials_ready",
    "read_only_import",
    "reconciliation_review",
    "manual_conversion",
    "shipment_candidate",
    "manual_ship_now_gate",
    "tracking_sync_gate"
  ],
  blocked_without_approval: {
    live_rates: report.live_flags.courier_rates !== "LIVE" || report.allowlist_configured,
    live_awb_label: report.live_flags.awb_label !== "LIVE" || report.allowlist_configured,
    tracking_sync: report.live_flags.tracking_sync !== "LIVE" || report.allowlist_configured
  },
  hard_stops: report.hard_stops
};

process.stdout.write(`${JSON.stringify(flow, null, 2)}\n`);
if (flow.hard_stops.length) process.exit(1);
