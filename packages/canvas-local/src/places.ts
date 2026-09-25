import type { GraphDoc, LiveCommand, LiveRef, StepFocus, StepStage, View } from "@coldtea/pr-lens-schema";

export type Unknown = { at: string; kind: string; id: string; detail: string };
export type Valid = { components: string[]; messages: string[]; diagrams: string[] };

const viewIds = (views: readonly View[]): string[] => views.flatMap((view) => [view.id, ...viewIds(view.children)]);

/** Every id a live command may name on this document. */
export const placesOf = (doc: GraphDoc) => {
  const flows = new Map(doc.flows.map((flow) => [flow.id, new Set(flow.messages.map((message) => message.id))]));
  return {
    components: new Set(doc.nodes.map((node) => node.id)),
    edges: new Set(doc.edges.map((edge) => edge.id)),
    lanes: new Set(doc.lanes.map((lane) => lane.id)),
    views: new Set(viewIds(doc.views)),
    flows,
  };
};

type Places = ReturnType<typeof placesOf>;

export const validOf = (places: Places): Valid => ({
  components: [...places.components],
  messages: [...places.flows].flatMap(([flow, messages]) => [...messages].map((message) => `${flow}/${message}`)),
  diagrams: [...places.views, ...places.flows.keys()],
});

/** `flow/message`, or a bare message id some flow has. */
const hasMessage = (places: Places, id: string): boolean => {
  const slash = id.indexOf("/");
  if (slash !== -1 && places.flows.get(id.slice(0, slash))?.has(id.slice(slash + 1)) === true) return true;
  return [...places.flows.values()].some((messages) => messages.has(id));
};

const stage = (places: Places, value: StepStage | undefined, at: string): Unknown[] => {
  if (value === undefined) return [];
  if (value.kind === "view")
    return places.views.has(value.view) ? [] : [{ at: `${at}.view`, kind: "diagram", id: value.view, detail: "is not a view on this canvas" }];
  return places.flows.has(value.flow) ? [] : [{ at: `${at}.flow`, kind: "diagram", id: value.flow, detail: "is not a flow on this canvas" }];
};

const focus = (places: Places, value: StepFocus, at: string): Unknown[] => {
  if (value.kind === "all") return [];
  const missing = (field: string, ids: readonly string[], known: (id: string) => boolean, kind: string) =>
    ids.flatMap((id, index) => (known(id) ? [] : [{ at: `${at}.${field}[${index}]`, kind, id, detail: `is not a ${kind} on this canvas` }]));
  return [
    ...missing("nodes", value.nodes, (id) => places.components.has(id), "component"),
    ...missing("edges", value.edges, (id) => places.edges.has(id), "edge"),
    ...missing("lanes", value.lanes, (id) => places.lanes.has(id), "lane"),
    ...missing("messages", value.messages, (id) => hasMessage(places, id), "message"),
  ];
};

const ref = (places: Places, value: LiveRef, at: string): Unknown[] => {
  const known =
    value.kind === "component"
      ? places.components.has(value.id)
      : value.kind === "message"
        ? hasMessage(places, value.id)
        : places.views.has(value.id.replace(/^(view|flow):/, "")) || places.flows.has(value.id.replace(/^(view|flow):/, ""));
  return known ? [] : [{ at, kind: value.kind, id: value.id, detail: `is not a ${value.kind} on this canvas` }];
};

/** The ids a command names that the document does not have. */
export const unknownPlaces = (doc: GraphDoc, command: LiveCommand): Unknown[] => {
  const places = placesOf(doc);
  switch (command.kind) {
    case "answer":
      return command.steps.flatMap((step, s) => [
        ...stage(places, step.stage, `steps[${s}].stage`),
        ...focus(places, step.focus, `steps[${s}].focus`),
        ...step.paragraphs.flatMap((paragraph, p) =>
          paragraph.parts.flatMap((part, i) => (part.ref === undefined ? [] : ref(places, part.ref, `steps[${s}].paragraphs[${p}].parts[${i}].ref`))),
        ),
      ]);
    case "show":
      return [
        ...stage(places, command.stage, "stage"),
        ...focus(places, command.focus, "focus"),
        ...(command.open === undefined || hasMessage(places, command.open.message)
          ? []
          : [{ at: "open.message", kind: "message", id: command.open.message, detail: "is not a message on this canvas" }]),
      ];
    case "fork":
      return command.subject.components.flatMap((id, index) =>
        places.components.has(id) ? [] : [{ at: `subject.components[${index}]`, kind: "component", id, detail: "is not a component on this canvas" }],
      );
  }
};
