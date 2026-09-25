import type { LiveStep, WalkthroughStep } from "@coldtea/pr-lens-schema"

type Nav = { index: number; count: number; onStep: (index: number) => void; onClose: () => void }

const Controls = ({ index, count, onStep, onClose }: Nav) => (
  <div className="controls">
    <div className="dots">
      {Array.from({ length: count }, (_, at) => (
        <button key={at} className={at === index ? "dot on" : "dot"} onClick={() => onStep(at)} aria-label={`Step ${at + 1}`} />
      ))}
    </div>
    <button onClick={() => onStep(index - 1)} disabled={index === 0} title="Previous (←)">←</button>
    <span className="count">
      {index + 1} / {count}
    </span>
    <button onClick={() => onStep(index + 1)} disabled={index === count - 1} title="Next (→)">→</button>
    <button onClick={onClose} title="Close (Esc)">✕</button>
  </div>
)

export const StepPanel = ({ steps, index, onStep, onClose }: { steps: WalkthroughStep[]; index: number; onStep: (index: number) => void; onClose: () => void }) => {
  const step = steps[index]
  if (step === undefined) return null
  return (
    <aside className="panel">
      <div className="kicker">Walkthrough</div>
      <h3>{step.heading}</h3>
      <p>{step.body}</p>
      <Controls index={index} count={steps.length} onStep={onStep} onClose={onClose} />
    </aside>
  )
}

export const AnswerPanel = ({
  question,
  steps,
  index,
  onStep,
  onPlace,
  onClose,
}: {
  question: string
  steps: LiveStep[]
  index: number
  onStep: (index: number) => void
  onPlace: (kind: "component" | "message" | "diagram", id: string) => void
  onClose: () => void
}) => {
  const step = steps[index]
  if (step === undefined) return null
  return (
    <aside className="panel answer">
      <div className="kicker">Your agent answered · {question}</div>
      <h3>{step.heading}</h3>
      {step.paragraphs.map((paragraph, p) => (
        <p key={p}>
          {paragraph.parts.map((part, i) =>
            part.ref === undefined ? (
              <span key={i}>{part.text}</span>
            ) : (
              <button key={i} className="ref" onClick={() => onPlace(part.ref!.kind, part.ref!.id)}>
                {part.text}
              </button>
            ),
          )}
        </p>
      ))}
      {step.cannotTell !== undefined && <p className="cannot">{step.cannotTell}</p>}
      <Controls index={index} count={steps.length} onStep={onStep} onClose={onClose} />
    </aside>
  )
}
