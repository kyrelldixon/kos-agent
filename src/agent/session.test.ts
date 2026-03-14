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

  test("returns empty string when no result and no assistant text", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-2" },
    ];
    const result = extractResponse(messages as any);
    expect(result.sessionId).toBe("sess-2");
    expect(result.responseText).toBe("");
  });

  test("falls back to assistant text when result is empty", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-3" },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Here is what I found" }],
        },
      },
      { type: "result", subtype: "success", result: "" },
    ];
    const result = extractResponse(messages as any);
    expect(result.responseText).toBe("Here is what I found");
  });

  test("prefers result text over assistant text", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-4" },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "intermediate thought" }],
        },
      },
      { type: "result", subtype: "success", result: "Final answer" },
    ];
    const result = extractResponse(messages as any);
    expect(result.responseText).toBe("Final answer");
  });

  test("collects text from multiple assistant messages", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-5" },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Part one" }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", id: "1", input: {} }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Part two" }],
        },
      },
      { type: "result", subtype: "success", result: "" },
    ];
    const result = extractResponse(messages as any);
    expect(result.responseText).toBe("Part one\n\nPart two");
  });
});
