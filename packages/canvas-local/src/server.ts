import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { LiveCommand, safeParseGraphDoc, ViewerLook, type GraphDoc } from "@coldtea/pr-lens-schema";
import { apiTile, drawSketch, drawTiles, type DrawnTile } from "./draw.js";
import { unknownPlaces, validOf, placesOf } from "./places.js";
import { hashToken, mintToken, openStore, TOKEN, tokenMatches, type Canvas } from "./store.js";

const MAX_BODY = 4_000_000;
const SESSION_MS = 2 * 60 * 60 * 1000;
const MAX_EVENTS = 200;

export type LiveEvent =
  | { kind: "command"; command: LiveCommand; sketch?: ReturnType<typeof drawSketch> }
  | { kind: "revised"; rev: number };

type Session = {
  canvas: string;
  secretHash: string;
  expiresAt: number;
  events: { seq: number; event: LiveEvent }[];
  seq: number;
  look?: { seenAt: string; look: ViewerLook };
};

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const notFound = () => new Refusal(404, "NOT_FOUND", "No canvas with that id, or the token is wrong");
const liveEnded = () => new Refusal(404, "LIVE_ENDED", "That live session has ended; pr-lens canvas open starts another");
const invalid = (message: string) => new Refusal(400, "INVALID_REQUEST", message);

const MEDIA: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};

export type ServerOptions = {
  /** Where canvases are kept, one JSON file each. */
  dir: string;
  /** The built page. Absent serves the API alone. */
  web?: string;
};

export const createCanvasServer = async ({ dir, web }: ServerOptions): Promise<Server> => {
  const store = await openStore(dir);
  const sessions = new Map<string, Session>();
  const drawings = new Map<string, DrawnTile[]>();

  const origin = (request: IncomingMessage) => `http://${request.headers.host ?? "localhost"}`;
  const urls = (request: IncomingMessage, canvas: Canvas, token?: string) => {
    const view = `${origin(request)}/c/${canvas.id}`;
    return {
      viewUrl: view,
      embedUrl: `${view}.svg`,
      ...(token === undefined ? {} : { editUrl: `${view}#w=${token}` }),
    };
  };

  const bearer = (request: IncomingMessage): string | undefined => {
    const header = request.headers.authorization;
    return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
  };

  const body = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Refusal(413, "TOO_LARGE", "That body is above the 4,000,000 byte limit");
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw invalid("The body is not JSON");
    }
  };

  /** A canvas the bearer may write. Wrong token and no canvas answer the same. */
  const writable = async (request: IncomingMessage, id: string): Promise<Canvas> => {
    const canvas = await store.read(id);
    if (canvas === undefined || !tokenMatches(bearer(request), canvas.tokenHash)) throw notFound();
    return canvas;
  };

  const documentOf = (canvas: Canvas): GraphDoc => {
    const parsed = safeParseGraphDoc(canvas.document);
    if (!parsed.ok) throw notFound();
    return parsed.value;
  };

  const tilesOf = (request: IncomingMessage, canvas: Canvas): DrawnTile[] => {
    const key = `${canvas.id}:${canvas.rev}`;
    const cached = drawings.get(key);
    if (cached !== undefined) return cached;
    const tiles = drawTiles(documentOf(canvas), `${origin(request)}/images/${canvas.id}/${canvas.rev}`);
    for (const stale of drawings.keys()) if (stale.startsWith(`${canvas.id}:`)) drawings.delete(stale);
    drawings.set(key, tiles);
    return tiles;
  };

  const session = (canvas: string, id: string): Session => {
    const found = sessions.get(id);
    if (found === undefined || found.canvas !== canvas) throw liveEnded();
    if (found.expiresAt < Date.now()) {
      sessions.delete(id);
      throw liveEnded();
    }
    return found;
  };

  const append = (live: Session, event: LiveEvent): number => {
    live.seq += 1;
    live.events.push({ seq: live.seq, event });
    if (live.events.length > MAX_EVENTS) live.events.splice(0, live.events.length - MAX_EVENTS);
    return live.seq;
  };

  const tabState = (live: Session) =>
    live.look === undefined ? "not_open" : live.look.look.following ? "following" : "stepped_out";

  const routes = async (request: IncomingMessage, url: URL): Promise<{ status: number; json: unknown } | undefined> => {
    const method = request.method ?? "GET";
    const parts = url.pathname.split("/").filter((part) => part !== "");

    if (parts[0] === "api" && parts[1] === "canvases") throw new Refusal(404, "NOT_FOUND", "This store has no accounts");
    if (parts[0] !== "api" || parts[1] !== "canvas") return undefined;

    const [, , id, action, liveId, sub] = parts;

    // Mint
    if (id === undefined) {
      if (method !== "POST") return undefined;
      const token = mintToken();
      const canvas: Canvas = { id: mintToken(), tokenHash: hashToken(token), rev: 0, createdAt: new Date().toISOString() };
      await store.write(canvas);
      return { status: 201, json: { id: canvas.id, writeToken: token, rev: 0, ...urls(request, canvas, token) } };
    }

    if (action === undefined) {
      if (method === "GET") {
        const canvas = await store.read(id);
        if (canvas === undefined || canvas.rev === 0) throw notFound();
        return {
          status: 200,
          json: { id, rev: canvas.rev, ...urls(request, canvas), document: canvas.document, tiles: tilesOf(request, canvas).map(apiTile) },
        };
      }

      if (method === "PUT") {
        const ifMatch = Number.parseInt(String(request.headers["if-match"] ?? "").replace(/"/g, ""), 10);
        if (!Number.isInteger(ifMatch)) throw invalid("If-Match needs the revision you last saw");
        const document = await body(request);
        const canvas = await writable(request, id);
        if (ifMatch !== canvas.rev)
          throw new Refusal(409, "REVISION_MOVED", "The canvas has moved on since you pulled it; pull again, then push", { rev: canvas.rev });
        const parsed = safeParseGraphDoc(document);
        if (!parsed.ok)
          throw new Refusal(422, "INVALID_DOCUMENT", "That is not a graph document", {
            issues: "issues" in parsed.error && Array.isArray(parsed.error.issues) ? parsed.error.issues : [{ code: parsed.error.code, path: "", message: parsed.error.message }],
          });
        const next: Canvas = { ...canvas, rev: canvas.rev + 1, document, lastWriteAt: new Date().toISOString() };
        let tiles: DrawnTile[];
        try {
          tiles = drawTiles(parsed.value, `${origin(request)}/images/${id}/${next.rev}`);
        } catch (error) {
          throw new Refusal(422, "CANNOT_DRAW", error instanceof Error ? error.message : "This document does not draw");
        }
        await store.write(next);
        drawings.set(`${id}:${next.rev}`, tiles);
        for (const live of sessions.values()) if (live.canvas === id) append(live, { kind: "revised", rev: next.rev });
        return { status: 200, json: { id, rev: next.rev, ...urls(request, next, bearer(request)), tiles: tiles.map(apiTile) } };
      }

      if (method === "DELETE") {
        await writable(request, id);
        await store.remove(id);
        for (const [key, live] of sessions) if (live.canvas === id) sessions.delete(key);
        return { status: 200, json: { id, deleted: true } };
      }
      return undefined;
    }

    if (action === "rotate" && method === "POST") {
      const next = ((await body(request)) as { writeToken?: unknown } | undefined)?.writeToken;
      if (typeof next !== "string" || !TOKEN.test(next)) throw invalid("writeToken must be 22 characters of base64url");
      const canvas = await store.read(id);
      if (canvas === undefined) throw notFound();
      if (!tokenMatches(next, canvas.tokenHash)) {
        if (!tokenMatches(bearer(request), canvas.tokenHash)) throw notFound();
        await store.write({ ...canvas, tokenHash: hashToken(next) });
      }
      return { status: 200, json: { id, editUrl: `${origin(request)}/c/${id}#w=${next}` } };
    }

    if (action === "claim" || action === "write-token") throw new Refusal(404, "NOT_FOUND", "This store has no accounts");

    // The page's own read: the document and every picture in it.
    if (action === "page" && method === "GET") {
      const canvas = await store.read(id);
      if (canvas === undefined || canvas.rev === 0) throw notFound();
      return { status: 200, json: { id, rev: canvas.rev, document: canvas.document, tiles: tilesOf(request, canvas) } };
    }

    if (action !== "live") return undefined;

    if (liveId === undefined) {
      if (method !== "POST") return undefined;
      const canvas = await writable(request, id);
      if (canvas.rev === 0) throw notFound();
      const sessionId = mintToken();
      const secret = mintToken();
      const expiresAt = Date.now() + SESSION_MS;
      sessions.set(sessionId, { canvas: id, secretHash: hashToken(secret), expiresAt, events: [], seq: 0 });
      return {
        status: 200,
        json: { session: sessionId, url: `${origin(request)}/c/${id}#live=${sessionId}.${secret}`, expiresAt: new Date(expiresAt).toISOString() },
      };
    }

    const live = session(id, liveId);
    const token = bearer(request);
    const isTab = token !== undefined && tokenMatches(token, live.secretHash);

    if (sub === undefined && method === "POST") {
      const canvas = await writable(request, id);
      const parsed = LiveCommand.safeParse(await body(request));
      if (!parsed.success) throw invalid(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      const document = documentOf(canvas);
      const unknown = unknownPlaces(document, parsed.data);
      if (unknown.length > 0)
        throw new Refusal(422, "UNKNOWN_PLACE", "Some ids are not on this canvas", { unknown, valid: validOf(placesOf(document)) });

      let sketch: ReturnType<typeof drawSketch> | undefined;
      if (parsed.data.kind === "fork") {
        try {
          sketch = drawSketch(parsed.data.sketch);
        } catch (error) {
          throw new Refusal(422, "CANNOT_DRAW", error instanceof Error ? error.message : "The sketch does not draw");
        }
      }
      live.expiresAt = Date.now() + SESSION_MS;
      const seq = append(live, { kind: "command", command: parsed.data, ...(sketch === undefined ? {} : { sketch }) });
      return { status: 200, json: { seq, tab: tabState(live) } };
    }

    // The tab reads what the agent sent since it last looked.
    if (sub === undefined && method === "GET") {
      if (!isTab) throw liveEnded();
      const after = Number(url.searchParams.get("after") ?? "0");
      return { status: 200, json: { events: live.events.filter((entry) => entry.seq > after) } };
    }

    if (sub === "look" && method === "POST") {
      if (!isTab) throw liveEnded();
      const parsed = ViewerLook.safeParse(await body(request));
      if (!parsed.success) throw invalid("That is not a look");
      live.look = { seenAt: new Date().toISOString(), look: parsed.data };
      return { status: 200, json: { ok: true } };
    }

    if (sub === "look" && method === "GET") {
      await writable(request, id);
      return { status: 200, json: live.look === undefined ? { status: "not_open" } : { status: "seen", ...live.look } };
    }

    return undefined;
  };

  const serveFile = async (response: ServerResponse, root: string, path: string): Promise<boolean> => {
    const full = normalize(join(root, path));
    if (!full.startsWith(normalize(root))) return false;
    try {
      const bytes = await readFile(full);
      response.writeHead(200, { "content-type": MEDIA[extname(full)] ?? "application/octet-stream" });
      response.end(bytes);
      return true;
    } catch {
      return false;
    }
  };

  const pages = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const images = /^\/images\/([A-Za-z0-9_-]{22})\/(\d+)\/(.+)\.(light|dark)\.svg$/.exec(url.pathname);
    const embed = /^\/c\/([A-Za-z0-9_-]{22})\.svg$/.exec(url.pathname);
    if (images !== null || embed !== null) {
      const id = (images ?? embed)![1]!;
      const canvas = await store.read(id);
      if (canvas === undefined || canvas.rev === 0) return false;
      const tiles = tilesOf(request, canvas);
      const tile = images === null ? tiles[0] : tiles.find((candidate) => candidate.id === decodeURIComponent(images[3]!));
      if (tile === undefined) return false;
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      response.end(tile.svg[images === null ? "dark" : (images[4] as "light" | "dark")]);
      return true;
    }

    if (web === undefined) return false;
    if (/^\/c\/[A-Za-z0-9_-]{22}\/?$/.test(url.pathname) || url.pathname === "/") return serveFile(response, web, "index.html");
    return serveFile(response, web, url.pathname);
  };

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void (async () => {
      try {
        const answer = await routes(request, url);
        if (answer !== undefined) {
          response.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify(answer.json));
          return;
        }
        if (await pages(request, response, url)) return;
        throw new Refusal(404, "NOT_FOUND", "Nothing here");
      } catch (error) {
        const refusal =
          error instanceof Refusal ? error : new Refusal(500, "UNAVAILABLE", error instanceof Error ? error.message : "Something went wrong");
        if (!response.headersSent)
          response.writeHead(refusal.status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: refusal.code, message: refusal.message, ...refusal.extra } }));
      }
    })();
  });
};
