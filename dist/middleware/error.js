import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { HttpError } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
function isPayloadTooLargeError(err) {
    if (!err || typeof err !== "object")
        return false;
    const candidate = err;
    return candidate.type === "entity.too.large" || candidate.status === 413 || candidate.statusCode === 413;
}
export const errorHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
        return res.status(400).json({
            error: "VALIDATION_ERROR",
            details: err.flatten()
        });
    }
    if (err instanceof HttpError) {
        return res.status(err.status).json({
            error: err.message,
            details: err.details
        });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === "P2025") {
            return res.status(404).json({ error: "NOT_FOUND" });
        }
        if (err.code === "P2002") {
            return res.status(409).json({
                error: "UNIQUE_CONSTRAINT_VIOLATION",
                details: err.meta
            });
        }
    }
    if (isPayloadTooLargeError(err)) {
        return res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
    }
    logger.error({ err }, "Unhandled error");
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
//# sourceMappingURL=error.js.map