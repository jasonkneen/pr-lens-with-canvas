import { useState, type ReactNode } from "react"
import type { FlowMessage, GraphDoc, PayloadSide } from "@coldtea/pr-lens-schema"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Mark = "added" | "removed" | "changed" | undefined

/** `flow/message`, or a bare message id some flow has. */
export const findMessage = (doc: GraphDoc, id: string): { flow: string; message: FlowMessage } | undefined => {
  const slash = id.indexOf("/")
  for (const flow of doc.flows) {
    if (slash !== -1 && flow.id !== id.slice(0, slash)) continue
    const message = flow.messages.find((candidate) => candidate.id === (slash === -1 ? id : id.slice(slash + 1)))
    if (message !== undefined) return { flow: flow.id, message }
  }
  return undefined
}

const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const scalar = (value: Json) => (typeof value === "string" ? JSON.stringify(value) : String(value))

/**
 * The sample drawn as JSON, each key coloured by how it moved against the
 * sample before the change: new green, dropped red (shown struck through, with
 * its old value), changed amber. With no before, nothing is marked.
 */
const Tree = ({ value, before, compare, depth }: { value: Json; before: Json | undefined; compare: boolean; depth: number }): ReactNode => {
  const indent = "  ".repeat(depth + 1)
  const close = "  ".repeat(depth)

  if (isObject(value)) {
    const old = isObject(before) ? before : {}
    const keys = [...Object.keys(value), ...(compare ? Object.keys(old).filter((key) => !(key in value)) : [])]
    return (
      <>
        {"{"}
        {keys.map((key, index) => {
          const gone = !(key in value)
          const mark: Mark = !compare ? undefined : gone ? "removed" : !(key in old) ? "added" : undefined
          const shown = gone ? old[key]! : value[key]!
          const leafChanged = compare && mark === undefined && !isObject(shown) && !Array.isArray(shown) && JSON.stringify(shown) !== JSON.stringify(old[key])
          return (
            <div key={key} className={`line ${mark ?? (leafChanged ? "changed" : "")}`}>
              {indent}
              <span className="key">{JSON.stringify(key)}</span>:{" "}
              {mark === undefined ? <Tree value={shown} before={old[key]} compare={compare} depth={depth + 1} /> : <Tree value={shown} before={undefined} compare={false} depth={depth + 1} />}
              {index < keys.length - 1 ? "," : ""}
            </div>
          )
        })}
        {close}
        {"}"}
      </>
    )
  }

  if (Array.isArray(value)) {
    const old = Array.isArray(before) ? before : []
    if (value.length === 0) return <>{"[]"}</>
    return (
      <>
        {"["}
        {value.map((item, index) => (
          <div key={index} className="line">
            {indent}
            <Tree value={item} before={old[index]} compare={compare} depth={depth + 1} />
            {index < value.length - 1 ? "," : ""}
          </div>
        ))}
        {close}
        {"]"}
      </>
    )
  }

  return <span className={`value ${typeof value}`}>{scalar(value)}</span>
}

const Side = ({ side }: { side: PayloadSide }) => {
  const hasSample = side.sample !== undefined
  const hasShape = side.shape !== undefined
  const [view, setView] = useState<"sample" | "shape">(hasSample ? "sample" : "shape")
  const compare = side.before !== undefined

  return (
    <div className="side">
      <div className="side-head">
        <code className="type">{side.type}</code>
        {hasSample && hasShape && (
          <div className="toggle">
            <button className={view === "shape" ? "on" : ""} onClick={() => setView("shape")}>Shape</button>
            <button className={view === "sample" ? "on" : ""} onClick={() => setView("sample")}>Sample</button>
          </div>
        )}
      </div>
      {view === "sample" && hasSample ? (
        <>
          {compare && (
            <div className="legend">
              <span className="added">added</span> <span className="removed">dropped</span> <span className="changed">changed</span> against the sample before this change
            </div>
          )}
          <pre className="json">
            <Tree value={side.sample as Json} before={side.before as Json | undefined} compare={compare} depth={0} />
          </pre>
        </>
      ) : hasShape ? (
        <pre className="json">{side.shape}</pre>
      ) : (
        <p className="nothing">No shape or sample was given for this side.</p>
      )}
      {side.source !== undefined && <div className="source">from {side.source.path}</div>}
    </div>
  )
}

export const PayloadPanel = ({ doc, id, onClose }: { doc: GraphDoc; id: string; onClose: () => void }) => {
  const found = findMessage(doc, id)
  const payload = found?.message.payload
  const [tab, setTab] = useState<"request" | "response">(payload?.request !== undefined ? "request" : "response")
  if (found === undefined) return null
  const { message } = found
  const nodes = new Map(doc.nodes.map((node) => [node.id, node.label]))

  return (
    <aside className="payload" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <header>
        <div>
          <div className="kicker">
            {nodes.get(message.from) ?? message.from} → {nodes.get(message.to) ?? message.to}
          </div>
          <h3>{message.label}</h3>
        </div>
        <button onClick={onClose} title="Close (Esc)">✕</button>
      </header>
      {message.note !== undefined && <p className="note">{message.note}</p>}
      {payload === undefined ? (
        <p className="nothing">This step carries no sample traffic.</p>
      ) : (
        <>
          <div className="tabs">
            {payload.request !== undefined && (
              <button className={tab === "request" ? "on" : ""} onClick={() => setTab("request")}>Request</button>
            )}
            {payload.response !== undefined && (
              <button className={tab === "response" ? "on" : ""} onClick={() => setTab("response")}>Response</button>
            )}
          </div>
          {tab === "request" && payload.request !== undefined && <Side key="request" side={payload.request} />}
          {tab === "response" && payload.response !== undefined && <Side key="response" side={payload.response} />}
        </>
      )}
    </aside>
  )
}
