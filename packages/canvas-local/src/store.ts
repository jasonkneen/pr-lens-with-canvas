import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

/** 128 random bits as base64url: 22 characters, no padding. */
export const TOKEN = /^[A-Za-z0-9_-]{22}$/;

export const mintToken = (): string => randomBytes(16).toString("base64url");

/** Only a hash is kept, so a copy of the store is not a copy of every token. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const tokenMatches = (token: string | undefined, hash: string): boolean => {
  if (token === undefined) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export type Canvas = {
  id: string;
  tokenHash: string;
  rev: number;
  /** Absent until the first push. */
  document?: unknown;
  createdAt: string;
  lastWriteAt?: string;
};

/**
 * One JSON file per canvas. Writes go to a temporary file first and are
 * renamed over the old one, so a crash mid-write leaves the last good copy.
 */
export const openStore = async (dir: string) => {
  await mkdir(dir, { recursive: true });
  const path = (id: string) => join(dir, `${id}.json`);

  const read = async (id: string): Promise<Canvas | undefined> => {
    if (!TOKEN.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(path(id), "utf8")) as Canvas;
    } catch {
      return undefined;
    }
  };

  const write = async (canvas: Canvas): Promise<void> => {
    const temporary = `${path(canvas.id)}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(canvas));
    await rename(temporary, path(canvas.id));
  };

  const remove = async (id: string): Promise<void> => {
    await rm(path(id), { force: true });
  };

  return { read, write, remove };
};

export type Store = Awaited<ReturnType<typeof openStore>>;
