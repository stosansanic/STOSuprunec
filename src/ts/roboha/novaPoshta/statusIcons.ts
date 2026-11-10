import type { Direction, ShipmentState } from "./api";

const namespace = "http://www.w3.org/2000/svg";
type Shape = { d: string; fill?: string; stroke?: string };
const shapes: Record<ShipmentState, Shape[]> = {
  created: [
    { d: "M3 7 12 3l9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10M7.5 5l9 4" },
  ],
  transit: [
    { d: "M3 5h11v12H7m7-9h4l3 5v4h-2m-5 0h1M2 9h5M1 12h5M3 15h3" },
    { d: "M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 9v4h4" },
  ],
  arrived: [
    { d: "M12 16s6-6.1 6-9a6 6 0 0 0-12 0c0 2.9 6 9 6 9Z" },
    { d: "M12 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 14l-3 6 6 1 8-2 6 2-3-7" },
  ],
  received: [
    { d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z", fill: "currentColor", stroke: "none" },
    { d: "m7 12 3 3 7-7", stroke: "#fff" },
  ],
  attention: [
    { d: "m12 3 10 17H2L12 3Zm0 5v5m0 3v.5" },
  ],
  cancelled: [
    { d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-4 6 8 8m0-8-8 8" },
  ],
  unknown: [
    { d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4v6l5 3" },
  ],
};

export function statusIcon(state: ShipmentState, direction: Direction): SVGSVGElement {
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "np-status-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // A check and a separate arrow distinguish receipt by us from delivery to a recipient.
  const glyph = state === "received" && direction !== "unknown" ? [
    { d: "M9 2a7 7 0 1 0 0 14A7 7 0 0 0 9 2Z", fill: "currentColor", stroke: "none" },
    { d: "m5.5 9 2.5 2.5L12.5 7", stroke: "#fff" },
    { d: direction === "incoming" ? "M19 14v8m-3-3 3 3 3-3" : "M19 22v-8m-3 3 3-3 3 3" },
  ] : shapes[state] || shapes.unknown;
  for (const shape of glyph) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", shape.d);
    if (shape.fill) path.setAttribute("fill", shape.fill);
    if (shape.stroke) path.setAttribute("stroke", shape.stroke);
    if (state === "transit" && direction === "incoming") path.setAttribute("transform", "translate(24 0) scale(-1 1)");
    svg.append(path);
  }
  return svg;
}
