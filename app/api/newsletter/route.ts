import { createNewsletterPostHandler } from "../../newsletterApi.ts";
import { recordNewsletterSignup } from "../../server/newsletterSubscriberStore.ts";

export const runtime = "nodejs";
export const maxDuration = 15;
export const POST = createNewsletterPostHandler(recordNewsletterSignup);
