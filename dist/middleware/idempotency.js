import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/httpError.js";
export const requireIdempotency = async (req, res, next) => {
    const key = req.header("Idempotency-Key");
    if (!key) {
        throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED");
    }
    const existing = await prisma.idempotencyKey.findUnique({
        where: { key }
    });
    if (existing?.response) {
        return res.status(200).json(existing.response);
    }
    await prisma.idempotencyKey.upsert({
        where: { key },
        create: { key, route: req.path },
        update: {}
    });
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        void prisma.idempotencyKey.update({
            where: { key },
            data: { response: body }
        });
        return originalJson(body);
    };
    next();
};
//# sourceMappingURL=idempotency.js.map