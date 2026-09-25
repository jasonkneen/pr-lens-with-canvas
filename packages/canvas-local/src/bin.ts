#!/usr/bin/env node
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCanvasServer } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT ?? "4780" },
    dir: { type: "string", default: join(homedir(), ".pr-lens", "local-canvas") },
  },
});

const web = join(dirname(fileURLToPath(import.meta.url)), "web");
const server = await createCanvasServer({ dir: values.dir, web });
const port = Number(values.port);

server.on("error", (error: NodeJS.ErrnoException) => {
  process.stderr.write(
    error.code === "EADDRINUSE" ? `port ${port} is taken; pass --port <n> to use another\n` : `${error.message}\n`,
  );
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const api = `http://localhost:${port}`;
  process.stdout.write(
    [
      `PR Lens canvas on ${api}`,
      `  canvases kept in ${values.dir}`,
      "",
      "  point the CLI at it:",
      `    export PR_LENS_API_URL=${api}`,
      "    pr-lens canvas push <drawing>",
      "    pr-lens canvas open <drawing>",
      "",
    ].join("\n"),
  );
});
