import type { ShipmastrWorkerName } from "./worker.types.js";

export const SHIPMASTR_WORKERS: Array<{
  name: ShipmastrWorkerName;
  label: string;
  description: string;
}> = [
  {
    name: "import-jobs",
    label: "Import jobs",
    description: "Runs queued platform import jobs through the existing safe import foundation."
  },
  {
    name: "webhook-staging",
    label: "Webhook staging",
    description: "Stages verified platform webhook order events into safe import jobs."
  },
  {
    name: "notifications",
    label: "Notifications",
    description: "Creates in-app merchant import digests only."
  },
  {
    name: "retries",
    label: "Retries",
    description: "Surfaces retry-ready import items without auto-running retries."
  }
];

export function isShipmastrWorkerName(value: string): value is ShipmastrWorkerName {
  return SHIPMASTR_WORKERS.some((worker) => worker.name === value);
}
