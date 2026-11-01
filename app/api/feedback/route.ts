import { createFeedbackPostHandler } from "../../feedbackApi.ts";
import { saveFeedbackSubmission } from "../../server/feedbackSubmissionStore.ts";

export const runtime = "nodejs";
export const maxDuration = 15;
export const POST = createFeedbackPostHandler(saveFeedbackSubmission);
