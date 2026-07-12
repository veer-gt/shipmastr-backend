import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/httpError.js";

const MAX_TARGET_LENGTH = 8_192;
const MAX_QUERY_KEYS = 64;
const MAX_QUERY_KEY_LENGTH = 80;
const MAX_QUERY_VALUE_LENGTH = 1_024;
const MAX_PATH_SEGMENT_LENGTH = 256;

function reject(code: string): never {
  throw new HttpError(400, code);
}

export function validateRequestTarget(req: Request, _res: Response, next: NextFunction) {
  const target = String(req.originalUrl || req.url || "");
  if (!target || target.length > MAX_TARGET_LENGTH) reject("REQUEST_TARGET_TOO_LARGE");

  const queryIndex = target.indexOf("?");
  const rawPath = queryIndex >= 0 ? target.slice(0, queryIndex) : target;
  for (const rawSegment of rawPath.split("/")) {
    if (!rawSegment) continue;
    if (rawSegment.length > MAX_PATH_SEGMENT_LENGTH) reject("ROUTE_PARAMETER_TOO_LONG");
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      reject("ROUTE_PARAMETER_ENCODING_INVALID");
    }
    if (!segment || segment === "." || segment === ".." || segment.includes("\\") || /[\u0000-\u001f\u007f]/.test(segment)) {
      reject("ROUTE_PARAMETER_INVALID");
    }
  }

  if (queryIndex >= 0) {
    const rawQuery = target.slice(queryIndex + 1);
    const params = new URLSearchParams(rawQuery);
    let keyCount = 0;
    for (const [key, value] of params.entries()) {
      keyCount += 1;
      if (keyCount > MAX_QUERY_KEYS || key.length > MAX_QUERY_KEY_LENGTH || value.length > MAX_QUERY_VALUE_LENGTH) {
        reject("QUERY_PARAMETER_INVALID");
      }
      if (/[\u0000-\u001f\u007f]/.test(key) || /[\u0000-\u001f\u007f]/.test(value)) {
        reject("QUERY_PARAMETER_INVALID");
      }
    }
  }

  next();
}
