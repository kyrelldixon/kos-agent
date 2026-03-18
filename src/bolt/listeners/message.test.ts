import { describe, expect, test } from "bun:test";
import { buildEventData } from "@/bolt/listeners/message";

describe("buildEventData", () => {
  test("uses threadTs when provided", () => {
    const data = buildEventData("C123", "hello", "1234.5678", "1111.2222");
    expect(data.sessionKey).toBe("slack-C123-1111.2222");
    expect(data.destination.threadId).toBe("1111.2222");
    expect(data.destination.messageId).toBe("1234.5678");
  });

  test("uses ts as threadId when no threadTs", () => {
    const data = buildEventData("C123", "hello", "1234.5678");
    expect(data.sessionKey).toBe("slack-C123-1234.5678");
    expect(data.destination.threadId).toBe("1234.5678");
  });

  test("sets channel to slack", () => {
    const data = buildEventData("C123", "hello", "1234.5678");
    expect(data.channel).toBe("slack");
  });
});
