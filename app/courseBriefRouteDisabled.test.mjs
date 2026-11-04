import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { POST } from "./api/course-brief/route.ts";

test("public Course Brief API returns a stable disabled response without processing requests", async () => {
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  globalThis.fetch = async () => {
    externalRequests += 1;
    throw new Error("external processing must remain disabled");
  };
  try {
    for (const body of ["{}", "not-json", "{}".repeat(500)]) {
      const response = await POST(new Request("https://endurset.com/api/course-brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }));
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
    assert.equal(externalRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disabled route has no provider, API-key, or external handler dependency", async () => {
  const source = await readFile(new URL("./api/course-brief/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /OpenAiCourseBriefProvider|OPENAI_API_KEY|createCourseBriefPostHandler/);
});
