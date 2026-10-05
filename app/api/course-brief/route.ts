import { createCourseBriefPostHandler } from "../../courseBriefApi.ts";
import { OpenAiCourseBriefProvider } from "../../server/openAiCourseBriefProvider.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

export const POST = createCourseBriefPostHandler(
  () => new OpenAiCourseBriefProvider({ apiKey: process.env.OPENAI_API_KEY }),
);
