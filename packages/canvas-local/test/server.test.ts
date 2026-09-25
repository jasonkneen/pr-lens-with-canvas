import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanvasServer } from "../src/server.js";
import { mintToken } from "../src/store.js";

const example = JSON.parse(
  await readFile(new URL("../../schema/examples/minimal.graph.json", import.meta.url), "utf8"),
) as { nodes: { id: string }[] };

let server: Server;
let api: string;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canvas-local-"));
  server = await createCanvasServer({ dir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string, init: { token?: string; ifMatch?: number; body?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  if (init.ifMatch !== undefined) headers["if-match"] = String(init.ifMatch);
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${api}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
};

describe("the canvas API", () => {
  it("runs the whole lifecycle the doc walks through", async () => {
    const minted = await call("POST", "/api/canvas");
    expect(minted.status).toBe(201);
    expect(minted.json.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(minted.json.editUrl).toBe(`${minted.json.viewUrl}#w=${minted.json.writeToken}`);
    const { id, writeToken } = minted.json as { id: string; writeToken: string };

    expect((await call("GET", `/api/canvas/${id}`)).json.error.code).toBe("NOT_FOUND");

    const pushed = await call("PUT", `/api/canvas/${id}`, { token: writeToken, ifMatch: 0, body: example });
    expect(pushed.status).toBe(200);
    expect(pushed.json.rev).toBe(1);
    expect(pushed.json.tiles.length).toBeGreaterThan(0);
    expect(pushed.json.tiles[0].hero).toBe(true);
    expect(pushed.json.tiles[0].svg).toBeUndefined();

    const stale = await call("PUT", `/api/canvas/${id}`, { token: writeToken, ifMatch: 0, body: example });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatchObject({ code: "REVISION_MOVED", rev: 1 });

    const wrong = await call("PUT", `/api/canvas/${id}`, { token: mintToken(), ifMatch: 1, body: example });
    expect(wrong.json.error.code).toBe("NOT_FOUND");

    const bad = await call("PUT", `/api/canvas/${id}`, { token: writeToken, ifMatch: 1, body: { kind: "graph" } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("INVALID_DOCUMENT");

    const fetched = await call("GET", `/api/canvas/${id}`);
    expect(fetched.json).toMatchObject({ id, rev: 1, document: example });

    const next = mintToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rotated = await call("POST", `/api/canvas/${id}/rotate`, { token: writeToken, body: { writeToken: next } });
      expect(rotated.status).toBe(200);
      expect(rotated.json.editUrl).toContain(`#w=${next}`);
    }
    expect((await call("DELETE", `/api/canvas/${id}`, { token: writeToken })).json.error.code).toBe("NOT_FOUND");
    expect((await call("DELETE", `/api/canvas/${id}`, { token: next })).json).toEqual({ id, deleted: true });
    expect((await call("GET", `/api/canvas/${id}`)).status).toBe(404);
  });

  it("relays live commands to the paired tab and its look back", async () => {
    const { id, writeToken } = (await call("POST", "/api/canvas")).json as { id: string; writeToken: string };
    await call("PUT", `/api/canvas/${id}`, { token: writeToken, ifMatch: 0, body: example });

    const opened = await call("POST", `/api/canvas/${id}/live`, { token: writeToken });
    expect(opened.status).toBe(200);
    const { session, url } = opened.json as { session: string; url: string };
    const secret = /#live=[^.]+\.(.+)$/.exec(url)?.[1] ?? "";

    expect((await call("GET", `/api/canvas/${id}/live/${session}/look`, { token: writeToken })).json).toEqual({ status: "not_open" });

    const node = example.nodes[0]!.id;
    const sent = await call("POST", `/api/canvas/${id}/live/${session}`, {
      token: writeToken,
      body: { kind: "show", focus: { kind: "selection", nodes: [node] } },
    });
    expect(sent.json).toEqual({ seq: 1, tab: "not_open" });

    const unknown = await call("POST", `/api/canvas/${id}/live/${session}`, {
      token: writeToken,
      body: { kind: "show", focus: { kind: "selection", nodes: ["nope"] } },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.json.error.code).toBe("UNKNOWN_PLACE");
    expect(unknown.json.error.valid.components).toContain(node);

    // The write token is not the tab's secret.
    expect((await call("GET", `/api/canvas/${id}/live/${session}?after=0`, { token: writeToken })).status).toBe(404);
    const events = await call("GET", `/api/canvas/${id}/live/${session}?after=0`, { token: secret });
    expect(events.json.events).toHaveLength(1);
    expect(events.json.events[0].event.command.kind).toBe("show");

    const look = { following: true, rev: 1, diagram: null, inFrame: [], scope: null, answer: null, fork: null };
    expect((await call("POST", `/api/canvas/${id}/live/${session}/look`, { token: secret, body: look })).status).toBe(200);
    const read = await call("GET", `/api/canvas/${id}/live/${session}/look`, { token: writeToken });
    expect(read.json).toMatchObject({ status: "seen", look });

    await call("PUT", `/api/canvas/${id}`, { token: writeToken, ifMatch: 1, body: example });
    const after = await call("GET", `/api/canvas/${id}/live/${session}?after=1`, { token: secret });
    expect(after.json.events[0].event).toEqual({ kind: "revised", rev: 2 });

    const page = await call("GET", `/api/canvas/${id}/page`);
    expect(page.json.tiles[0].svg.light).toContain("<svg");
    expect(page.json.tiles[0].atlas.nodes[node]).toBeDefined();
  });
});
