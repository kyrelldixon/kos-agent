import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createVoiceMemoRoutes } from "./voice-memo";

const CAPTURES_DIR = join(homedir(), ".kos", "agent", "captures");

interface SentEvent {
  name: string;
  data: { captureKey: string; filePath: string; fileName: string };
}

function buildApp() {
  const sentEvents: SentEvent[] = [];
  const mockInngest = {
    send: mock(async (event: SentEvent) => {
      sentEvents.push(event);
    }),
  };
  const app = new Hono();
  app.route("/api/voice-memo", createVoiceMemoRoutes(mockInngest as never));
  return { app, sentEvents };
}

function cleanupCapture(filePath: string | undefined) {
  if (!filePath) return;
  const dir = join(filePath, "..");
  if (dir.includes("voice-memo-") && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("voice-memo API (raw body)", () => {
  const captureDirs: string[] = [];

  afterEach(() => {
    while (captureDirs.length > 0) {
      const dir = captureDirs.pop();
      cleanupCapture(dir);
    }
  });

  test("POST accepts audio/x-m4a raw body and emits event", async () => {
    const { app, sentEvents } = buildApp();
    const audio = new Uint8Array([0, 1, 2, 3, 4]);

    const res = await app.request("/api/voice-memo", {
      method: "POST",
      headers: { "Content-Type": "audio/x-m4a" },
      body: audio,
    });

    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.status).toBe("accepted");
    expect(data.captureKey).toBeTruthy();
    expect(sentEvents).toHaveLength(1);

    const event = sentEvents[0];
    expect(event.name).toBe("voice.memo.detected");
    expect(event.data.fileName).toMatch(/^\d{8} \d{6}\.m4a$/);
    expect(event.data.filePath).toContain(CAPTURES_DIR);
    expect(existsSync(event.data.filePath)).toBe(true);
    captureDirs.push(event.data.filePath);
  });

  test("POST honors X-Filename override", async () => {
    const { app, sentEvents } = buildApp();
    const audio = new Uint8Array([9, 9, 9]);

    const res = await app.request("/api/voice-memo", {
      method: "POST",
      headers: {
        "Content-Type": "audio/mpeg",
        "X-Filename": "meeting-notes.mp3",
      },
      body: audio,
    });

    expect(res.status).toBe(202);
    const event = sentEvents[0];
    expect(event.data.fileName).toBe("meeting-notes.mp3");
    captureDirs.push(event.data.filePath);
  });

  test("POST rejects unsupported Content-Type with 415", async () => {
    const { app, sentEvents } = buildApp();

    const res = await app.request("/api/voice-memo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(415);
    expect(sentEvents).toHaveLength(0);
  });

  test("POST rejects missing Content-Type with 415", async () => {
    const { app, sentEvents } = buildApp();

    const res = await app.request("/api/voice-memo", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(415);
    expect(sentEvents).toHaveLength(0);
  });

  test("POST rejects empty body with 400", async () => {
    const { app, sentEvents } = buildApp();

    const res = await app.request("/api/voice-memo", {
      method: "POST",
      headers: { "Content-Type": "audio/x-m4a" },
      body: new Uint8Array(),
    });

    expect(res.status).toBe(400);
    expect(sentEvents).toHaveLength(0);
  });

  test("POST rejects X-Filename with bad extension", async () => {
    const { app, sentEvents } = buildApp();

    const res = await app.request("/api/voice-memo", {
      method: "POST",
      headers: {
        "Content-Type": "audio/x-m4a",
        "X-Filename": "notes.txt",
      },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(res.status).toBe(400);
    expect(sentEvents).toHaveLength(0);
  });
});
