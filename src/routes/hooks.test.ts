import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createHooksRoutes } from "@/routes/hooks";

const SECRET = "test-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function createTestApp() {
  const app = new Hono();
  let deployCalled = false;
  app.route(
    "/api/hooks",
    createHooksRoutes({
      secret: SECRET,
      spawnDeploy: () => {
        deployCalled = true;
        return { unref: () => {} };
      },
    }),
  );
  return { app, wasDeployCalled: () => deployCalled };
}

describe("POST /deploy", () => {
  test("rejects invalid signature", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/hooks/deploy", {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=bad",
        "x-github-event": "push",
      },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });
    expect(res.status).toBe(401);
  });

  test("ignores non-push events", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const { app } = createTestApp();
    const res = await app.request("/api/hooks/deploy", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "pull_request",
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.triggered).toBe(false);
  });

  test("ignores non-main branch", async () => {
    const body = JSON.stringify({ ref: "refs/heads/feature" });
    const { app } = createTestApp();
    const res = await app.request("/api/hooks/deploy", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "push",
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.triggered).toBe(false);
  });

  test("triggers deploy for push to main", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const { app, wasDeployCalled } = createTestApp();
    const res = await app.request("/api/hooks/deploy", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "push",
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.triggered).toBe(true);
    expect(wasDeployCalled()).toBe(true);
  });
});
