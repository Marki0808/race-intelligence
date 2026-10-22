/** Shared map strokes keep the complete GPX route legible across light, green and dense basemaps. */
export const ROUTE_MAP_STYLES = {
  contextHalo: { color: "#f8f8f4", weight: 8, opacity: 0.96, lineCap: "round", lineJoin: "round" },
  context: { color: "#46514d", weight: 4, opacity: 0.98, lineCap: "round", lineJoin: "round" },
  selectedHalo: { color: "#f8f8f4", weight: 13, opacity: 1, lineCap: "round", lineJoin: "round" },
  selectedSection: { color: "#17211c", weight: 9, opacity: 1, lineCap: "round", lineJoin: "round" },
  selectedMoment: { color: "#d7ac3a", weight: 8, opacity: 1, lineCap: "round", lineJoin: "round" },
} as const;
