import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface FixtureContentProvider {
  readText(storagePath: string): Promise<string>;
}

export class InMemoryFixtureContentProvider implements FixtureContentProvider {
  private readonly files: ReadonlyMap<string, string>;

  constructor(files: ReadonlyMap<string, string> | Record<string, string>) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
  }

  async readText(storagePath: string) {
    const text = this.files.get(storagePath);
    if (text === undefined) throw new Error("FIXTURE_CONTENT_NOT_FOUND");
    return text;
  }
}

export class LocalFileFixtureContentProvider implements FixtureContentProvider {
  constructor(private readonly rootDir: string = process.cwd()) {}

  async readText(storagePath: string) {
    const targetPath = resolve(this.rootDir, storagePath);
    return readFile(targetPath, "utf8");
  }
}
