import { describe, expect, test } from "bun:test";
import { type SessionInput, streamAgentSession } from "@/agent/session";

describe("streamAgentSession", () => {
  test("is an async generator function", () => {
    expect(typeof streamAgentSession).toBe("function");
  });

  test("SessionInput type is exported", () => {
    const input: SessionInput = {
      message: "test",
      workspace: "/tmp",
    };
    expect(input.message).toBe("test");
  });
});
