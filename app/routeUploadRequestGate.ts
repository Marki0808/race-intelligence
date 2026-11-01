/** Prevents overlapping route uploads and prevents stale async work from publishing state. */
export class RouteUploadRequestGate {
  private generation = 0;
  private activeId: number | null = null;

  begin(): number | null {
    if (this.activeId !== null) return null;
    this.generation += 1;
    this.activeId = this.generation;
    return this.activeId;
  }

  isCurrent(id: number): boolean {
    return this.activeId === id && this.generation === id;
  }

  finish(id: number): boolean {
    if (!this.isCurrent(id)) return false;
    this.activeId = null;
    return true;
  }

  invalidate(): void {
    this.generation += 1;
    this.activeId = null;
  }
}
