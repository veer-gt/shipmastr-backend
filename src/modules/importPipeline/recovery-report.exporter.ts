import type { RecoveryReport } from "./recovery-report.types.js";

export class RecoveryReportExporter {
  toJson(report: RecoveryReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
}

export const recoveryReportExporter = new RecoveryReportExporter();
