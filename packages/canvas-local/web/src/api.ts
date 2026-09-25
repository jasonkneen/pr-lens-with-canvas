import type { GraphDoc, LiveCommand, ViewerLook } from "@coldtea/pr-lens-schema"
import type { DrawnTile } from "../../src/draw"

export type { DrawnTile }

export type Page = { id: string; rev: number; document: GraphDoc; tiles: DrawnTile[] }

export type Sketch = { width: number; height: number; svg: { light: string; dark: string }; atlas: DrawnTile["atlas"] }

export type LiveEvent =
  | { kind: "command"; command: LiveCommand; sketch?: Sketch }
  | { kind: "revised"; rev: number }

export type Pairing = { session: string; secret: string }

export const canvasIdOf = (path: string): string | undefined => /^\/c\/([A-Za-z0-9_-]{22})\/?$/.exec(path)?.[1]

export const fetchPage = async (id: string): Promise<Page> => {
  const response = await fetch(`/api/canvas/${id}/page`, { cache: "no-store" })
  if (!response.ok) throw new Error(response.status === 404 ? "No canvas here yet. Push to it first." : `The store answered ${response.status}`)
  return (await response.json()) as Page
}

/** `#a=1&b` into `{ a: "1", b: "" }`. */
export const readHash = (hash: string): Record<string, string> =>
  Object.fromEntries(
    hash
      .replace(/^#/, "")
      .split("&")
      .filter((part) => part !== "")
      .map((part) => {
        const at = part.indexOf("=")
        return at === -1 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)]
      }),
  )

export const writeHash = (values: Record<string, string>): string => {
  const parts = Object.entries(values).map(([key, value]) => (value === "" ? key : `${key}=${value}`))
  return parts.length === 0 ? "" : `#${parts.join("&")}`
}

const PAIRING = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/
const pairingKey = (id: string) => `pr-lens:live:${id}`

/**
 * The pairing rides in the fragment once, then moves to session storage and
 * off the address bar, so a copied link never carries the secret.
 */
export const takePairing = (id: string): Pairing | undefined => {
  const hash = readHash(window.location.hash)
  const match = PAIRING.exec(hash.live ?? "")
  const { live: _live, w: _w, ...rest } = hash
  if (hash.live !== undefined || hash.w !== undefined)
    window.history.replaceState(null, "", writeHash(rest) || window.location.pathname)
  try {
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const pairing = { session: match[1], secret: match[2] }
      window.sessionStorage.setItem(pairingKey(id), JSON.stringify({ ...pairing, seen: 0 }))
      return pairing
    }
    const stored = JSON.parse(window.sessionStorage.getItem(pairingKey(id)) ?? "null") as Pairing | null
    return stored ?? undefined
  } catch {
    return match?.[1] !== undefined && match[2] !== undefined ? { session: match[1], secret: match[2] } : undefined
  }
}

export const readSeen = (id: string): number => {
  try {
    return (JSON.parse(window.sessionStorage.getItem(pairingKey(id)) ?? "null") as { seen?: number } | null)?.seen ?? 0
  } catch {
    return 0
  }
}

export const writeSeen = (id: string, pairing: Pairing, seen: number) => {
  try {
    window.sessionStorage.setItem(pairingKey(id), JSON.stringify({ ...pairing, seen }))
  } catch {
    // A private window keeps no storage; the tab just replays from the start.
  }
}

const livePath = (id: string, pairing: Pairing) => `/api/canvas/${id}/live/${pairing.session}`
const auth = (pairing: Pairing) => ({ authorization: `Bearer ${pairing.secret}` })

/** `undefined` when the session has ended. */
export const readEvents = async (id: string, pairing: Pairing, after: number): Promise<{ seq: number; event: LiveEvent }[] | undefined> => {
  const response = await fetch(`${livePath(id, pairing)}?after=${after}`, { headers: auth(pairing), cache: "no-store" })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`The store answered ${response.status}`)
  return ((await response.json()) as { events: { seq: number; event: LiveEvent }[] }).events
}

export const reportLook = async (id: string, pairing: Pairing, look: ViewerLook): Promise<void> => {
  await fetch(`${livePath(id, pairing)}/look`, {
    method: "POST",
    headers: { ...auth(pairing), "content-type": "application/json" },
    body: JSON.stringify(look),
    cache: "no-store",
  }).catch(() => undefined)
}
