import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createWorkspacesRoutes } from "@/routes/workspaces";

describe("GET /", () => {
  test("returns array of workspace directories", async () => {
    const app = new Hono();
    app.route("/api/workspaces", createWorkspacesRoutes());
    const res = await app.request("/api/workspaces");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.workspaces)).toBe(true);
    if (body.workspaces.length > 0) {
      expect(body.workspaces[0]).toHaveProperty("name");
      expect(body.workspaces[0]).toHaveProperty("path");
    }
  });
});
