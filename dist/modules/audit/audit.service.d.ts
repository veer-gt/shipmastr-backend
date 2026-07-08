import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
type Db = Prisma.TransactionClient | typeof prisma;
export declare function audit(input: {
    merchantId?: string;
    actorId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: unknown;
}, client?: Db): Promise<{
    id: string;
    merchantId: string | null;
    createdAt: Date;
    actorId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata: Prisma.JsonValue | null;
}>;
export declare function listSellerAuditLogs(merchantId: string, input?: {
    limit?: number | undefined;
}, client?: Db): Promise<{
    events: {
        _id: string;
        id: string;
        createdAt: Date;
        action: string;
        resourceType: string;
        resourceId: string | null;
        status: string;
        metadata: unknown;
    }[];
    data: {
        _id: string;
        id: string;
        createdAt: Date;
        action: string;
        resourceType: string;
        resourceId: string | null;
        status: string;
        metadata: unknown;
    }[];
    count: number;
}>;
export declare function getSellerAuditSummary(merchantId: string, client?: Db): Promise<{
    total: number;
    critical: number;
    warning: number;
    info: number;
    failed: number;
    queued: number;
    actions: string[];
}>;
export {};
//# sourceMappingURL=audit.service.d.ts.map