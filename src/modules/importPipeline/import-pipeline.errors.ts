export class ImportPipelineError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message = code, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ImportPipelineError";
    this.code = code;
    this.details = details;
  }
}

export class ImportPipelineRowError extends ImportPipelineError {
  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code, code, details);
    this.name = "ImportPipelineRowError";
  }
}
