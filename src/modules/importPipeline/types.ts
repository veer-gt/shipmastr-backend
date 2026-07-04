export type FormatPackDefinition = Record<string, unknown>;

export type FormatPackValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type FormatPackValidationResult = {
  ok: true;
  canonicalJson: string;
  definitionHash: string;
};

export type FormatPackCreateInput = {
  packKey: string;
  source: string;
  courierCode?: string | null | undefined;
  description?: string | null | undefined;
};

export type FormatPackDraftVersionInput = {
  packKey: string;
  version: string;
  definition: FormatPackDefinition;
  minEngineVersion: string;
  createdBy: string;
};

export type FormatPackVersionLookupInput = {
  packKey: string;
  version: string;
};

export type FormatPackRecord = {
  id: string;
  packKey: string;
  courierCode?: string | null;
  source: string;
  description?: string | null;
  createdAt?: Date;
};

export type FormatPackVersionRecord = {
  id: string;
  packId: string;
  version: string;
  definition: unknown;
  definitionHash: string;
  minEngineVersion: string;
  status: string;
  createdBy: string;
  createdAt?: Date;
  pack?: FormatPackRecord;
};

export type FormatPackClient = {
  formatPack: {
    create(input: { data: Record<string, unknown> }): Promise<FormatPackRecord>;
    findUnique(input: { where: { packKey: string } }): Promise<FormatPackRecord | null>;
  };
  formatPackVersion: {
    create(input: { data: Record<string, unknown>; include?: Record<string, unknown> }): Promise<FormatPackVersionRecord>;
    findFirst(input: {
      where: Record<string, unknown>;
      include?: Record<string, unknown>;
      orderBy?: Array<Record<string, string>> | Record<string, string>;
    }): Promise<FormatPackVersionRecord | null>;
    findMany(input: {
      where: Record<string, unknown>;
      include?: Record<string, unknown>;
      orderBy?: Array<Record<string, string>> | Record<string, string>;
    }): Promise<FormatPackVersionRecord[]>;
  };
};
