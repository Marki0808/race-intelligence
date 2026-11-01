/** Focuses and reveals the completed analysis heading only after successful route analysis. */
export function focusCompletedRouteAnalysis(
  analysisAvailable: boolean,
  heading: Pick<HTMLElement, "focus" | "scrollIntoView"> | null,
  prefersReducedMotion: boolean,
): boolean {
  if (!analysisAvailable || !heading) return false;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ behavior: prefersReducedMotion ? "instant" : "smooth", block: "start" });
  return true;
}
