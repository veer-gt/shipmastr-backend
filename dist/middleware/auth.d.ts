import type { RequestHandler } from "express";
export type AuthUser = {
    userId: string;
    merchantId: string;
    role: string;
};
declare global {
    namespace Express {
        interface Request {
            auth?: AuthUser;
        }
    }
}
export declare const requireAuth: RequestHandler;
//# sourceMappingURL=auth.d.ts.map