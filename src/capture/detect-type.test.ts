import { describe, expect, test } from "bun:test";
import { detectContentType } from "./detect-type";

describe("detectContentType", () => {
  test("detects youtube video from youtube.com/watch", () => {
    expect(
      detectContentType("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBe("youtube-video");
  });

  test("detects youtube video from youtu.be short link", () => {
    expect(detectContentType("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "youtube-video",
    );
  });

  test("detects youtube channel from @handle", () => {
    expect(detectContentType("https://www.youtube.com/@danielmiessler")).toBe(
      "youtube-channel",
    );
  });

  test("detects youtube channel from /c/ path", () => {
    expect(detectContentType("https://www.youtube.com/c/Fireship")).toBe(
      "youtube-channel",
    );
  });

  test("detects hacker news item", () => {
    expect(
      detectContentType("https://news.ycombinator.com/item?id=12345"),
    ).toBe("hacker-news");
  });

  test("detects twitter from x.com", () => {
    expect(detectContentType("https://x.com/user/status/123")).toBe("twitter");
  });

  test("detects twitter from twitter.com", () => {
    expect(detectContentType("https://twitter.com/user/status/123")).toBe(
      "twitter",
    );
  });

  test("defaults to article for unknown URLs", () => {
    expect(detectContentType("https://example.com/some-post")).toBe("article");
  });

  test("defaults to article for blog URLs", () => {
    expect(
      detectContentType(
        "https://developers.cloudflare.com/changelog/post/2026-03-10-br-crawl-endpoint/",
      ),
    ).toBe("article");
  });

  test("handles URLs with query params and fragments", () => {
    expect(detectContentType("https://youtube.com/watch?v=abc&t=120")).toBe(
      "youtube-video",
    );
    expect(detectContentType("https://x.com/user/status/123?s=20")).toBe(
      "twitter",
    );
    expect(
      detectContentType("https://news.ycombinator.com/item?id=12345#comments"),
    ).toBe("hacker-news");
  });
});
