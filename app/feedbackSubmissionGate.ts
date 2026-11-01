/** Guards a feedback form against repeated activation before React can rerender. */
export class FeedbackSubmissionGate {
  private active = false;

  begin(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  finish(): void {
    this.active = false;
  }
}
