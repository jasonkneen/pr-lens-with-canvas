import type { GraphDoc, LivePlace, StepFocus, StepStage } from "@coldtea/pr-lens-schema"
import type { DrawnTile, Sketch } from "./api"

export type Box = { x: number; y: number; width: number; height: number }
export type Camera = { x: number; y: number; scale: number }
export type Viewport = { width: number; height: number }

/** A picture placed on the canvas, in canvas units. */
export type Placed = Box & {
  id: string
  title: string
  crumbs: string[]
  svg: { light: string; dark: string }
  atlas: DrawnTile["atlas"]
  /** Set on the drawing an agent hung under the strip. */
  fork?: { label: string; subject: string[] }
}

export const TITLE_BAND = 44
const GAP = 96

/** Tiles in one column, each with room for its title above it; a fork hangs last. */
export const layout = (tiles: readonly DrawnTile[], fork?: { sketch: Sketch; label: string; subject: string[] }): Placed[] => {
  const widest = Math.max(...tiles.map((tile) => tile.width), fork?.sketch.width ?? 0)
  let y = TITLE_BAND
  const placed: Placed[] = tiles.map((tile) => {
    const box = { x: (widest - tile.width) / 2, y, width: tile.width, height: tile.height }
    y += tile.height + GAP + TITLE_BAND
    return { ...box, id: tile.id, title: tile.title, crumbs: tile.crumbs, svg: tile.svg, atlas: tile.atlas }
  })
  if (fork !== undefined)
    placed.push({
      x: (widest - fork.sketch.width) / 2,
      y,
      width: fork.sketch.width,
      height: fork.sketch.height,
      id: "fork",
      title: fork.label,
      crumbs: [],
      svg: fork.sketch.svg,
      atlas: fork.sketch.atlas,
      fork: { label: fork.label, subject: fork.subject },
    })
  return placed
}

export const covering = (boxes: readonly Box[]): Box | undefined => {
  if (boxes.length === 0) return undefined
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export const MIN_SCALE = 0.05
export const MAX_SCALE = 4

/** The camera that shows `box` whole, centred, with some air around it. */
export const fit = (box: Box, viewport: Viewport, pad = 48, maxScale = 1.6): Camera => {
  const scale = Math.max(
    MIN_SCALE,
    Math.min(maxScale, (viewport.width - pad * 2) / Math.max(box.width, 1), (viewport.height - pad * 2) / Math.max(box.height, 1)),
  )
  return {
    scale,
    x: viewport.width / 2 - (box.x + box.width / 2) * scale,
    y: viewport.height / 2 - (box.y + box.height / 2) * scale,
  }
}

export const zoomAt = (camera: Camera, factor: number, at: { x: number; y: number }): Camera => {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, camera.scale * factor))
  const ratio = scale / camera.scale
  return { scale, x: at.x - (at.x - camera.x) * ratio, y: at.y - (at.y - camera.y) * ratio }
}

export const onScreen = (camera: Camera, viewport: Viewport): Box => ({
  x: -camera.x / camera.scale,
  y: -camera.y / camera.scale,
  width: viewport.width / camera.scale,
  height: viewport.height / camera.scale,
})

export const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const offset = (tile: Placed, box: Box): Box => ({ ...box, x: box.x + tile.x, y: box.y + tile.y })

/** The tile whose middle is nearest the middle of the window. */
export const nearest = (tiles: readonly Placed[], camera: Camera, viewport: Viewport): Placed | undefined => {
  const cx = (viewport.width / 2 - camera.x) / camera.scale
  const cy = (viewport.height / 2 - camera.y) / camera.scale
  let best: Placed | undefined
  let distance = Infinity
  for (const tile of tiles) {
    const d = Math.hypot(tile.x + tile.width / 2 - cx, tile.y + tile.height / 2 - cy)
    if (d < distance) {
      distance = d
      best = tile
    }
  }
  return best
}

export const tileForStage = (tiles: readonly Placed[], stage: StepStage | undefined, current: Placed | undefined): Placed | undefined => {
  if (stage === undefined) return current ?? tiles[0]
  if (stage.kind === "view") return tiles.find((tile) => tile.id === `view:${stage.view}`) ?? current ?? tiles[0]
  // A flow may be drawn by its own tile or inside a data-flow view.
  return (
    tiles.find((tile) => tile.id === `flow:${stage.flow}`) ??
    tiles.find((tile) => tile.fork === undefined && tile.atlas.messages[stage.flow] !== undefined) ??
    current ??
    tiles[0]
  )
}

const messageBox = (tile: Placed, id: string): Box | undefined => {
  const slash = id.indexOf("/")
  if (slash !== -1) {
    const box = tile.atlas.messages[id.slice(0, slash)]?.[id.slice(slash + 1)]
    if (box !== undefined) return box
  }
  for (const flow of Object.values(tile.atlas.messages)) if (flow[id] !== undefined) return flow[id]
  return undefined
}

/** What a focus lights on one tile, in canvas units. Empty for `all`. */
export const focusBoxes = (tile: Placed, focus: StepFocus): Box[] => {
  if (focus.kind === "all") return []
  const boxes = [
    ...focus.lanes.map((id) => tile.atlas.lanes[id]),
    ...focus.nodes.map((id) => tile.atlas.nodes[id]),
    ...focus.edges.map((id) => tile.atlas.edges[id]),
    ...focus.messages.map((id) => messageBox(tile, id)),
  ]
  return boxes.filter((box): box is Box => box !== undefined).map((box) => offset(tile, box))
}

/** Where a named place is drawn, preferring the tile already in view. */
export const placeBox = (tiles: readonly Placed[], current: Placed | undefined, kind: LivePlace["kind"], id: string): { tile: Placed; box: Box } | undefined => {
  const order = current === undefined ? tiles : [current, ...tiles.filter((tile) => tile !== current)]
  for (const tile of order) {
    if (kind === "diagram") {
      const bare = id.replace(/^(view|flow):/, "")
      if (tile.id === `view:${bare}` || tile.id === `flow:${bare}` || tile.id === id || tile.atlas.messages[bare] !== undefined) return { tile, box: tile }
      continue
    }
    const box = kind === "component" ? tile.atlas.nodes[id] : messageBox(tile, id)
    if (box !== undefined) return { tile, box: offset(tile, box) }
  }
  return undefined
}

/** Labels for every place a look can name. */
export const labelsOf = (doc: GraphDoc) => {
  const components = new Map(doc.nodes.map((node) => [node.id, node.label]))
  const messages = new Map<string, string>(doc.flows.flatMap((flow) => flow.messages.map((message) => [`${flow.id}/${message.id}`, message.label] as const)))
  return { components, messages }
}

/** Components and messages whose boxes fall inside `area`. */
export const placesIn = (tiles: readonly Placed[], area: Box, doc: GraphDoc, limit = 64): LivePlace[] => {
  const labels = labelsOf(doc)
  const seen = new Set<string>()
  const places: LivePlace[] = []
  const add = (place: LivePlace) => {
    const key = `${place.kind}:${place.id}`
    if (seen.has(key) || places.length >= limit) return
    seen.add(key)
    places.push(place)
  }
  for (const tile of tiles) {
    if (tile.fork !== undefined || !overlaps(tile, area)) continue
    for (const [id, box] of Object.entries(tile.atlas.nodes))
      if (overlaps(offset(tile, box), area)) add({ kind: "component", id, label: labels.components.get(id) ?? id })
    for (const [flow, steps] of Object.entries(tile.atlas.messages))
      for (const [message, box] of Object.entries(steps))
        if (overlaps(offset(tile, box), area)) {
          const id = `${flow}/${message}`
          add({ kind: "message", id, label: labels.messages.get(id) ?? id })
        }
  }
  return places
}

/** The last component or message drawn under a point. */
export const placeAt = (tiles: readonly Placed[], point: { x: number; y: number }, doc: GraphDoc): LivePlace | undefined => {
  const hit = placesIn(tiles, { ...point, width: 0.01, height: 0.01 }, doc, 256)
  return hit.at(-1)
}

export const stageOf = (tile: Placed): StepStage | null => {
  if (tile.id.startsWith("view:")) return { kind: "view", view: tile.id.slice("view:".length) }
  if (tile.id.startsWith("flow:")) return { kind: "flow", flow: tile.id.slice("flow:".length) }
  return null
}
