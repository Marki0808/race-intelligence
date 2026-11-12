export type ProfileBoundaryPlot = {
  svgLeft: number;
  svgWidth: number;
  chartWidth: number;
  plotLeft: number;
  plotRight: number;
  routeDistanceM: number;
};

/** Maps a pointer x-coordinate to cumulative route distance, including scrolled SVGs. */
export function profileClientXToDistanceM(clientX: number, plot: ProfileBoundaryPlot): number | null {
  const { svgLeft, svgWidth, chartWidth, plotLeft, plotRight, routeDistanceM } = plot;
  if (![clientX, svgLeft, svgWidth, chartWidth, plotLeft, plotRight, routeDistanceM].every(Number.isFinite) ||
      svgWidth <= 0 || chartWidth <= 0 || routeDistanceM <= 0 || plotLeft < 0 || plotRight < 0 || plotLeft + plotRight >= chartWidth) return null;

  const viewX = ((clientX - svgLeft) / svgWidth) * chartWidth;
  if (viewX < plotLeft || viewX > chartWidth - plotRight) return null;
  return ((viewX - plotLeft) / (chartWidth - plotLeft - plotRight)) * routeDistanceM;
}

export function profilePointerMoved(startX: number, startY: number, clientX: number, clientY: number, thresholdPx = 8): boolean {
  return Math.hypot(clientX - startX, clientY - startY) > thresholdPx;
}

