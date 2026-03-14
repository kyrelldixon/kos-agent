import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { cfAccessMiddleware } from "@/lib/middleware/access";

function createTestApp(clientId: string) {
  const app = new Hono();
  app.use("/api/*", cfAccessMiddleware(clientId));
  app.get("/api/test", (c) => c.json({ ok: true }));
  return app;
}

describe("cfAccessMiddleware", () => {
  test("rejects request without CF-Access-Client-Id header", async () => {
    const app = createTestApp("expected-client-id");
    const res = await app.request("/api/test");
    expect(res.status).toBe(403);
  });

  test("rejects request with wrong CF-Access-Client-Id", async () => {
    const app = createTestApp("expected-client-id");
    const res = await app.request("/api/test", {
      headers: { "CF-Access-Client-Id": "wrong-id" },
    });
    expect(res.status).toBe(403);
  });

  test("allows request with correct CF-Access-Client-Id", async () => {
    const app = createTestApp("expected-client-id");
    const res = await app.request("/api/test", {
      headers: { "CF-Access-Client-Id": "expected-client-id" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
