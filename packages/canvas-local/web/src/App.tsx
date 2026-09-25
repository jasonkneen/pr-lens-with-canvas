import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { LiveCommand, LiveStep, StepFocus, StepStage, ViewerLook } from "@coldtea/pr-lens-schema"
import {
  canvasIdOf,
  fetchPage,
  readEvents,
  readHash,
  readSeen,
  reportLook,
  takePairing,
  writeSeen,
  type Page,
  type Pairing,
  type Sketch,
} from "./api"
import {
  covering,
  fit,
  focusBoxes,
  layout,
  nearest,
  onScreen,
  placeAt,
  placeBox,
  placesIn,
  stageOf,
  tileForStage,
  TITLE_BAND,
  zoomAt,
  type Box,
  type Camera,
  type Placed,
} from "./geometry"
import { useTween } from "./tween"
import { AnswerPanel, StepPanel } from "./panels"
import { PayloadPanel } from "./payload"

type ThemeChoice = "system" | "light" | "dark"
type Answer = { question: string; steps: LiveStep[] }
type Mode = { kind: "default" } | { kind: "walkthrough"; step: number } | { kind: "answer"; answer: Answer; step: number }
type Spot = { boxes: Box[]; frame: Box }
type Scope = ViewerLook["scope"]
type Fork = { sketch: Sketch; label: string; subject: string[]; parts: string[] }

const THEME_KEY = "pr-lens:theme"
const readTheme = (): ThemeChoice => {
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    return stored === "light" || stored === "dark" ? stored : "system"
  } catch {
    return "system"
  }
}

const useSystemLight = () => {
  const [light, setLight] = useState(() => window.matchMedia("(prefers-color-scheme: light)").matches)
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: light)")
    const change = () => setLight(query.matches)
    query.addEventListener("change", change)
    return () => query.removeEventListener("change", change)
  }, [])
  return light
}

const pad = (box: Box, by: number): Box => ({ x: box.x - by, y: box.y - by, width: box.width + by * 2, height: box.height + by * 2 })

export const App = () => {
  const id = canvasIdOf(window.location.pathname)
  const [page, setPage] = useState<Page>()
  const [error, setError] = useState<string>()
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(readTheme)
  const systemLight = useSystemLight()
  const theme = themeChoice === "system" ? (systemLight ? "light" : "dark") : themeChoice
  const [mode, setMode] = useState<Mode>({ kind: "default" })
  const [spot, setSpot] = useState<Spot>()
  const [scope, setScope] = useState<Scope>(null)
  const [fork, setFork] = useState<Fork>()
  const [pairing] = useState<Pairing | undefined>(() => (id === undefined ? undefined : takePairing(id)))
  const [following, setFollowing] = useState(pairing !== undefined)
  const [liveEnded, setLiveEnded] = useState(false)
  const [waiting, setWaiting] = useState<{ command: LiveCommand; sketch?: Sketch }>()
  const [region, setRegion] = useState<Box>()
  const [openMessage, setOpenMessage] = useState<string>()
  const surface = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const { camera, setCamera, glide } = useTween({ x: 0, y: 0, scale: 1 })

  const load = useCallback(async () => {
    if (id === undefined) return setError("This address names no canvas. Canvas links look like /c/<id>.")
    try {
      setPage(await fetchPage(id))
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [id])

  useEffect(() => void load(), [load])

  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  const tiles = useMemo(() => (page === undefined ? [] : layout(page.tiles, fork)), [page, fork])
  const all = useMemo(() => covering(tiles.map((tile) => ({ ...tile, y: tile.y - TITLE_BAND, height: tile.height + TITLE_BAND }))), [tiles])
  const stage = { width: viewport.width, height: viewport.height - (mode.kind === "default" ? 0 : 170) }

  const fitAll = useCallback(() => {
    if (all !== undefined) glide(fit(all, viewport, 48, 1))
  }, [all, viewport, glide])

  // First sight: a walkthrough link starts on its step, anything else shows everything.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || page === undefined || all === undefined) return
    opened.current = true
    setCamera(fit(all, viewport, 48, 1))
    const step = Number(readHash(window.location.hash).s)
    if (page.document.walkthrough !== undefined && Number.isInteger(step) && step >= 1 && step <= page.document.walkthrough.steps.length)
      setMode({ kind: "walkthrough", step: step - 1 })
  }, [page, all, viewport, setCamera])

  const current = useCallback(() => nearest(tiles.filter((tile) => tile.fork === undefined), camera, viewport), [tiles, camera, viewport])

  /** Light what a stage and focus name, and move there. */
  const showStage = useCallback(
    (stageRef: StepStage | undefined, focus: StepFocus, area = stage) => {
      const tile = tileForStage(tiles, stageRef, current())
      if (tile === undefined) return
      const boxes = focusBoxes(tile, focus)
      const frame = covering(boxes) ?? tile
      setSpot({ boxes, frame: tile })
      glide(fit(pad(frame, boxes.length > 0 ? 80 : 24), area, 48, boxes.length > 0 ? 1.4 : 1))
    },
    [tiles, current, glide, stage],
  )

  // Walkthrough and answer steps drive the camera.
  const steps = mode.kind === "walkthrough" ? page?.document.walkthrough?.steps : mode.kind === "answer" ? mode.answer.steps : undefined
  const stepIndex = mode.kind === "default" ? -1 : mode.step
  useEffect(() => {
    if (mode.kind === "default") return setSpot(undefined)
    const step = steps?.[stepIndex]
    if (step !== undefined) showStage(step.stage, step.focus)
    if (mode.kind === "walkthrough") window.history.replaceState(null, "", `#s=${stepIndex + 1}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tiles])

  const leaveMode = useCallback(() => {
    setMode({ kind: "default" })
    if (readHash(window.location.hash).s !== undefined) window.history.replaceState(null, "", window.location.pathname)
  }, [])

  const toggleWalkthrough = useCallback(() => {
    if (page?.document.walkthrough === undefined) return
    setMode((now) => (now.kind === "walkthrough" ? { kind: "default" } : { kind: "walkthrough", step: 0 }))
  }, [page])

  const step = useCallback(
    (by: number) =>
      setMode((now) => {
        if (now.kind === "default") return now
        const count = now.kind === "walkthrough" ? (page?.document.walkthrough?.steps.length ?? 0) : now.answer.steps.length
        const next = Math.max(0, Math.min(count - 1, now.step + by))
        return next === now.step ? now : { ...now, step: next }
      }),
    [page],
  )

  const goTo = useCallback((index: number) => setMode((now) => (now.kind === "default" ? now : { ...now, step: index })), [])

  /** A link in an answer's words: light that one place. */
  const showPlace = useCallback(
    (kind: "component" | "message" | "diagram", placeId: string) => {
      const found = placeBox(tiles, current(), kind, placeId)
      if (found === undefined) return
      setSpot({ boxes: kind === "diagram" ? [] : [found.box], frame: found.tile })
      glide(fit(pad(found.box, kind === "diagram" ? 24 : 120), stage, 48, 1.4))
    },
    [tiles, current, glide, stage],
  )

  // ── Live mode ──────────────────────────────────────────────────────────

  const apply = useCallback(
    (command: LiveCommand, sketch?: Sketch) => {
      switch (command.kind) {
        case "answer":
          setMode({ kind: "answer", answer: { question: command.question, steps: command.steps }, step: 0 })
          return
        case "show":
          setMode({ kind: "default" })
          if (command.open !== undefined) {
            const found = placeBox(tiles, tileForStage(tiles, command.stage, current()), "message", command.open.message)
            if (found !== undefined) {
              setOpenMessage(command.open.message)
              setSpot({ boxes: [found.box], frame: found.tile })
              // Framed in the room left of the payload panel.
              glide(fit(pad(found.box, 160), { width: Math.max(320, viewport.width - 470), height: viewport.height }, 48, 1.4))
              return
            }
          }
          showStage(command.stage, command.focus, viewport)
          return
        case "fork":
          if (sketch === undefined) return
          setFork({
            sketch,
            label: command.sketch.title,
            subject: command.subject.components,
            parts: command.sketch.nodes.slice(0, 10).map((node) => node.label),
          })
          return
      }
    },
    [tiles, current, glide, viewport, showStage],
  )

  // A fork re-lays the canvas; move to it once it is placed.
  const forkTile = tiles.find((tile) => tile.fork !== undefined)
  useEffect(() => {
    if (forkTile === undefined) return
    setSpot(undefined)
    glide(fit(pad(forkTile, 24), viewport, 48, 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forkTile?.fork])

  const followingRef = useRef(following)
  followingRef.current = following
  const applyRef = useRef(apply)
  applyRef.current = apply

  useEffect(() => {
    if (id === undefined || pairing === undefined || liveEnded) return
    let seen = readSeen(id)
    let stopped = false
    const poll = async () => {
      try {
        const events = await readEvents(id, pairing, seen)
        if (events === undefined) return setLiveEnded(true)
        for (const { seq, event } of events) {
          seen = seq
          if (event.kind === "revised") {
            await load()
            continue
          }
          if (followingRef.current) applyRef.current(event.command, event.sketch)
          else setWaiting({ command: event.command, sketch: event.sketch })
        }
        writeSeen(id, pairing, seen)
      } catch {
        // A missed poll is retried on the next tick.
      }
      if (!stopped) timer = window.setTimeout(poll, 1000)
    }
    let timer = window.setTimeout(poll, 0)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [id, pairing, liveEnded, load])

  const stepOut = useCallback(() => {
    if (followingRef.current) setFollowing(false)
  }, [])

  const follow = useCallback(() => {
    setFollowing(true)
    if (waiting !== undefined) {
      apply(waiting.command, waiting.sketch)
      setWaiting(undefined)
    }
  }, [waiting, apply])

  const look = useMemo((): ViewerLook | undefined => {
    if (page === undefined) return undefined
    const middle = current()
    const inView = tiles.filter((tile) => tile.fork === undefined)
    return {
      following,
      rev: page.rev,
      diagram: middle === undefined ? null : { stage: stageOf(middle), title: middle.title },
      inFrame: placesIn(inView, onScreen(camera, viewport), page.document),
      scope,
      answer: mode.kind === "answer" ? { question: mode.answer.question, step: mode.step, steps: mode.answer.steps.length } : null,
      fork: fork === undefined ? null : { label: fork.label, parts: fork.parts },
    }
  }, [page, tiles, camera, viewport, following, scope, mode, fork, current])

  const lookRef = useRef(look)
  lookRef.current = look
  const lookKey = JSON.stringify(look)
  useEffect(() => {
    if (id === undefined || pairing === undefined || liveEnded || lookRef.current === undefined) return
    const timer = window.setTimeout(() => lookRef.current && void reportLook(id, pairing, lookRef.current), 400)
    return () => window.clearTimeout(timer)
  }, [lookKey, id, pairing, liveEnded])
  useEffect(() => {
    if (id === undefined || pairing === undefined || liveEnded) return
    const timer = window.setInterval(() => lookRef.current && void reportLook(id, pairing, lookRef.current), 30_000)
    return () => window.clearInterval(timer)
  }, [id, pairing, liveEnded])

  // ── Input ──────────────────────────────────────────────────────────────

  const cycleTheme = useCallback(() => {
    setThemeChoice((now) => {
      const next = now === "system" ? (systemLight ? "dark" : "light") : now === "light" ? "dark" : "system"
      try {
        window.localStorage.setItem(THEME_KEY, next)
      } catch {
        // Kept for this tab only.
      }
      return next
    })
  }, [systemLight])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return
      const middle = { x: viewport.width / 2, y: viewport.height / 2 }
      switch (event.key) {
        case "w":
        case "W":
          return toggleWalkthrough()
        case "f":
        case "F":
          stepOut()
          return fitAll()
        case "t":
        case "T":
          return cycleTheme()
        case "ArrowRight":
        case "ArrowDown":
          if (mode.kind !== "default") step(1)
          return
        case "ArrowLeft":
        case "ArrowUp":
          if (mode.kind !== "default") step(-1)
          return
        case "Escape":
          setScope(null)
          if (openMessage !== undefined) return setOpenMessage(undefined)
          return leaveMode()
        case "+":
        case "=":
          stepOut()
          return glide(zoomAt(camera, 1.25, middle))
        case "-":
          stepOut()
          return glide(zoomAt(camera, 0.8, middle))
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [toggleWalkthrough, fitAll, cycleTheme, step, leaveMode, mode, glide, camera, viewport, stepOut, openMessage])

  const toWorld = (clientX: number, clientY: number) => ({ x: (clientX - camera.x) / camera.scale, y: (clientY - camera.y) / camera.scale })

  const drag = useRef<{ x: number; y: number; camera: Camera; moved: boolean; region: boolean } | undefined>(undefined)

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, camera, moved: false, region: event.shiftKey }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const now = drag.current
    if (now === undefined) return
    const dx = event.clientX - now.x
    const dy = event.clientY - now.y
    if (!now.moved && Math.hypot(dx, dy) < 4) return
    now.moved = true
    if (now.region) {
      const a = toWorld(now.x, now.y)
      const b = toWorld(event.clientX, event.clientY)
      setRegion({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
      return
    }
    stepOut()
    setCamera({ ...now.camera, x: now.camera.x + dx, y: now.camera.y + dy })
  }

  const onPointerUp = (event: React.PointerEvent) => {
    const now = drag.current
    drag.current = undefined
    if (now === undefined || page === undefined) return
    if (now.region && region !== undefined) {
      const places = placesIn(tiles, region, page.document)
      setScope(places.length === 0 ? null : { kind: "region", places })
      setRegion(undefined)
      return
    }
    if (now.moved) return
    const inside = tiles.find((tile) => tile.fork !== undefined && placeAt([tile], toWorld(event.clientX, event.clientY), page.document))
    const place = placeAt(tiles.filter((tile) => tile.fork === undefined), toWorld(event.clientX, event.clientY), page.document)
    if (inside?.fork !== undefined) {
      const labels = Object.keys(inside.atlas.nodes)
      setScope({ kind: "drawn", label: inside.fork.label, within: inside.fork.subject.join(", "), places: labels.slice(0, 64).map((node) => ({ kind: "component", id: node, label: node })) })
      return
    }
    setScope(place === undefined ? null : { kind: "place", place })
    setOpenMessage(place?.kind === "message" ? place.id : undefined)
  }

  const onWheel = (event: React.WheelEvent) => {
    stepOut()
    if (event.ctrlKey || event.metaKey) setCamera(zoomAt(camera, Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY }))
    else setCamera({ ...camera, x: camera.x - event.deltaX, y: camera.y - event.deltaY })
  }

  // ── Picture ────────────────────────────────────────────────────────────

  const scopeBoxes = useMemo(() => {
    if (scope === null) return []
    const places = scope.kind === "place" ? [scope.place] : scope.places
    return places.flatMap((place) => {
      const found = placeBox(tiles, undefined, place.kind, place.id)
      return found === undefined ? [] : [found.box]
    })
  }, [scope, tiles])

  if (error !== undefined)
    return (
      <div className={`app ${theme}`}>
        <div className="empty">{error}</div>
      </div>
    )
  if (page === undefined)
    return (
      <div className={`app ${theme}`}>
        <div className="empty">Loading the canvas…</div>
      </div>
    )

  const dimmed = spot !== undefined && spot.boxes.length > 0
  const world = all === undefined ? { x: 0, y: 0, width: 1, height: 1 } : pad(all, 4000)

  return (
    <div className={`app ${theme}`}>
      <div
        ref={surface}
        className="surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      >
        <div className="world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
          {tiles.map((tile) => (
            <Tile key={tile.id} tile={tile} theme={theme} lit={spot === undefined || spot.frame === tile || !dimmed} />
          ))}
          <svg className="overlay" style={{ left: world.x, top: world.y, width: world.width, height: world.height }} viewBox={`${world.x} ${world.y} ${world.width} ${world.height}`}>
            {dimmed && (
              <path
                className="dim"
                fillRule="evenodd"
                d={[`M${world.x},${world.y}h${world.width}v${world.height}h${-world.width}z`, ...spot.boxes.map((box) => {
                  const b = pad(box, 10)
                  return `M${b.x},${b.y}h${b.width}v${b.height}h${-b.width}z`
                })].join(" ")}
              />
            )}
            {dimmed && spot.boxes.map((box, index) => <rect key={index} className="rim" {...pad(box, 10)} rx={14} />)}
            {scopeBoxes.map((box, index) => <rect key={`s${index}`} className="picked" {...pad(box, 6)} rx={10} />)}
            {region !== undefined && <rect className="region" {...region} />}
          </svg>
        </div>
      </div>

      <header className="bar">
        <div className="title">
          <strong>{page.document.title}</strong>
          <span>rev {page.rev}</span>
        </div>
        <div className="tools">
          {pairing !== undefined && (
            liveEnded ? (
              <span className="live ended">Live session ended</span>
            ) : following ? (
              <span className="live on">● Following agent</span>
            ) : (
              <button className="live off" onClick={follow}>
                {waiting === undefined ? "Follow agent" : "Agent sent something · follow"}
              </button>
            )
          )}
          {page.document.walkthrough !== undefined && (
            <button onClick={toggleWalkthrough} title="Walkthrough (W)">
              {mode.kind === "walkthrough" ? "■ Stop" : "▶ Walkthrough"}
            </button>
          )}
          <button onClick={() => { stepOut(); glide(zoomAt(camera, 0.8, { x: viewport.width / 2, y: viewport.height / 2 })) }} title="Zoom out (-)">−</button>
          <span className="zoom">{Math.round(camera.scale * 100)}%</span>
          <button onClick={() => { stepOut(); glide(zoomAt(camera, 1.25, { x: viewport.width / 2, y: viewport.height / 2 })) }} title="Zoom in (+)">+</button>
          <button onClick={() => { stepOut(); fitAll() }} title="Fit (F)">Fit</button>
          <button onClick={cycleTheme} title="Theme (T)">{themeChoice === "system" ? "◐ Auto" : themeChoice === "light" ? "☀ Light" : "☾ Dark"}</button>
        </div>
      </header>

      {openMessage !== undefined && (
        <PayloadPanel key={openMessage} doc={page.document} id={openMessage} onClose={() => setOpenMessage(undefined)} />
      )}
      {mode.kind === "walkthrough" && page.document.walkthrough !== undefined && (
        <StepPanel steps={page.document.walkthrough.steps} index={mode.step} onStep={goTo} onClose={leaveMode} />
      )}
      {mode.kind === "answer" && (
        <AnswerPanel question={mode.answer.question} steps={mode.answer.steps} index={mode.step} onStep={goTo} onPlace={showPlace} onClose={leaveMode} />
      )}
    </div>
  )
}

const Tile = ({ tile, theme, lit }: { tile: Placed; theme: "light" | "dark"; lit: boolean }) => {
  const markup = useMemo(() => ({ __html: tile.svg[theme] }), [tile, theme])
  return (
    <section className={`tile${lit ? "" : " faded"}${tile.fork ? " fork" : ""}`} style={{ left: tile.x, top: tile.y - TITLE_BAND, width: tile.width }}>
      <h2>
        {tile.fork ? <span className="tag">Inside {tile.fork.subject.join(", ")}</span> : tile.crumbs.length > 1 && <span className="tag">{tile.crumbs.slice(0, -1).join(" › ")}</span>}
        {tile.title}
      </h2>
      <div className="picture" style={{ width: tile.width, height: tile.height }} dangerouslySetInnerHTML={markup} />
    </section>
  )
}
