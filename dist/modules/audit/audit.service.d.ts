export declare function audit(input: {
    merchantId?: string;
    actorId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: unknown;
}): Promise<{
    id: string;
    merchantId: string | null;
    createdAt: Date;
    action: string;
    entityType: string;
    actorId: string | null;
    entityId: string | null;
    metadata: import("@prisma/client/runtime/library").JsonValue | null;
}>;
//# sourceMappingURL=audit.service.d.ts.map