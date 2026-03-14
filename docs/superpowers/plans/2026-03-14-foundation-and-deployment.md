# Foundation & Mac Mini Deployment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy kos-agent to the Mac Mini as an always-on system, with data at `~/.kos/agent/`, REST API for config, GitHub webhook deploys, and Cloudflare Tunnel access.

**Architecture:** Data moves from repo to `~/.kos/agent/`. Hono gets REST endpoints for config and workspace discovery behind Cloudflare Access middleware. Three LaunchDaemons (kos-agent, Inngest dev server, restarter) persist the services. GitHub webhook triggers deploys. All services bind to localhost; Cloudflare Tunnel provides external access.

**Tech Stack:** Bun, Hono, Inngest, Slack Bolt, varlock + 1Password, LaunchDaemons, Cloudflare Tunnel

**Spec:** `docs/superpowers/specs/2026-03-14-foundation-and-deployment-design.md`

---

## File Structure

### Modified files

| File | Responsibility | Changes |
|------|---------------|---------|
| `src/lib/channels.ts` | Channel config management | New path (`~/.kos/agent/channels.json`), new interface (drop `workspaces`, add `scanRoots`), new defaults (`compact`, `*`), add `updateConfig()`, add `scanWorkspaces()` |
| `src/lib/sessions.ts` | Session persistence | New path (`~/.kos/agent/sessions`) |
| `src/lib/channels.test.ts` | Channel config tests | Update for new defaults and interface |
| `src/lib/sessions.test.ts` | Session persistence tests | Update path constant, use temp dir |
| `src/bolt/listeners/onboarding.ts` | Slack channel onboarding | Use `scanWorkspaces()` instead of `getWorkspaces()` |
| `src/index.ts` | Entry point | Mount new routes, ensure dirs on startup, bind to `127.0.0.1` |
| `.env.schema` | Environment variable schema | Add `OP_TOKEN`, update `@initOp` |
| `.gitignore` | Git ignore rules | Remove `data/sessions/` |
| `package.json` | Package metadata | Rename `agent-system` → `kos-agent` |

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/middleware/access.ts` | Cloudflare Access service token validation middleware |
| `src/lib/middleware/access.test.ts` | Tests for access middleware |
| `src/routes/config.ts` | GET/PATCH `/api/config` endpoints |
| `src/routes/config.test.ts` | Tests for config routes |
| `src/routes/workspaces.ts` | GET `/api/workspaces` endpoint |
| `src/routes/workspaces.test.ts` | Tests for workspaces route |
| `src/routes/hooks.ts` | POST `/api/hooks/deploy` webhook endpoint |
| `src/routes/hooks.test.ts` | Tests for deploy webhook |
| `src/lib/deploy/verify-signature.ts` | HMAC-SHA256 GitHub webhook signature verification |
| `src/lib/deploy/verify-signature.test.ts` | Tests for signature verification |
| `src/lib/deploy/secret.ts` | Auto-generate deploy secret on first run |
| `src/lib/deploy/secret.test.ts` | Tests for deploy secret |
| `ops/com.kyrelldixon.kos-agent.plist` | LaunchDaemon for kos-agent |
| `ops/com.kyrelldixon.inngest-dev.plist` | LaunchDaemon for Inngest dev server |
| `ops/com.kyrelldixon.kos-agent-restarter.plist` | LaunchDaemon for WatchPaths restarter |
| `deploy.sh` | Deploy script (install + update modes) |
| `restart-kos-agent.sh` | Restart trigger script |

### Deleted files

| File | Reason |
|------|--------|
| `data/channels.json` | State moves to `~/.kos/agent/channels.json` |
| `data/sessions/*.json` | State moves to `~/.kos/agent/sessions/` |

---

## Chunk 1: Data Migration & Config Refactor

### Task 1: Update channels.ts — paths, interface, defaults

**Files:**
- Modify: `src/lib/channels.ts`

- [ ] **Step 1: Update the file path constant and interface**

Replace the entire `src/lib/channels.ts` with updated paths, interface, and defaults. Key changes:
- `CHANNELS_FILE` → `join(homedir(), ".kos/agent/channels.json")`
- Drop `workspaces` from `ChannelsConfig`, add `scanRoots`
- Default `displayMode` → `"compact"`, `allowedUsers` → `"*"`
- Add `updateConfig()` for PATCH support
- Add `scanWorkspaces()` for dynamic directory scanning
- Remove `getWorkspaces()`

```typescript
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHANNELS_FILE = join(homedir(), ".kos/agent/channels.json");
const GLOBAL_DEFAULT = join(homedir(), "projects/kyrell-os");

interface ChannelData {
  workspace: string;
  onboardedAt: string;
}

export interface ChannelsConfig {
  displayMode?: "verbose" | "compact" | "minimal";
  allowedUsers: string | string[];
  channels: Record<string, ChannelData>;
  scanRoots: string[];
  globalDefault: string;
}

const DEFAULT_CONFIG: ChannelsConfig = {
  displayMode: "compact",
  allowedUsers: "*",
  channels: {},
  scanRoots: ["~/projects"],
  globalDefault: "~/projects/kyrell-os",
};

export async function loadConfig(): Promise<ChannelsConfig> {
  const file = Bun.file(CHANNELS_FILE);
  if (!(await file.exists())) {
    return { ...DEFAULT_CONFIG };
  }
  return file.json();
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function isUserAllowed(userId: string): Promise<boolean> {
  const config = await loadConfig();
  if (config.allowedUsers === "*") return true;
  return (
    Array.isArray(config.allowedUsers) && config.allowedUsers.includes(userId)
  );
}

export async function resolveWorkspace(channelId: string): Promise<string> {
  const config = await loadConfig();
  const channel = config.channels[channelId];
  const workspace =
    channel?.workspace ?? config.globalDefault ?? GLOBAL_DEFAULT;
  return expandHome(workspace);
}

export async function saveChannelWorkspace(
  channelId: string,
  workspace: string,
): Promise<void> {
  const config = await loadConfig();
  config.channels[channelId] = {
    workspace,
    onboardedAt: new Date().toISOString(),
  };
  await Bun.write(CHANNELS_FILE, JSON.stringify(config, null, 2));
}

export async function getGlobalDefault(): Promise<string> {
  const config = await loadConfig();
  return expandHome(config.globalDefault ?? "~/projects/kyrell-os");
}

export async function getDisplayMode(): Promise<
  "verbose" | "compact" | "minimal"
> {
  const config = await loadConfig();
  return config.displayMode ?? "compact";
}

export async function updateConfig(
  updates: Partial<Pick<ChannelsConfig, "displayMode" | "allowedUsers" | "globalDefault" | "scanRoots">>,
): Promise<ChannelsConfig> {
  const config = await loadConfig();
  if (updates.displayMode !== undefined) config.displayMode = updates.displayMode;
  if (updates.allowedUsers !== undefined) config.allowedUsers = updates.allowedUsers;
  if (updates.globalDefault !== undefined) config.globalDefault = updates.globalDefault;
  if (updates.scanRoots !== undefined) config.scanRoots = updates.scanRoots;
  await Bun.write(CHANNELS_FILE, JSON.stringify(config, null, 2));
  return config;
}

export async function scanWorkspaces(): Promise<
  { name: string; path: string }[]
> {
  const config = await loadConfig();
  const roots = config.scanRoots ?? ["~/projects"];
  const directories: { name: string; path: string }[] = [];

  for (const root of roots) {
    const expanded = expandHome(root);
    try {
      const entries = await readdir(expanded, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        directories.push({
          name: entry.name,
          path: join(expanded, entry.name),
        });
      }
    } catch {
      // Skip unreadable roots
    }
  }

  return directories.sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 2: Do not commit yet — continue to Task 2**

### Task 2: Update sessions.ts — new path

**Files:**
- Modify: `src/lib/sessions.ts`

- [ ] **Step 1: Update the path constant**

Change line 3 of `src/lib/sessions.ts`:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".kos/agent/sessions");

interface SessionData {
  sessionId?: string;
  workspace?: string;
  updatedAt: string;
}

export async function getSession(
  sessionKey: string,
): Promise<SessionData | undefined> {
  const file = Bun.file(join(SESSIONS_DIR, `${sessionKey}.json`));
  if (!(await file.exists())) return undefined;
  return file.json();
}

export async function saveSession(
  sessionKey: string,
  data: Partial<SessionData>,
): Promise<void> {
  const existing = (await getSession(sessionKey)) ?? {};
  await Bun.write(
    join(SESSIONS_DIR, `${sessionKey}.json`),
    JSON.stringify(
      { ...existing, ...data, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}
```

- [ ] **Step 2: Do not commit yet — continue to Task 3**

### Task 3: Update tests (ships with Tasks 1-2 as atomic commit)

**Files:**
- Modify: `src/lib/channels.test.ts`
- Modify: `src/lib/sessions.test.ts`

- [ ] **Step 1: Ensure data directories exist**

Run: `mkdir -p ~/.kos/agent/sessions`

- [ ] **Step 2: Update channels.test.ts**

The tests now read from `~/.kos/agent/channels.json`. With the new defaults (`allowedUsers: "*"`, `displayMode: "compact"`), update accordingly:

```typescript
import { describe, expect, test } from "bun:test";
import {
  getDisplayMode,
  isUserAllowed,
  resolveWorkspace,
  scanWorkspaces,
  updateConfig,
} from "@/lib/channels";

describe("isUserAllowed", () => {
  test("allows all users when allowedUsers is '*'", async () => {
    const result = await isUserAllowed("U_ANY_USER");
    expect(result).toBe(true);
  });
});

describe("resolveWorkspace", () => {
  test("returns global default for unknown channel", async () => {
    const result = await resolveWorkspace("C_UNKNOWN_CHANNEL");
    expect(result).toContain("projects/kyrell-os");
  });
});

describe("getDisplayMode", () => {
  test("returns display mode from config", async () => {
    const result = await getDisplayMode();
    expect(["verbose", "compact", "minimal"]).toContain(result);
  });
});

describe("scanWorkspaces", () => {
  test("returns array of directories", async () => {
    const result = await scanWorkspaces();
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0]).toHaveProperty("name");
      expect(result[0]).toHaveProperty("path");
    }
  });
});
```

- [ ] **Step 2: Update sessions.test.ts**

Update to use the new path and clean up properly:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSession, saveSession } from "@/lib/sessions";

const TEST_KEY = "test-session-unit";
const SESSIONS_DIR = join(homedir(), ".kos/agent/sessions");

describe("sessions", () => {
  afterEach(async () => {
    await unlink(join(SESSIONS_DIR, `${TEST_KEY}.json`)).catch(() => {});
  });

  test("getSession returns undefined for missing session", async () => {
    const result = await getSession("nonexistent-key-xyz");
    expect(result).toBeUndefined();
  });

  test("saveSession and getSession roundtrip", async () => {
    await saveSession(TEST_KEY, { sessionId: "abc-123" });
    const result = await getSession(TEST_KEY);
    expect(result?.sessionId).toBe("abc-123");
    expect(result?.updatedAt).toBeDefined();
  });

  test("saveSession merges with existing data", async () => {
    await saveSession(TEST_KEY, { sessionId: "abc-123" });
    await saveSession(TEST_KEY, { workspace: "~/projects/foo" });
    const result = await getSession(TEST_KEY);
    expect(result?.sessionId).toBe("abc-123");
    expect(result?.workspace).toBe("~/projects/foo");
  });
});
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit Tasks 1-3 atomically**

```bash
git add src/lib/channels.ts src/lib/sessions.ts src/lib/channels.test.ts src/lib/sessions.test.ts
git commit -m "refactor: move data to ~/.kos/agent/, dynamic workspace scanning, new defaults"
```

### Task 4: Update onboarding to use dynamic workspace scanning

**Files:**
- Modify: `src/bolt/listeners/onboarding.ts`

- [ ] **Step 1: Replace getWorkspaces with scanWorkspaces**

```typescript
import type { App } from "@slack/bolt";
import { getGlobalDefault, scanWorkspaces } from "@/lib/channels";

export function registerOnboardingListeners(app: App) {
  app.event("member_joined_channel", async ({ event, client }) => {
    const botInfo = await client.auth.test();
    if (event.user !== botInfo.user_id) return;

    const workspaces = await scanWorkspaces();
    const globalDefault = await getGlobalDefault();

    await client.chat.postMessage({
      channel: event.channel,
      text: `I'm set up to work in \`${globalDefault}\`. Change it below if needed.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `I'm set up to work in \`${globalDefault}\`. Change it below if needed.`,
          },
          accessory: {
            type: "static_select",
            action_id: "channel_workspace_select",
            initial_option: {
              text: { type: "plain_text", text: "kyrell-os" },
              value: globalDefault,
            },
            options: workspaces.map((ws) => ({
              text: { type: "plain_text", text: ws.name },
              value: ws.path,
            })),
          },
        },
      ],
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bolt/listeners/onboarding.ts
git commit -m "refactor(onboarding): use dynamic workspace scanning"
```

### Task 5: Startup initialization, cleanup, rename

**Files:**
- Modify: `src/index.ts`
- Modify: `.gitignore`
- Modify: `package.json`
- Delete: `data/` directory

- [ ] **Step 1: Add directory initialization to index.ts**

Add at the top of `src/index.ts`, after imports:

```typescript
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Ensure data directories exist
await mkdir(join(homedir(), ".kos/agent/sessions"), { recursive: true });
```

- [ ] **Step 2: Update .gitignore**

Remove the `data/sessions/` line. Keep `data/` in `.gitignore` is unnecessary since we're deleting it, but remove the specific line:

Remove line 10: `data/sessions/`

- [ ] **Step 3: Update package.json name**

Change `"name": "agent-system"` to `"name": "kos-agent"` in `package.json`.

- [ ] **Step 4: Delete data directory**

```bash
rm -rf data/
```

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/index.ts .gitignore package.json
git rm -r data/
git commit -m "chore: startup dir init, remove data/ from repo, rename to kos-agent"
```

---

## Chunk 2: API Layer

### Task 6: Cloudflare Access middleware

**Files:**
- Create: `src/lib/middleware/access.ts`
- Create: `src/lib/middleware/access.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/middleware/access.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/middleware/access.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/middleware/access.ts
import type { Context, Next } from "hono";

export function cfAccessMiddleware(expectedClientId: string) {
  return async (c: Context, next: Next) => {
    const clientId = c.req.header("CF-Access-Client-Id");
    if (clientId !== expectedClientId) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/middleware/access.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/middleware/access.ts src/lib/middleware/access.test.ts
git commit -m "feat: Cloudflare Access service token middleware"
```

### Task 7: Config routes (GET/PATCH)

**Files:**
- Create: `src/routes/config.ts`
- Create: `src/routes/config.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/routes/config.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createConfigRoutes } from "@/routes/config";
import { loadConfig, updateConfig } from "@/lib/channels";

// Tests run against real ~/.kos/agent/channels.json — restore original after
let originalConfig: Awaited<ReturnType<typeof loadConfig>>;

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/routes/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/routes/config.ts
import { Hono } from "hono";
import { loadConfig, updateConfig } from "@/lib/channels";

const VALID_DISPLAY_MODES = ["verbose", "compact", "minimal"];

export function createConfigRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const config = await loadConfig();
    return c.json(config);
  });

  app.patch("/", async (c) => {
    const body = await c.req.json();
    const errors: string[] = [];

    if (body.displayMode !== undefined) {
      if (!VALID_DISPLAY_MODES.includes(body.displayMode)) {
        errors.push(`displayMode must be one of: ${VALID_DISPLAY_MODES.join(", ")}`);
      }
    }

    if (body.allowedUsers !== undefined) {
      if (body.allowedUsers !== "*" && !Array.isArray(body.allowedUsers)) {
        errors.push('allowedUsers must be "*" or string[]');
      }
    }

    if (body.globalDefault !== undefined) {
      if (typeof body.globalDefault !== "string") {
        errors.push("globalDefault must be a string");
      }
    }

    if (body.scanRoots !== undefined) {
      if (!Array.isArray(body.scanRoots)) {
        errors.push("scanRoots must be string[]");
      }
    }

    if (errors.length > 0) {
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const updated = await updateConfig(body);
    return c.json(updated);
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/routes/config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/routes/config.ts src/routes/config.test.ts
git commit -m "feat: GET/PATCH /api/config endpoints with validation"
```

### Task 8: Workspaces route

**Files:**
- Create: `src/routes/workspaces.ts`
- Create: `src/routes/workspaces.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/routes/workspaces.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/routes/workspaces.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/routes/workspaces.ts
import { Hono } from "hono";
import { scanWorkspaces } from "@/lib/channels";

export function createWorkspacesRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const workspaces = await scanWorkspaces();
    return c.json({ workspaces });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/routes/workspaces.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/workspaces.ts src/routes/workspaces.test.ts
git commit -m "feat: GET /api/workspaces with dynamic directory scanning"
```

### Task 9: Deploy signature verification

**Files:**
- Create: `src/lib/deploy/verify-signature.ts`
- Create: `src/lib/deploy/verify-signature.test.ts`

Ported from: `/Users/kyrelldixon/projects/agent-platform/server/deploy/verify-signature.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/deploy/verify-signature.test.ts
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyGitHubSignature } from "@/lib/deploy/verify-signature";

const SECRET = "test-secret-123";

function sign(body: string): string {
  const hmac = createHmac("sha256", SECRET).update(body).digest("hex");
  return `sha256=${hmac}`;
}

describe("verifyGitHubSignature", () => {
  test("returns true for valid signature", () => {
    const body = '{"ref":"refs/heads/main"}';
    expect(verifyGitHubSignature(SECRET, body, sign(body))).toBe(true);
  });

  test("returns false for missing signature", () => {
    expect(verifyGitHubSignature(SECRET, "{}", undefined)).toBe(false);
  });

  test("returns false for invalid signature", () => {
    expect(verifyGitHubSignature(SECRET, "{}", "sha256=bad")).toBe(false);
  });

  test("returns false for wrong prefix", () => {
    expect(verifyGitHubSignature(SECRET, "{}", "md5=abc")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/deploy/verify-signature.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/deploy/verify-signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature(
  secret: string,
  body: string,
  signature: string | undefined,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const received = signature.slice("sha256=".length);

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/deploy/verify-signature.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/deploy/verify-signature.ts src/lib/deploy/verify-signature.test.ts
git commit -m "feat: GitHub webhook HMAC-SHA256 signature verification"
```

### Task 10: Deploy secret utility

**Files:**
- Create: `src/lib/deploy/secret.ts`
- Create: `src/lib/deploy/secret.test.ts`

Ported from: `/Users/kyrelldixon/projects/agent-platform/server/deploy/secret.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/deploy/secret.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getOrCreateDeploySecret } from "@/lib/deploy/secret";

const TEST_PATH = join(homedir(), ".kos/agent/test-deploy-secret.txt");

describe("getOrCreateDeploySecret", () => {
  afterEach(async () => {
    await unlink(TEST_PATH).catch(() => {});
  });

  test("creates a new secret if file does not exist", async () => {
    const secret = await getOrCreateDeploySecret(TEST_PATH);
    expect(secret).toHaveLength(64); // 32 bytes hex
    const file = Bun.file(TEST_PATH);
    expect(await file.exists()).toBe(true);
  });

  test("returns existing secret if file exists", async () => {
    await Bun.write(TEST_PATH, "existing-secret-value");
    const secret = await getOrCreateDeploySecret(TEST_PATH);
    expect(secret).toBe("existing-secret-value");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/deploy/secret.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/deploy/secret.ts
import { randomBytes } from "node:crypto";

export async function getOrCreateDeploySecret(
  filePath: string,
): Promise<string> {
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return (await file.text()).trim();
  }

  const secret = randomBytes(32).toString("hex");
  await Bun.write(filePath, secret);
  return secret;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/deploy/secret.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/deploy/secret.ts src/lib/deploy/secret.test.ts
git commit -m "feat: auto-generate deploy secret for GitHub webhook"
```

### Task 11: Deploy webhook route

**Files:**
- Create: `src/routes/hooks.ts`
- Create: `src/routes/hooks.test.ts`

Ported from: `/Users/kyrelldixon/projects/agent-platform/server/deploy/routes.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/routes/hooks.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/routes/hooks.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/routes/hooks.ts
import { Hono } from "hono";
import { verifyGitHubSignature } from "@/lib/deploy/verify-signature";

interface HooksRoutesOptions {
  secret: string;
  spawnDeploy: () => { unref: () => void };
}

export function createHooksRoutes(options: HooksRoutesOptions): Hono {
  const app = new Hono();

  app.post("/deploy", async (c) => {
    const body = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");

    if (!verifyGitHubSignature(options.secret, body, signature)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    if (event !== "push") {
      return c.json({ triggered: false, reason: "not a push event" });
    }

    const payload = JSON.parse(body);
    if (payload.ref !== "refs/heads/main") {
      return c.json({ triggered: false, reason: "not main branch" });
    }

    const child = options.spawnDeploy();
    child.unref();

    return c.json({ triggered: true });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/routes/hooks.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/routes/hooks.ts src/routes/hooks.test.ts
git commit -m "feat: GitHub webhook deploy endpoint with HMAC verification"
```

### Task 12: Wire up routes in index.ts, bind to localhost

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update index.ts with all new routes**

Replace `src/index.ts` with:

```typescript
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Hono } from "hono";
import { serve } from "inngest/hono";
import { createBoltApp } from "@/bolt/app";
import { registerListeners } from "@/bolt/listeners/index";
import { inngest } from "@/inngest/client";
import {
  acknowledgeMessage,
  handleFailure,
  handleMessage,
  sendReply,
} from "@/inngest/functions/index";
import { cfAccessMiddleware } from "@/lib/middleware/access";
import { getOrCreateDeploySecret } from "@/lib/deploy/secret";
import { createConfigRoutes } from "@/routes/config";
import { createWorkspacesRoutes } from "@/routes/workspaces";
import { createHooksRoutes } from "@/routes/hooks";

// Must delete before Agent SDK query() — SDK detects Claude Code env and changes behavior.
delete process.env.CLAUDECODE;

// Ensure data directories exist
const dataDir = join(homedir(), ".kos/agent");
await mkdir(join(dataDir, "sessions"), { recursive: true });

// All Inngest functions registered
const functions = [acknowledgeMessage, handleFailure, handleMessage, sendReply];

const hono = new Hono();

// Inngest serve endpoint (no auth — localhost only, accessed by local Inngest dev server)
hono.on(
  ["GET", "POST", "PUT"],
  "/api/inngest",
  serve({ client: inngest, functions }),
);

// Health check (no auth)
hono.get("/health", (c) => c.json({ status: "ok" }));

// Deploy webhook (auth via HMAC signature, Cloudflare Access bypass)
const deploySecret = await getOrCreateDeploySecret(
  join(dataDir, "deploy-secret.txt"),
);
const repoDir = join(import.meta.dir, "..");

hono.route(
  "/api/hooks",
  createHooksRoutes({
    secret: deploySecret,
    spawnDeploy: () => {
      const logPath = join(
        homedir(),
        "Library/Logs/kos-agent-deploy.log",
      );
      const fd = openSync(logPath, "a");
      return spawn("bash", ["deploy.sh"], {
        cwd: repoDir,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    },
  }),
);

// Protected API routes (auth via Cloudflare Access service token)
// Note: hono.use("/api/config/*") does NOT match "/api/config" (no trailing segment).
// Must register middleware for both the exact path and the glob pattern.
const cfClientId = process.env.CF_ACCESS_CLIENT_ID ?? "";
if (cfClientId) {
  const accessMw = cfAccessMiddleware(cfClientId);
  hono.use("/api/config", accessMw);
  hono.use("/api/config/*", accessMw);
  hono.use("/api/workspaces", accessMw);
  hono.use("/api/workspaces/*", accessMw);
}
hono.route("/api/config", createConfigRoutes());
hono.route("/api/workspaces", createWorkspacesRoutes());

// Start HTTP server — bind to localhost only (Cloudflare Tunnel connects locally)
Bun.serve({
  port: 9080,
  hostname: "127.0.0.1",
  fetch: hono.fetch.bind(hono),
});

// Start Slack bot
const bolt = createBoltApp();
registerListeners(bolt, inngest);
await bolt.start();

console.log("kos-agent running — Hono :9080, Bolt Socket Mode, Inngest");
```

- [ ] **Step 2: Add CF_ACCESS_CLIENT_ID to .env.schema**

Add to `.env.schema` after the existing secrets:

```
# Cloudflare Access service token client ID (empty in dev, skips auth)
CF_ACCESS_CLIENT_ID=
```

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/index.ts .env.schema
git commit -m "feat: wire up API routes, deploy webhook, localhost binding"
```

---

## Chunk 3: Deployment Infrastructure

### Task 13: LaunchDaemon plists

**Files:**
- Create: `ops/com.kyrelldixon.kos-agent.plist`
- Create: `ops/com.kyrelldixon.inngest-dev.plist`
- Create: `ops/com.kyrelldixon.kos-agent-restarter.plist`

- [ ] **Step 1: Create kos-agent plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kyrelldixon.kos-agent</string>
    <key>UserName</key>
    <string>kyrelldixon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>run</string>
        <string>src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/kyrelldixon/projects/kos-agent</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>9080</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>INNGEST_DEV</key>
        <string>1</string>
        <key>OP_TOKEN</key>
        <string>REPLACE_WITH_SERVICE_ACCOUNT_TOKEN</string>
        <key>CF_ACCESS_CLIENT_ID</key>
        <string>REPLACE_WITH_CF_ACCESS_CLIENT_ID</string>
        <key>HOME</key>
        <string>/Users/kyrelldixon</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/kyrelldixon/Library/Logs/kos-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/kyrelldixon/Library/Logs/kos-agent.err</string>
</dict>
</plist>
```

**IMPORTANT:** After copying to `/Library/LaunchDaemons/`, replace `REPLACE_WITH_SERVICE_ACCOUNT_TOKEN` with the actual 1Password service account token, then `sudo chmod 600` the file. Never commit the real token.

- [ ] **Step 2: Create Inngest dev server plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kyrelldixon.inngest-dev</string>
    <key>UserName</key>
    <string>kyrelldixon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/inngest-cli</string>
        <string>dev</string>
        <string>--no-discovery</string>
        <string>-u</string>
        <string>http://localhost:9080/api/inngest</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/kyrelldixon</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>/Users/kyrelldixon/Library/Logs/inngest-dev.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/kyrelldixon/Library/Logs/inngest-dev.err</string>
</dict>
</plist>
```

- [ ] **Step 3: Create restarter plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kyrelldixon.kos-agent-restarter</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/kyrelldixon/projects/kos-agent/restart-kos-agent.sh</string>
    </array>
    <key>WatchPaths</key>
    <array>
        <string>/private/tmp/kos-agent-restart-trigger</string>
    </array>
    <key>StandardOutPath</key>
    <string>/Users/kyrelldixon/Library/Logs/kos-agent-restarter.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/kyrelldixon/Library/Logs/kos-agent-restarter.err</string>
</dict>
</plist>
```

Note: Restarter intentionally omits `UserName` — runs as root because `launchctl kickstart -k system/...` requires root.

- [ ] **Step 4: Commit**

```bash
git add ops/
git commit -m "ops: LaunchDaemon plists for kos-agent, inngest-dev, restarter"
```

### Task 14: Deploy script and restart script

**Files:**
- Create: `deploy.sh`
- Create: `restart-kos-agent.sh`

- [ ] **Step 1: Create restart script**

```bash
#!/bin/bash
# Restart kos-agent LaunchDaemon
# Triggered by launchd WatchPaths — runs as root, no sudo needed
set -euo pipefail

launchctl kickstart -k system/com.kyrelldixon.kos-agent
```

- [ ] **Step 2: Create deploy script**

```bash
#!/bin/bash
# Deploy kos-agent to the local machine
# Usage: bash deploy.sh [--install]
#   --install  First-time setup: copy plists + bootstrap services
#   (default)  Update: pull, build, restart
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Service definitions
KA_PLIST_NAME="com.kyrelldixon.kos-agent"
KA_PLIST_SRC="$REPO_DIR/ops/$KA_PLIST_NAME.plist"
KA_PLIST_DST="/Library/LaunchDaemons/$KA_PLIST_NAME.plist"
KA_SERVICE="system/$KA_PLIST_NAME"

IN_PLIST_NAME="com.kyrelldixon.inngest-dev"
IN_PLIST_SRC="$REPO_DIR/ops/$IN_PLIST_NAME.plist"
IN_PLIST_DST="/Library/LaunchDaemons/$IN_PLIST_NAME.plist"
IN_SERVICE="system/$IN_PLIST_NAME"

RS_PLIST_NAME="com.kyrelldixon.kos-agent-restarter"
RS_PLIST_SRC="$REPO_DIR/ops/$RS_PLIST_NAME.plist"
RS_PLIST_DST="/Library/LaunchDaemons/$RS_PLIST_NAME.plist"
RS_SERVICE="system/$RS_PLIST_NAME"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }
step()  { echo -e "\n${BOLD}==> $1${NC}"; }

check_prereqs() {
  command -v bun &>/dev/null || error "bun not found."
  command -v inngest-cli &>/dev/null || error "inngest-cli not found. Install with: brew install inngest/tap/inngest"
  command -v git &>/dev/null || error "git not found."

  info "bun: $(which bun)"
  info "inngest-cli: $(which inngest-cli)"
}

build() {
  step "Updating kos-agent"
  cd "$REPO_DIR"

  info "Pulling latest..."
  git pull --ff-only

  info "Installing dependencies..."
  bun install
}

install_plist() {
  local name="$1" src="$2" dst="$3" service="$4"

  if [[ ! -f "$src" ]]; then
    error "Plist not found at $src"
  fi

  # Bootout if already loaded (ignore errors)
  sudo launchctl bootout "$service" 2>/dev/null || true

  info "Copying $name plist to $dst"
  sudo cp "$src" "$dst"
  sudo chown root:wheel "$dst"
  sudo chmod 600 "$dst"

  info "Bootstrapping $name..."
  sudo launchctl bootstrap system "$dst"
}

install_services() {
  step "Installing LaunchDaemons"
  mkdir -p "$HOME/Library/Logs"
  mkdir -p "$HOME/.kos/agent/sessions"

  install_plist "kos-agent" "$KA_PLIST_SRC" "$KA_PLIST_DST" "$KA_SERVICE"
  install_plist "inngest-dev" "$IN_PLIST_SRC" "$IN_PLIST_DST" "$IN_SERVICE"
  install_plist "restarter" "$RS_PLIST_SRC" "$RS_PLIST_DST" "$RS_SERVICE"

  info "Services installed"
}

trigger_restart() {
  step "Triggering restart"
  touch /private/tmp/kos-agent-restart-trigger
  info "Restart triggered (WatchPaths)"
}

main() {
  echo ""
  echo "  kos-agent deploy"
  echo "  ================"
  echo ""

  check_prereqs

  local install=false
  for arg in "$@"; do
    case "$arg" in
      --install) install=true ;;
    esac
  done

  build

  if [[ "$install" == true ]]; then
    install_services
  fi

  trigger_restart
}

main "$@"
```

- [ ] **Step 3: Make scripts executable**

```bash
chmod +x deploy.sh restart-kos-agent.sh
```

- [ ] **Step 4: Commit**

```bash
git add deploy.sh restart-kos-agent.sh
git commit -m "ops: deploy script and restart trigger"
```

### Task 15: Update .env.schema for production

**Files:**
- Modify: `.env.schema`

- [ ] **Step 1: Update the schema**

Replace `.env.schema` with:

```
# This env file uses @env-spec - see https://varlock.dev/env-spec for more info
#
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(dev), account=my)
# @defaultRequired=infer @defaultSensitive=false
# @generateTypes(lang=ts, path=env.d.ts)
# ---

# 1Password service account token (production only, empty in dev)
# @type=opServiceAccountToken @sensitive
OP_TOKEN=

# Slack bot OAuth token
# @required @sensitive
SLACK_BOT_TOKEN=op("op://Developer/GTM Agent Slack bot/SLACK_BOT_TOKEN")

# Slack app-level token for Socket Mode
# @required @sensitive
SLACK_APP_TOKEN=op("op://Developer/GTM Agent Slack bot/SLACK_APP_LEVEL_TOKEN")

# Slack signing secret
# @required @sensitive
SLACK_SIGNING_SECRET=op("op://Developer/GTM Agent Slack bot/SIGNING SECRET")

# Path to Obsidian vault
VAULT_PATH=~/kyrell-os-vault

# Cloudflare Access service token client ID (empty in dev, skips auth)
CF_ACCESS_CLIENT_ID=
```

- [ ] **Step 2: Verify varlock still works locally**

Run: `bunx varlock run -- echo "Secrets loaded successfully"`
Expected: Biometric prompt, then "Secrets loaded successfully"

- [ ] **Step 3: Commit**

```bash
git add .env.schema
git commit -m "chore: update env schema for production service account + CF Access"
```

### Task 16: Run full test suite and final verification

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Run linter**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 3: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Verify local dev still works**

Run: `bun run dev`
Expected: kos-agent starts, Hono on :9080, Bolt Socket Mode connected

Test endpoints locally (no auth in dev since `CF_ACCESS_CLIENT_ID` is empty):
```bash
curl http://localhost:9080/health
curl http://localhost:9080/api/config
curl http://localhost:9080/api/workspaces
```

- [ ] **Step 5: Commit any fixes**

If any issues found, fix and commit.

---

## Post-Plan: Mac Mini Deployment Steps

These are manual steps performed on the Mac Mini after the code is pushed. Not automated by subagents.

1. **Create 1Password service account** — web UI, grant access to Developer vault
2. **SSH to Mac Mini** — `ssh kyrelldixon@mac-mini` (via Tailscale)
3. **Clone repo** — `git clone <repo-url> ~/projects/kos-agent`
4. **Install deps** — `cd ~/projects/kos-agent && bun install`
5. **Edit kos-agent plist** — replace `REPLACE_WITH_SERVICE_ACCOUNT_TOKEN` with actual token
6. **Set CF_ACCESS_CLIENT_ID** — add to kos-agent plist if Cloudflare Access service token is set up
7. **Run install** — `bash deploy.sh --install`
8. **Update Cloudflare Tunnel config** — edit `~/.cloudflared/config.yml`, add ingress rules
9. **Route DNS** — `cloudflared tunnel route dns 4aac80e6 kos.kyrelldixon.com && cloudflared tunnel route dns 4aac80e6 inngest.kyrelldixon.com`
10. **Restart cloudflared** — `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`
11. **Configure Cloudflare Access** — Zero Trust dashboard, create access policies
12. **Set up GitHub webhook** — repo settings, payload URL, copy deploy secret
13. **Validate** — DM bot from phone, check Inngest dashboard, test API endpoints
