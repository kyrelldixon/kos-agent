import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ChannelsConfig } from "@/lib/channels";
import { loadConfig, updateConfig } from "@/lib/channels";
import { createConfigRoutes } from "@/routes/config";

let originalConfig: ChannelsConfig;

beforeAll(async () => {
  originalConfig = await loadConfig();
});

afterAll(async () => {
  await updateConfig(originalConfig);
});

describe("GET /", () => {
  test("returns current config", async () => {
    const app = new Hono();
    app.route("/api/config", createConfigRoutes());
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("displayMode");
    expect(body).toHaveProperty("allowedUsers");
    expect(body).toHaveProperty("globalDefault");
  });
});

describe("PATCH /", () => {
  test("rejects invalid displayMode", async () => {
    const app = new Hono();
    app.route("/api/config", createConfigRoutes());
    const res = await app.request("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayMode: "banana" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid allowedUsers type", async () => {
    const app = new Hono();
    app.route("/api/config", createConfigRoutes());
    const res = await app.request("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedUsers: 42 }),
    });
    expect(res.status).toBe(400);
  });

  test("updates valid fields", async () => {
    const app = new Hono();
    app.route("/api/config", createConfigRoutes());
    const res = await app.request("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayMode: "verbose" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayMode).toBe("verbose");
  });
});
