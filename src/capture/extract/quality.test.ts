import { describe, expect, test } from "bun:test";
import { checkContentQuality } from "./quality";

describe("checkContentQuality", () => {
  test("passes content with enough text", () => {
    const content = "A".repeat(250);
    expect(checkContentQuality(content)).toBe(true);
  });

  test("fails content with too little text", () => {
    expect(checkContentQuality("short")).toBe(false);
  });

  test("fails empty content", () => {
    expect(checkContentQuality("")).toBe(false);
  });

  test("strips nav/header text before checking", () => {
    const navOnly = "<nav>Home About Contact</nav>";
    expect(checkContentQuality(navOnly)).toBe(false);
  });
});
