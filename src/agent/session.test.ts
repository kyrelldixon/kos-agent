import { describe, expect, test } from "bun:test";
import { extractResponse } from "@/agent/session";

describe("extractResponse", () => {
  test("extracts text from success result", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", result: "Hello from Claude" },
    ];
    const result = extractResponse(messages as any);
    expect(result.sessionId).toBe("sess-1");
    expect(result.responseText).toBe("Hello from Claude");
  });

  test("returns empty string when no result", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-2" },
    ];
    const result = extractResponse(messages as any);
    expect(result.sessionId).toBe("sess-2");
    expect(result.responseText).toBe("");
  });
});
