import { flattenViews, render, type RenderAtlas, type Theme } from "@coldtea/pr-lens-renderer";
import type { Flow, GraphDoc, Lens, View } from "@coldtea/pr-lens-schema";

/** A tile as the canvas API documents it. */
export type Tile = {
  id: string;
  title: string;
  lens: Lens;
  crumbs: string[];
  hero: boolean;
  width: number;
  height: number;
  renders: Record<Theme, string>;
  images: Record<Theme, string>;
};

/** What the page needs beyond the API's tile: the pictures themselves and where everything landed. */
export type DrawnTile = Tile & {
  svg: Record<Theme, string>;
  atlas: RenderAtlas;
};

type Target = { id: string; title: string; lens: Lens; crumbs: string[]; draw: (theme: Theme) => ReturnType<typeof render> };

const viewTargets = (doc: GraphDoc, views: readonly View[], parents: string[]): Target[] =>
  views.flatMap((view) => {
    const crumbs = [...parents, view.id];
    const own: Target[] = doc.lenses.includes(view.lens)
      ? [{ id: `view:${view.id}`, title: view.title, lens: view.lens, crumbs, draw: (theme) => render(doc, { lens: view.lens, theme, view: view.id }) }]
      : [];
    return [...own, ...viewTargets(doc, view.children, crumbs)];
  });

/** A flow drawn on its own: the document narrowed to that one flow, with the lens declared. */
export const flowDocument = (doc: GraphDoc, flow: Flow): GraphDoc => ({
  ...doc,
  lenses: doc.lenses.includes("data-flow") ? doc.lenses : [...doc.lenses, "data-flow"],
  flows: [flow],
  views: [],
  walkthrough: undefined,
});

const flowTargets = (doc: GraphDoc): Target[] =>
  doc.flows.map((flow) => ({
    id: `flow:${flow.id}`,
    title: flow.title,
    lens: "data-flow" as const,
    crumbs: [flow.id],
    draw: (theme) => render(flowDocument(doc, flow), { lens: "data-flow", theme }),
  }));

const targetsOf = (doc: GraphDoc): Target[] => {
  const views = viewTargets(doc, doc.views, []);
  const whole: Target[] =
    views.length === 0 && doc.lenses.includes("architecture")
      ? [{ id: "lens:architecture", title: doc.title, lens: "architecture", crumbs: [], draw: (theme) => render(doc, { lens: "architecture", theme }) }]
      : [];
  // A flow a data-flow view already draws gets no second picture of its own.
  const drawnFlows = new Set(
    flattenViews(doc.views)
      .filter((view) => view.lens === "data-flow" && doc.lenses.includes("data-flow"))
      .flatMap((view) => (view.scope.kind === "all" ? doc.flows.map((flow) => flow.id) : view.scope.flows)),
  );
  return [...whole, ...views, ...flowTargets(doc).filter((target) => !drawnFlows.has(target.id.slice("flow:".length)))];
};

/** Every picture the canvas shows, in order, the first one the hero. Throws the renderer's error when nothing draws. */
export const drawTiles = (doc: GraphDoc, imageBase: string): DrawnTile[] =>
  targetsOf(doc).map((target, index) => {
    const light = target.draw("light");
    const dark = target.draw("dark");
    const images = {
      light: `${imageBase}/${encodeURIComponent(target.id)}.light.svg`,
      dark: `${imageBase}/${encodeURIComponent(target.id)}.dark.svg`,
    };
    return {
      id: target.id,
      title: target.title,
      lens: target.lens,
      crumbs: target.crumbs,
      hero: index === 0,
      width: light.width,
      height: light.height,
      renders: images,
      images,
      svg: { light: light.svg, dark: dark.svg },
      atlas: light.atlas,
    };
  });

/** The API's tile, without the pictures the page alone reads. */
export const apiTile = ({ svg: _svg, atlas: _atlas, ...tile }: DrawnTile): Tile => tile;

/** A fork's sketch, drawn as one picture. */
export const drawSketch = (sketch: GraphDoc) => {
  const lens: Lens = sketch.lenses.includes("architecture") ? "architecture" : "data-flow";
  const light = render(sketch, { lens, theme: "light" });
  const dark = render(sketch, { lens, theme: "dark" });
  return { lens, width: light.width, height: light.height, svg: { light: light.svg, dark: dark.svg }, atlas: light.atlas };
};
