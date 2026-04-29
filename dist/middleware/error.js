import { ZodError } from "zod";
import { HttpError } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";
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
    logger.error({ err }, "Unhandled error");
    return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
//# sourceMappingURL=error.js.map