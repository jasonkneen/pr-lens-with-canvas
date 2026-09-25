# @coldtea/pr-lens-canvas-local

The PR Lens canvas on your own machine. One process holds your canvases in a folder and serves the page that shows them, so `pr-lens canvas` works without prlens.dev.

It speaks the protocol in [docs/canvas-api.md](../../docs/canvas-api.md). Nothing in the CLI changes: point it at this server and push, pull, rotate, delete and live mode all work as they do against the hosted app.

## Run it

```bash
pnpm install
pnpm --filter @coldtea/pr-lens-canvas-local build
node packages/canvas-local/dist/bin.js
```

It listens on `http://localhost:4780` and keeps canvases in `~/.pr-lens/local-canvas`. Change either with `--port` and `--dir`.

Then, from the repository you want to draw:

```bash
export PR_LENS_API_URL=http://localhost:4780
pr-lens canvas push .pr-lens/<drawing>/drawn.graph.json
pr-lens canvas open .pr-lens/<drawing>/drawn.graph.json
```

To give the canvas a window of its own, open the link in Chrome's app mode:

```bash
pr-lens canvas open <drawing> --no-browser
open -na "Google Chrome" --args --app="<the link it printed>"
```

## What the page does

- Every view of the document as its own picture, stacked in one column. Drag to pan, pinch or ctrl-scroll to zoom, `F` to fit, `+` and `-` to zoom.
- `T` cycles the theme: the system's, light, dark.
- `W` plays the walkthrough. Each step dims everything else and lights what the step is about. Arrow keys step through it, `Esc` leaves. A link ending `#s=3` opens on step 3.
- Click an arrow in a data flow and its payload opens beside the diagram: request and response, as a shape or a sample. Keys the change added are green, dropped ones red, changed values amber.
- Click a card to select it. Shift-drag to select a region.
- In live mode the tab follows your coding agent. `pr-lens canvas answer` shows the answer as steps with links, `show` moves the camera, `fork` hangs a drawing under the canvas, and `look` reads back what you are looking at and what you selected. Pan or zoom and you step out of following; a button in the bar brings you back, and anything the agent sent while you were away plays then.

## What it leaves out

- Accounts. `canvas list --remote` and `canvas claim` report the store as unavailable. Everything else works signed out, as the protocol allows.
- Live sessions are held in memory, so restarting the server ends them. Canvases are files and survive.
- No rate limits. It listens on 127.0.0.1 only.

## Develop

```bash
pnpm --filter @coldtea/pr-lens-canvas-local test       # the API, end to end
pnpm --filter @coldtea/pr-lens-canvas-local typecheck
```

The server is `src/`: `server.ts` for the routes, `store.ts` for the files, `draw.ts` for the pictures, `places.ts` for checking the ids a live command names. The page is `web/`, React and Vite. `vite dev web` serves it with hot reload and sends `/api` to a server on 4780.
