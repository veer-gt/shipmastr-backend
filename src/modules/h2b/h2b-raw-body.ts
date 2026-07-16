import type { IncomingMessage } from "node:http";
import { HttpError } from "../../lib/httpError.js";

export async function readH2BRawBody(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && /^\d+$/.test(declared.trim()) && Number(declared) > limitBytes) {
    throw new HttpError(413, "H2B_PAYLOAD_TOO_LARGE");
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      request.removeAllListeners("data");
      request.resume?.();
      if (error instanceof HttpError && error.status === 413) {
        try { request.socket?.setTimeout(5_000); } catch { /* safe transport cleanup */ }
      }
      reject(error);
    };
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limitBytes) {
        fail(new HttpError(413, "H2B_PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    request.on("error", () => fail(new HttpError(400, "H2B_REQUEST_STREAM_FAILED")));
    request.on("aborted", () => fail(new HttpError(400, "H2B_REQUEST_ABORTED")));
  });
}
