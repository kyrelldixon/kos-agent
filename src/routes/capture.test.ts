import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createCaptureRoutes } from "./capture";

describe("capture API", () => {
  // Mock inngest.send to capture emitted events
  const sentEvents: unknown[] = [];
  const mockInngest = {
    send: mock(async (events: unknown) => {
      sentEvents.push(events);
    }),
  };

  const app = new Hono();
  app.route("/api/capture", createCaptureRoutes(mockInngest as never));

  test("POST /api/capture with URLs returns 202", async () => {
    sentEvents.length = 0;
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: ["https://example.com"] }),
    });
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.captured).toHaveLength(1);
    expect(data.captured[0].captureKey).toBe("https://example.com");
  });

  test("POST /api/capture with filePath returns 202", async () => {
    sentEvents.length = 0;
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "/Users/me/doc.md" }),
    });
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.captured).toHaveLength(1);
    expect(data.captured[0].filePath).toBe("/Users/me/doc.md");
  });

  test("POST /api/capture rejects empty body", async () => {
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/capture rejects both urls and filePath", async () => {
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls: ["https://example.com"],
        filePath: "/Users/me/doc.md",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/capture respects mode flag", async () => {
    sentEvents.length = 0;
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: ["https://example.com"], mode: "full" }),
    });
    expect(res.status).toBe(202);
  });
});
