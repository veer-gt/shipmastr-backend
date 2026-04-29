import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { HttpError } from "../lib/httpError.js";
export const requireAuth = (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        throw new HttpError(401, "UNAUTHORIZED");
    }
    try {
        req.auth = jwt.verify(header.slice(7), env.JWT_SECRET);
        next();
    }
    catch {
        throw new HttpError(401, "INVALID_TOKEN");
    }
};
//# sourceMappingURL=auth.js.map