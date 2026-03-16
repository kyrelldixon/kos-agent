# kos jobs CLI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kos jobs list/create/delete/pause/resume` commands to the existing kos CLI with agent-first JSON output.

**Architecture:** New `jobs` subcommand in `~/.kos-kit/cli/` that wraps the kos-agent REST API. Uses a shared HTTP client that reads `api_url` from `~/.kos/config.json` and resolves CF Access credentials via varlock + 1Password for remote access. All output uses a JSON envelope (`ok`, `command`, `result`, `next_actions`).

**Tech Stack:** Bun, TypeScript, Citty, varlock + @varlock/1password-plugin

**Spec:** `docs/superpowers/specs/2026-03-16-kos-jobs-cli-design.md`

---

## File Structure

### `~/.kos-kit/cli/` (kos CLI)

| File | Responsibility |
|------|---------------|
| `src/lib/output.ts` | JSON envelope builders — `success()`, `error()`, types |
| `src/lib/api.ts` | HTTP client — reads `api_url` from config, attaches CF Access headers for remote, `get()`/`post()`/`patch()`/`del()` |
| `src/lib/config.ts` | Modified — add `api_url` field to `KosConfig` interface |
| `src/commands/jobs.ts` | Jobs subcommand — list/create/delete/pause/resume, flag parsing, JSON body construction |
| `src/index.ts` | Modified — register `jobs` subcommand |
| `.env.schema` | New — varlock schema for CF Access credentials (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET) |
| `tests/output.test.ts` | Tests for JSON envelope builders |
| `tests/api.test.ts` | Tests for HTTP client (mocked fetch) |
| `tests/jobs.test.ts` | E2E tests for jobs commands |

### `~/projects/kos-agent/` (kos-agent)

| File | Responsibility |
|------|---------------|
| `src/agent/session.ts` | Modified — swap curl templates for `kos jobs` CLI commands in system prompt |

---

## Chunk 1: JSON Envelope + Config

### Task 1: JSON Envelope Output Helpers

**Files:**
- Create: `~/.kos-kit/cli/src/lib/output.ts`
- Create: `~/.kos-kit/cli/tests/output.test.ts`

- [ ] **Step 1: Write failing tests for output helpers**

Create `~/.kos-kit/cli/tests/output.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { success, error, type NextAction } from "../src/lib/output";

describe("output helpers", () => {
	test("success returns correct envelope", () => {
		const result = success("kos jobs list", [{ name: "test-job" }], []);
		expect(result).toEqual({
			ok: true,
			command: "kos jobs list",
			result: [{ name: "test-job" }],
			next_actions: [],
		});
	});

	test("success with next_actions", () => {
		const actions: NextAction[] = [
			{
				command: "kos jobs delete <name>",
				description: "Delete a job",
				params: { name: { enum: ["test-job"] } },
			},
		];
		const result = success("kos jobs list", [], actions);
		expect(result.next_actions).toEqual(actions);
	});

	test("error returns correct envelope", () => {
		const result = error(
			"kos jobs create bad",
			"VALIDATION_ERROR",
			"Name invalid",
			"Use lowercase alphanumeric",
			[],
		);
		expect(result).toEqual({
			ok: false,
			command: "kos jobs create bad",
			error: { message: "Name invalid", code: "VALIDATION_ERROR" },
			fix: "Use lowercase alphanumeric",
			next_actions: [],
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.kos-kit/cli && bun test tests/output.test.ts`
Expected: FAIL — cannot find module `../src/lib/output`

- [ ] **Step 3: Implement output helpers**

Create `~/.kos-kit/cli/src/lib/output.ts`:

```typescript
export interface NextAction {
	command: string;
	description: string;
	params?: Record<
		string,
		{
			description?: string;
			value?: string | number;
			default?: string | number;
			enum?: string[];
			required?: boolean;
		}
	>;
}

export interface SuccessResponse {
	ok: true;
	command: string;
	result: unknown;
	next_actions: NextAction[];
}

export interface ErrorResponse {
	ok: false;
	command: string;
	error: { message: string; code: string };
	fix: string;
	next_actions: NextAction[];
}

export type CLIResponse = SuccessResponse | ErrorResponse;

export function success(
	command: string,
	result: unknown,
	next_actions: NextAction[],
): SuccessResponse {
	return { ok: true, command, result, next_actions };
}

export function error(
	command: string,
	code: string,
	message: string,
	fix: string,
	next_actions: NextAction[],
): ErrorResponse {
	return { ok: false, command, error: { message, code }, fix, next_actions };
}

/** Print a CLIResponse as JSON to stdout and exit with appropriate code. */
export function output(response: CLIResponse): never {
	console.log(JSON.stringify(response, null, 2));
	process.exit(response.ok ? 0 : 1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.kos-kit/cli && bun test tests/output.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/.kos-kit/cli
git add src/lib/output.ts tests/output.test.ts
git commit -m "feat: add JSON envelope output helpers for agent-first CLI"
```

---

### Task 2: Add `api_url` to Config

**Files:**
- Modify: `~/.kos-kit/cli/src/lib/config.ts`
- Modify: `~/.kos-kit/cli/tests/config.test.ts`

- [ ] **Step 1: Write failing test for api_url in config**

Add to `~/.kos-kit/cli/tests/config.test.ts`:

```typescript
test("config round-trip preserves api_url", async () => {
	mkdirSync(testDir, { recursive: true });
	const configPath = join(testDir, "config.json");

	const config = { name: "Test", api_url: "http://localhost:9080" };
	await Bun.write(configPath, JSON.stringify(config, null, 2));

	const loaded = await Bun.file(configPath).json();
	expect(loaded.api_url).toBe("http://localhost:9080");
});
```

- [ ] **Step 2: Run test to verify it passes** (it should already pass since config is just JSON, but confirms the field exists in our mental model)

Run: `cd ~/.kos-kit/cli && bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 3: Update KosConfig interface**

In `~/.kos-kit/cli/src/lib/config.ts`, add `api_url` to the interface:

```typescript
export interface KosConfig {
	name?: string;
	email?: string;
	github?: string;
	onboard_progress?: number;
	api_url?: string;
}
```

- [ ] **Step 4: Run all tests**

Run: `cd ~/.kos-kit/cli && bun test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd ~/.kos-kit/cli
git add src/lib/config.ts tests/config.test.ts
git commit -m "feat: add api_url field to KosConfig"
```

---

### Task 3: Auto-Detect API URL in `kos setup`

**Files:**
- Modify: `~/.kos-kit/cli/src/commands/setup.ts`

- [ ] **Step 1: Add API URL auto-detection to setup command**

In `~/.kos-kit/cli/src/commands/setup.ts`, add auto-detection after the existing config save:

```typescript
// After the existing saveConfig call, add:

// Auto-detect API URL
console.log("\nDetecting kos-agent API...");
let apiUrl = "https://kos.kyrelldixon.com";
try {
	const res = await fetch("http://localhost:9080/health", {
		signal: AbortSignal.timeout(2000),
	});
	if (res.ok) {
		apiUrl = "http://localhost:9080";
		console.log("Found local kos-agent at localhost:9080");
	}
} catch {
	console.log("No local kos-agent — using remote: https://kos.kyrelldixon.com");
}
config.api_url = apiUrl;
await saveConfig(config);
```

- [ ] **Step 2: Verify setup still works**

Run: `cd ~/.kos-kit/cli && bun run src/index.ts setup --help`
Expected: Shows setup command help

- [ ] **Step 3: Commit**

```bash
cd ~/.kos-kit/cli
git add src/commands/setup.ts
git commit -m "feat: auto-detect kos-agent API URL during setup"
```

---

## Chunk 2: HTTP Client + Varlock Auth

### Task 4: Varlock .env.schema for CF Access Credentials

**Files:**
- Create: `~/.kos-kit/cli/.env.schema`

- [ ] **Step 1: Create .env.schema**

Create `~/.kos-kit/cli/.env.schema`:

```
# This env file uses @env-spec - see https://varlock.dev/env-spec for more info
#
# @plugin(@varlock/1password-plugin)
# @currentEnv=$APP_ENV
# @initOp(allowAppAuth=true, account=my)
# @defaultRequired=infer @defaultSensitive=false
# ---

# @type=enum(dev, production)
APP_ENV=dev

# Cloudflare Access service token client ID
# @required @sensitive
CF_ACCESS_CLIENT_ID=op("op://Developer/KOS CF Access Service Token/client id")

# Cloudflare Access service token client secret
# @required @sensitive
CF_ACCESS_CLIENT_SECRET=op("op://Developer/KOS CF Access Service Token/client secret")
```

Note: The 1Password item path (`op://Developer/KOS CF Access Service Token/...`) must match the actual item in the user's 1Password vault. Verify the exact item name before first use.

- [ ] **Step 2: Add varlock as a dependency**

Run: `cd ~/.kos-kit/cli && bun add varlock @varlock/1password-plugin`

- [ ] **Step 3: Commit**

```bash
cd ~/.kos-kit/cli
git add .env.schema package.json bun.lock
git commit -m "feat: add varlock .env.schema for CF Access credentials"
```

---

### Task 5: HTTP Client with Auth

**Files:**
- Create: `~/.kos-kit/cli/src/lib/api.ts`
- Create: `~/.kos-kit/cli/tests/api.test.ts`

- [ ] **Step 1: Write failing tests for API client**

Create `~/.kos-kit/cli/tests/api.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createApiClient, type ApiClient } from "../src/lib/api";

describe("API client", () => {
	test("builds correct URL from base", async () => {
		let capturedUrl = "";
		const mockFetch = mock(async (url: string) => {
			capturedUrl = url;
			return new Response(JSON.stringify([]), { status: 200 });
		});

		const client = createApiClient("http://localhost:9080", mockFetch as any);
		await client.get("/api/jobs");
		expect(capturedUrl).toBe("http://localhost:9080/api/jobs");
	});

	test("localhost requests have no auth headers", async () => {
		let capturedInit: RequestInit = {};
		const mockFetch = mock(async (_url: string, init?: RequestInit) => {
			capturedInit = init ?? {};
			return new Response(JSON.stringify([]), { status: 200 });
		});

		const client = createApiClient("http://localhost:9080", mockFetch as any);
		await client.get("/api/jobs");
		const headers = capturedInit.headers as Record<string, string>;
		expect(headers["CF-Access-Client-Id"]).toBeUndefined();
	});

	test("post sends JSON body", async () => {
		let capturedBody = "";
		const mockFetch = mock(async (_url: string, init?: RequestInit) => {
			capturedBody = init?.body as string;
			return new Response(JSON.stringify({ name: "test" }), { status: 201 });
		});

		const client = createApiClient("http://localhost:9080", mockFetch as any);
		const body = { name: "test-job", schedule: { type: "periodic", seconds: 60 } };
		await client.post("/api/jobs", body);
		expect(JSON.parse(capturedBody)).toEqual(body);
	});

	test("del returns null body for 204", async () => {
		const mockFetch = mock(async () => {
			return new Response(null, { status: 204 });
		});

		const client = createApiClient("http://localhost:9080", mockFetch as any);
		const result = await client.del("/api/jobs/test-job");
		expect(result.status).toBe(204);
		expect(result.data).toBeNull();
	});

	test("throws on connection error", async () => {
		const mockFetch = mock(async () => {
			throw new TypeError("fetch failed");
		});

		const client = createApiClient("http://localhost:9080", mockFetch as any);
		try {
			await client.get("/api/jobs");
			expect(true).toBe(false); // should not reach
		} catch (e: any) {
			expect(e.code).toBe("CONNECTION_ERROR");
		}
	});

	test("remote URL attaches CF Access headers from resolver", async () => {
		let capturedHeaders: Record<string, string> = {};
		const mockFetch = mock(async (_url: string, init?: RequestInit) => {
			capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
			return new Response(JSON.stringify([]), { status: 200 });
		});
		const mockResolver = mock(async () => ({
			"CF-Access-Client-Id": "test-id",
			"CF-Access-Client-Secret": "test-secret",
		}));

		const client = createApiClient(
			"https://kos.kyrelldixon.com",
			mockFetch as any,
			mockResolver,
		);
		await client.get("/api/jobs");
		expect(capturedHeaders["CF-Access-Client-Id"]).toBe("test-id");
		expect(capturedHeaders["CF-Access-Client-Secret"]).toBe("test-secret");
	});

	test("throws AUTH_ERROR when credential resolver fails", async () => {
		const mockFetch = mock(async () => new Response("", { status: 200 }));
		const mockResolver = mock(async () => {
			throw new Error("1Password locked");
		});

		const client = createApiClient(
			"https://kos.kyrelldixon.com",
			mockFetch as any,
			mockResolver,
		);
		try {
			await client.get("/api/jobs");
			expect(true).toBe(false);
		} catch (e: any) {
			expect(e.code).toBe("AUTH_ERROR");
		}
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.kos-kit/cli && bun test tests/api.test.ts`
Expected: FAIL — cannot find module `../src/lib/api`

- [ ] **Step 3: Implement API client**

Create `~/.kos-kit/cli/src/lib/api.ts`:

```typescript
import { $ } from "bun";

export class ApiError extends Error {
	code: string;
	status?: number;
	constructor(code: string, message: string, status?: number) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

interface ApiResponse {
	status: number;
	data: any;
}

export interface ApiClient {
	get(path: string): Promise<ApiResponse>;
	post(path: string, body: unknown): Promise<ApiResponse>;
	patch(path: string, body: unknown): Promise<ApiResponse>;
	del(path: string): Promise<ApiResponse>;
}

type FetchFn = typeof globalThis.fetch;
type CredentialResolver = () => Promise<Record<string, string>>;

function isLocalhost(baseUrl: string): boolean {
	return baseUrl.startsWith("http://localhost");
}

export async function resolveCfAccessHeaders(): Promise<Record<string, string>> {
	try {
		const cliDir = new URL("../../", import.meta.url).pathname;
		const clientId =
			await Bun.$`bunx varlock printenv --path ${cliDir} CF_ACCESS_CLIENT_ID`
				.text()
				.then((s) => s.trim());
		const clientSecret =
			await Bun.$`bunx varlock printenv --path ${cliDir} CF_ACCESS_CLIENT_SECRET`
				.text()
				.then((s) => s.trim());

		if (!clientId || !clientSecret) {
			throw new Error("Empty credentials");
		}

		return {
			"CF-Access-Client-Id": clientId,
			"CF-Access-Client-Secret": clientSecret,
		};
	} catch {
		throw new ApiError(
			"AUTH_ERROR",
			"Could not resolve CF Access credentials",
		);
	}
}

export function createApiClient(
	baseUrl: string,
	fetchFn: FetchFn = globalThis.fetch,
	credentialResolver: CredentialResolver = resolveCfAccessHeaders,
): ApiClient {
	async function request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<ApiResponse> {
		const url = `${baseUrl}${path}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (!isLocalhost(baseUrl)) {
			try {
				const cfHeaders = await credentialResolver();
				Object.assign(headers, cfHeaders);
			} catch (e) {
				if (e instanceof ApiError) throw e;
				throw new ApiError("AUTH_ERROR", "Could not resolve CF Access credentials");
			}
		}

		let response: Response;
		try {
			response = await fetchFn(url, {
				method,
				headers,
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch {
			throw new ApiError(
				"CONNECTION_ERROR",
				`Could not connect to ${baseUrl}`,
			);
		}

		if (response.status === 204) {
			return { status: 204, data: null };
		}

		const data = await response.json();
		return { status: response.status, data };
	}

	return {
		get: (path) => request("GET", path),
		post: (path, body) => request("POST", path, body),
		patch: (path, body) => request("PATCH", path, body),
		del: (path) => request("DELETE", path),
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.kos-kit/cli && bun test tests/api.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/.kos-kit/cli
git add src/lib/api.ts tests/api.test.ts
git commit -m "feat: add HTTP API client with CF Access auth via varlock"
```

---

## Chunk 3: Jobs Commands

### Task 6: Jobs List Command

**Files:**
- Create: `~/.kos-kit/cli/src/commands/jobs.ts`
- Create: `~/.kos-kit/cli/tests/jobs.test.ts`
- Modify: `~/.kos-kit/cli/src/index.ts`

- [ ] **Step 1: Write failing test for jobs list**

Create `~/.kos-kit/cli/tests/jobs.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";
import type { ApiClient } from "../src/lib/api";
import { handleList } from "../src/commands/jobs";

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		get: mock(async () => ({ status: 200, data: [] })),
		post: mock(async () => ({ status: 201, data: {} })),
		patch: mock(async () => ({ status: 200, data: {} })),
		del: mock(async () => ({ status: 204, data: null })),
		...overrides,
	};
}

describe("jobs list", () => {
	test("returns empty list", async () => {
		const client = mockClient();
		const result = await handleList(client);
		expect(result.ok).toBe(true);
		expect(result.result).toEqual([]);
	});

	test("returns jobs with next_actions populated", async () => {
		const jobs = [
			{ name: "water-reminder", disabled: false },
			{ name: "daily-summary", disabled: true },
		];
		const client = mockClient({
			get: mock(async () => ({ status: 200, data: jobs })),
		});
		const result = await handleList(client);
		expect(result.ok).toBe(true);
		expect(result.result).toEqual(jobs);
		if (result.ok) {
			// next_actions should reference actual job names
			const deleteAction = result.next_actions.find((a) =>
				a.command.includes("delete"),
			);
			expect(deleteAction?.params?.name?.enum).toContain("water-reminder");
			expect(deleteAction?.params?.name?.enum).toContain("daily-summary");
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/.kos-kit/cli && bun test tests/jobs.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement jobs list handler**

Create `~/.kos-kit/cli/src/commands/jobs.ts`:

```typescript
import { defineCommand } from "citty";
import { loadConfig } from "../lib/config";
import { createApiClient, ApiError, type ApiClient } from "../lib/api";
import {
	success,
	error,
	output,
	type CLIResponse,
	type NextAction,
} from "../lib/output";

// --- Handlers (exported for testing) ---

export async function handleList(client: ApiClient): Promise<CLIResponse> {
	const res = await client.get("/api/jobs");
	const jobs = res.data as Array<{ name: string; disabled: boolean }>;
	const names = jobs.map((j) => j.name);

	const actions: NextAction[] = [];
	if (names.length > 0) {
		actions.push(
			{
				command: "kos jobs create <name> --schedule <type> --type <execution>",
				description: "Create a new job",
			},
			{
				command: "kos jobs delete <name>",
				description: "Delete a job",
				params: { name: { enum: names } },
			},
			{
				command: "kos jobs pause <name>",
				description: "Pause a job",
				params: {
					name: {
						enum: jobs.filter((j) => !j.disabled).map((j) => j.name),
					},
				},
			},
			{
				command: "kos jobs resume <name>",
				description: "Resume a paused job",
				params: {
					name: {
						enum: jobs.filter((j) => j.disabled).map((j) => j.name),
					},
				},
			},
		);
	} else {
		actions.push({
			command: "kos jobs create <name> --schedule <type> --type <execution>",
			description: "Create a new job",
		});
	}

	return success("kos jobs list", jobs, actions);
}

// --- Subcommands ---

const listCommand = defineCommand({
	meta: { name: "list", description: "List all scheduled jobs" },
	async run() {
		const client = await getClient();
		try {
			output(await handleList(client));
		} catch (e) {
			outputError("kos jobs list", e);
		}
	},
});

// --- Main export ---

export const jobsCommand = defineCommand({
	meta: { name: "jobs", description: "Manage scheduled jobs" },
	subCommands: {
		list: listCommand,
	},
});

// --- Helpers ---

async function getClient(): Promise<ApiClient> {
	const config = await loadConfig();
	const apiUrl = config.api_url ?? "https://kos.kyrelldixon.com";
	return createApiClient(apiUrl);
}

function outputError(command: string, e: unknown): never {
	if (e instanceof ApiError) {
		output(error(command, e.code, e.message, getFix(e.code), []));
	} else if (e instanceof ValidationError) {
		output(error(command, "VALIDATION_ERROR", e.message, e.fix, []));
	} else {
		output(error(command, "API_ERROR", String(e), "Check the server logs", []));
	}
	// Unreachable — output() calls process.exit()
	process.exit(1);
}

/** Thrown by buildCreateBody for flag validation failures */
class ValidationError extends Error {
	fix: string;
	constructor(message: string, fix: string) {
		super(message);
		this.fix = fix;
	}
}

function getFix(code: string): string {
	switch (code) {
		case "CONNECTION_ERROR":
			return "Is the kos-agent server running? Check: curl http://localhost:9080/health";
		case "AUTH_ERROR":
			return "Unlock 1Password or run: op signin";
		default:
			return "Check the server logs";
	}
}
```

- [ ] **Step 4: Register jobs subcommand in index.ts**

In `~/.kos-kit/cli/src/index.ts`, add the import and register:

```typescript
import { jobsCommand } from "./commands/jobs";
```

Add to `subCommands`:
```typescript
jobs: jobsCommand,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/.kos-kit/cli && bun test tests/jobs.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
cd ~/.kos-kit/cli
git add src/commands/jobs.ts src/index.ts tests/jobs.test.ts
git commit -m "feat: add kos jobs list command with JSON envelope output"
```

---

### Task 7: Jobs Create Command

**Files:**
- Modify: `~/.kos-kit/cli/src/commands/jobs.ts`
- Modify: `~/.kos-kit/cli/tests/jobs.test.ts`

- [ ] **Step 1: Write failing tests for jobs create**

Add to `~/.kos-kit/cli/tests/jobs.test.ts`. **Note:** All new imports must be merged with existing imports at the top of the file, not inside `describe` blocks.

Add to the top-level imports:
```typescript
import { handleList, handleCreate, buildCreateBody } from "../src/commands/jobs";
```

Then add these test blocks:

```typescript
describe("buildCreateBody", () => {
	test("builds periodic script job from flags", () => {
		const body = buildCreateBody("water-reminder", {
			schedule: "periodic",
			seconds: 120,
			type: "script",
			script: "echo drink water",
			channel: "C123",
			thread: "1234.5",
		});
		expect(body).toEqual({
			name: "water-reminder",
			schedule: { type: "periodic", seconds: 120 },
			execution: { type: "script", script: "echo drink water" },
			destination: { chatId: "C123", threadId: "1234.5" },
		});
	});

	test("builds scheduled agent job from flags", () => {
		const body = buildCreateBody("daily-summary", {
			schedule: "scheduled",
			hour: 9,
			minute: 0,
			type: "agent",
			prompt: "Summarize activity",
			channel: "C123",
		});
		expect(body).toEqual({
			name: "daily-summary",
			schedule: {
				type: "scheduled",
				calendar: { Hour: 9, Minute: 0 },
			},
			execution: { type: "agent", prompt: "Summarize activity" },
			destination: { chatId: "C123" },
		});
	});

	test("maps all calendar flags to PascalCase", () => {
		const body = buildCreateBody("full-calendar", {
			schedule: "scheduled",
			hour: 9,
			minute: 30,
			day: 15,
			weekday: 1,
			month: 3,
			type: "agent",
			prompt: "test",
			channel: "C123",
		});
		expect(body.schedule).toEqual({
			type: "scheduled",
			calendar: { Hour: 9, Minute: 30, Day: 15, Weekday: 1, Month: 3 },
		});
	});

	test("rejects --script with --type agent", () => {
		expect(() =>
			buildCreateBody("bad", {
				schedule: "periodic",
				seconds: 60,
				type: "agent",
				script: "echo hello",
				prompt: "test",
				channel: "C123",
			}),
		).toThrow();
	});

	test("rejects --prompt with --type script", () => {
		expect(() =>
			buildCreateBody("bad", {
				schedule: "periodic",
				seconds: 60,
				type: "script",
				script: "echo hello",
				prompt: "test",
				channel: "C123",
			}),
		).toThrow();
	});

	test("requires --script for script jobs", () => {
		expect(() =>
			buildCreateBody("bad", {
				schedule: "periodic",
				seconds: 60,
				type: "script",
				channel: "C123",
			}),
		).toThrow();
	});

	test("requires --prompt for agent jobs", () => {
		expect(() =>
			buildCreateBody("bad", {
				schedule: "periodic",
				seconds: 60,
				type: "agent",
				channel: "C123",
			}),
		).toThrow();
	});

	test("script with newlines survives flag round trip", () => {
		const body = buildCreateBody("test", {
			schedule: "periodic",
			seconds: 60,
			type: "script",
			script: "#!/bin/bash\necho hello\necho world",
			channel: "C123",
		});
		expect(body.execution.script).toBe("#!/bin/bash\necho hello\necho world");
	});

	test("script with quotes survives flag round trip", () => {
		const body = buildCreateBody("test", {
			schedule: "periodic",
			seconds: 60,
			type: "script",
			script: '#!/bin/bash\necho "hello world"',
			channel: "C123",
		});
		expect(body.execution.script).toBe('#!/bin/bash\necho "hello world"');
	});
});

describe("buildCreateBody --json mode", () => {
	test("parses raw JSON and injects name", () => {
		const json = '{"schedule":{"type":"periodic","seconds":60},"execution":{"type":"script","script":"echo hi"},"destination":{"chatId":"C123"}}';
		const body = buildCreateBody("my-job", { json });
		expect(body.name).toBe("my-job");
		expect(body.schedule).toEqual({ type: "periodic", seconds: 60 });
	});

	test("positional name overrides name in JSON", () => {
		const json = '{"name":"wrong","schedule":{"type":"periodic","seconds":60},"execution":{"type":"script","script":"echo hi"},"destination":{"chatId":"C123"}}';
		const body = buildCreateBody("correct-name", { json });
		expect(body.name).toBe("correct-name");
	});
});

describe("jobs create", () => {
	test("returns success envelope on 201", async () => {
		const created = {
			name: "test-job",
			schedule: { type: "periodic", seconds: 60 },
			execution: { type: "script" },
			destination: { chatId: "C123" },
			disabled: false,
			createdAt: "2026-03-16T00:00:00Z",
			updatedAt: "2026-03-16T00:00:00Z",
		};
		const client = mockClient({
			post: mock(async () => ({ status: 201, data: created })),
		});
		const body = {
			name: "test-job",
			schedule: { type: "periodic" as const, seconds: 60 },
			execution: { type: "script" as const, script: "echo hi" },
			destination: { chatId: "C123" },
		};
		const result = await handleCreate(client, "test-job", body);
		expect(result.ok).toBe(true);
		expect(result.result).toEqual(created);
	});

	test("returns CONFLICT on 409", async () => {
		const client = mockClient({
			post: mock(async () => ({
				status: 409,
				data: { error: "Job 'test-job' already exists" },
			})),
		});
		const body = {
			name: "test-job",
			schedule: { type: "periodic" as const, seconds: 60 },
			execution: { type: "script" as const, script: "echo hi" },
			destination: { chatId: "C123" },
		};
		const result = await handleCreate(client, "test-job", body);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("CONFLICT");
		}
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.kos-kit/cli && bun test tests/jobs.test.ts`
Expected: FAIL — `handleCreate` and `buildCreateBody` not exported

- [ ] **Step 3: Implement buildCreateBody and handleCreate**

Add to `~/.kos-kit/cli/src/commands/jobs.ts`:

```typescript
// --- Create body builder (exported for testing) ---

interface CreateFlags {
	schedule?: string;
	seconds?: number;
	hour?: number;
	minute?: number;
	day?: number;
	weekday?: number;
	month?: number;
	type?: string;
	script?: string;
	prompt?: string;
	channel?: string;
	thread?: string;
	json?: string;
}

export function buildCreateBody(name: string, flags: CreateFlags): any {
	// JSON mode — parse and inject name
	if (flags.json) {
		try {
			const parsed = JSON.parse(flags.json);
			return { ...parsed, name };
		} catch {
			throw new ValidationError(
				"Invalid JSON in --json flag",
				"Ensure --json value is valid JSON. Example: --json '{\"schedule\":{\"type\":\"periodic\",\"seconds\":60},...}'",
			);
		}
	}

	// Flag mode — validate and build
	if (!flags.schedule)
		throw new ValidationError("--schedule is required", "Add --schedule periodic or --schedule scheduled");
	if (!flags.type)
		throw new ValidationError("--type is required", "Add --type script or --type agent");
	if (!flags.channel)
		throw new ValidationError("--channel is required", "Add --channel <slack-channel-id>");

	// Cross-validate execution flags
	if (flags.type === "script" && flags.prompt) {
		throw new ValidationError("--prompt cannot be used with --type script", "Remove --prompt or change to --type agent");
	}
	if (flags.type === "agent" && flags.script) {
		throw new ValidationError("--script cannot be used with --type agent", "Remove --script or change to --type script");
	}
	if (flags.type === "script" && !flags.script) {
		throw new ValidationError("--script is required for script jobs", "Add --script \"<your script content>\"");
	}
	if (flags.type === "agent" && !flags.prompt) {
		throw new ValidationError("--prompt is required for agent jobs", "Add --prompt \"<what the agent should do>\"");
	}

	// Build schedule
	let schedule: any;
	if (flags.schedule === "periodic") {
		if (!flags.seconds) throw new Error("--seconds is required for periodic schedule");
		schedule = { type: "periodic", seconds: flags.seconds };
	} else if (flags.schedule === "scheduled") {
		const calendar: Record<string, number> = {};
		if (flags.hour !== undefined) calendar.Hour = flags.hour;
		if (flags.minute !== undefined) calendar.Minute = flags.minute;
		if (flags.day !== undefined) calendar.Day = flags.day;
		if (flags.weekday !== undefined) calendar.Weekday = flags.weekday;
		if (flags.month !== undefined) calendar.Month = flags.month;
		schedule = { type: "scheduled", calendar };
	} else {
		throw new Error(`Invalid schedule type: ${flags.schedule}`);
	}

	// Build execution
	const execution: any =
		flags.type === "script"
			? { type: "script", script: flags.script }
			: { type: "agent", prompt: flags.prompt };

	// Build destination
	const destination: any = { chatId: flags.channel };
	if (flags.thread) destination.threadId = flags.thread;

	return { name, schedule, execution, destination };
}

export async function handleCreate(
	client: ApiClient,
	name: string,
	body: any,
): Promise<CLIResponse> {
	const res = await client.post("/api/jobs", body);

	if (res.status === 409) {
		return error(
			`kos jobs create ${name}`,
			"CONFLICT",
			res.data.error ?? `Job '${name}' already exists`,
			`Choose a different name or delete the existing job: kos jobs delete ${name}`,
			[
				{
					command: `kos jobs delete ${name}`,
					description: "Delete existing job first",
				},
			],
		);
	}

	if (res.status === 400) {
		const msg = res.data.error ?? "Validation failed";
		const details = res.data.details
			? `: ${JSON.stringify(res.data.details)}`
			: "";
		return error(
			`kos jobs create ${name}`,
			"VALIDATION_ERROR",
			`${msg}${details}`,
			"Check flag values match the expected schema",
			[],
		);
	}

	if (res.status !== 201) {
		return error(
			`kos jobs create ${name}`,
			"API_ERROR",
			`Unexpected status ${res.status}`,
			"Check the server logs",
			[],
		);
	}

	return success(`kos jobs create ${name}`, res.data, [
		{ command: "kos jobs list", description: "List all jobs" },
		{
			command: `kos jobs delete ${name}`,
			description: "Delete this job",
		},
	]);
}
```

Add the create subcommand definition:

```typescript
const createCommand = defineCommand({
	meta: { name: "create", description: "Create a scheduled job" },
	args: {
		name: { type: "positional", description: "Job name", required: true },
		schedule: { type: "string", description: "Schedule type: periodic | scheduled" },
		seconds: { type: "string", description: "Interval in seconds (periodic)" },
		hour: { type: "string", description: "Hour 0-23 (scheduled)" },
		minute: { type: "string", description: "Minute 0-59 (scheduled)" },
		day: { type: "string", description: "Day 1-31 (scheduled)" },
		weekday: { type: "string", description: "Weekday 0-6, Sunday=0 (scheduled)" },
		month: { type: "string", description: "Month 1-12 (scheduled)" },
		type: { type: "string", description: "Execution type: script | agent" },
		script: { type: "string", description: "Script content (script jobs)" },
		prompt: { type: "string", description: "Agent prompt (agent jobs)" },
		channel: { type: "string", description: "Slack channel ID" },
		thread: { type: "string", description: "Slack thread ID" },
		json: { type: "string", description: "Raw JSON body (overrides other flags)" },
	},
	async run({ args }) {
		const cmd = `kos jobs create ${args.name}`;
		try {
			const body = buildCreateBody(args.name, {
				...args,
				seconds: args.seconds ? Number(args.seconds) : undefined,
				hour: args.hour ? Number(args.hour) : undefined,
				minute: args.minute ? Number(args.minute) : undefined,
				day: args.day ? Number(args.day) : undefined,
				weekday: args.weekday ? Number(args.weekday) : undefined,
				month: args.month ? Number(args.month) : undefined,
			});
			const client = await getClient();
			output(await handleCreate(client, args.name, body));
		} catch (e) {
			outputError(cmd, e);
		}
	},
});
```

Register in `jobsCommand.subCommands`:
```typescript
subCommands: {
	list: listCommand,
	create: createCommand,
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.kos-kit/cli && bun test tests/jobs.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd ~/.kos-kit/cli
git add src/commands/jobs.ts tests/jobs.test.ts
git commit -m "feat: add kos jobs create with flag and JSON modes"
```

---

### Task 8: Jobs Delete, Pause, Resume Commands

**Files:**
- Modify: `~/.kos-kit/cli/src/commands/jobs.ts`
- Modify: `~/.kos-kit/cli/tests/jobs.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `~/.kos-kit/cli/tests/jobs.test.ts`. **Note:** Merge new imports into the existing top-level import statement:

```typescript
// Update existing import at top of file to include:
import { handleList, handleCreate, buildCreateBody, handleDelete, handlePause, handleResume } from "../src/commands/jobs";

describe("jobs delete", () => {
	test("returns synthesized success on 204", async () => {
		const client = mockClient({
			del: mock(async () => ({ status: 204, data: null })),
		});
		const result = await handleDelete(client, "water-reminder");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toEqual({ deleted: "water-reminder" });
		}
	});

	test("returns NOT_FOUND on 404", async () => {
		const client = mockClient({
			del: mock(async () => ({
				status: 404,
				data: { error: "Job 'nope' not found" },
			})),
		});
		const result = await handleDelete(client, "nope");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("NOT_FOUND");
		}
	});
});

describe("jobs pause", () => {
	test("returns updated job on success", async () => {
		const updated = { name: "test", disabled: true };
		const client = mockClient({
			patch: mock(async () => ({ status: 200, data: updated })),
		});
		const result = await handlePause(client, "test");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toEqual(updated);
			const resumeAction = result.next_actions.find((a) =>
				a.command.includes("resume"),
			);
			expect(resumeAction).toBeDefined();
		}
	});
});

describe("jobs resume", () => {
	test("returns updated job on success", async () => {
		const updated = { name: "test", disabled: false };
		const client = mockClient({
			patch: mock(async () => ({ status: 200, data: updated })),
		});
		const result = await handleResume(client, "test");
		expect(result.ok).toBe(true);
		if (result.ok) {
			const pauseAction = result.next_actions.find((a) =>
				a.command.includes("pause"),
			);
			expect(pauseAction).toBeDefined();
		}
	});

	test("returns NOT_FOUND on 404", async () => {
		const client = mockClient({
			patch: mock(async () => ({
				status: 404,
				data: { error: "Job 'nope' not found" },
			})),
		});
		const result = await handleResume(client, "nope");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("NOT_FOUND");
		}
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.kos-kit/cli && bun test tests/jobs.test.ts`
Expected: FAIL — `handleDelete`, `handlePause`, `handleResume` not exported

- [ ] **Step 3: Implement delete, pause, resume handlers**

Add to `~/.kos-kit/cli/src/commands/jobs.ts`:

```typescript
export async function handleDelete(
	client: ApiClient,
	name: string,
): Promise<CLIResponse> {
	const res = await client.del(`/api/jobs/${name}`);

	if (res.status === 404) {
		return error(
			`kos jobs delete ${name}`,
			"NOT_FOUND",
			`Job '${name}' not found`,
			"Run kos jobs list to see available jobs",
			[{ command: "kos jobs list", description: "List all jobs" }],
		);
	}

	if (res.status !== 204) {
		return error(
			`kos jobs delete ${name}`,
			"API_ERROR",
			`Unexpected status ${res.status}`,
			"Check the server logs",
			[],
		);
	}

	return success(`kos jobs delete ${name}`, { deleted: name }, [
		{ command: "kos jobs list", description: "List remaining jobs" },
	]);
}

export async function handlePause(
	client: ApiClient,
	name: string,
): Promise<CLIResponse> {
	const res = await client.patch(`/api/jobs/${name}`, { disabled: true });

	if (res.status === 404) {
		return error(
			`kos jobs pause ${name}`,
			"NOT_FOUND",
			`Job '${name}' not found`,
			"Run kos jobs list to see available jobs",
			[{ command: "kos jobs list", description: "List all jobs" }],
		);
	}

	if (res.status !== 200) {
		return error(
			`kos jobs pause ${name}`,
			"API_ERROR",
			`Unexpected status ${res.status}`,
			"Check the server logs",
			[],
		);
	}

	return success(`kos jobs pause ${name}`, res.data, [
		{
			command: `kos jobs resume ${name}`,
			description: "Resume this job",
		},
		{ command: "kos jobs list", description: "List all jobs" },
	]);
}

export async function handleResume(
	client: ApiClient,
	name: string,
): Promise<CLIResponse> {
	const res = await client.patch(`/api/jobs/${name}`, { disabled: false });

	if (res.status === 404) {
		return error(
			`kos jobs resume ${name}`,
			"NOT_FOUND",
			`Job '${name}' not found`,
			"Run kos jobs list to see available jobs",
			[{ command: "kos jobs list", description: "List all jobs" }],
		);
	}

	if (res.status !== 200) {
		return error(
			`kos jobs resume ${name}`,
			"API_ERROR",
			`Unexpected status ${res.status}`,
			"Check the server logs",
			[],
		);
	}

	return success(`kos jobs resume ${name}`, res.data, [
		{
			command: `kos jobs pause ${name}`,
			description: "Pause this job",
		},
		{ command: "kos jobs list", description: "List all jobs" },
	]);
}
```

Add subcommand definitions:

```typescript
const deleteCommand = defineCommand({
	meta: { name: "delete", description: "Delete a scheduled job" },
	args: {
		name: { type: "positional", description: "Job name", required: true },
	},
	async run({ args }) {
		const client = await getClient();
		try {
			output(await handleDelete(client, args.name));
		} catch (e) {
			outputError(`kos jobs delete ${args.name}`, e);
		}
	},
});

const pauseCommand = defineCommand({
	meta: { name: "pause", description: "Pause a scheduled job" },
	args: {
		name: { type: "positional", description: "Job name", required: true },
	},
	async run({ args }) {
		const client = await getClient();
		try {
			output(await handlePause(client, args.name));
		} catch (e) {
			outputError(`kos jobs pause ${args.name}`, e);
		}
	},
});

const resumeCommand = defineCommand({
	meta: { name: "resume", description: "Resume a paused job" },
	args: {
		name: { type: "positional", description: "Job name", required: true },
	},
	async run({ args }) {
		const client = await getClient();
		try {
			output(await handleResume(client, args.name));
		} catch (e) {
			outputError(`kos jobs resume ${args.name}`, e);
		}
	},
});
```

Register all in `jobsCommand.subCommands`:

```typescript
subCommands: {
	list: listCommand,
	create: createCommand,
	delete: deleteCommand,
	pause: pauseCommand,
	resume: resumeCommand,
},
```

- [ ] **Step 4: Run all tests**

Run: `cd ~/.kos-kit/cli && bun test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd ~/.kos-kit/cli
git add src/commands/jobs.ts tests/jobs.test.ts
git commit -m "feat: add kos jobs delete/pause/resume commands"
```

---

## Chunk 4: Agent Prompt Update + Smoke Test

### Task 9: Update Agent System Prompt

**Files:**
- Modify: `~/projects/kos-agent/src/agent/session.ts`

- [ ] **Step 1: Replace curl templates with CLI commands**

In `~/projects/kos-agent/src/agent/session.ts`, replace the Scheduled Jobs section of `buildSystemAppend` (lines 29-42) with:

```typescript
lines.push(
	"",
	"## Scheduled Jobs",
	"Manage scheduled jobs with the kos CLI. All output is JSON.",
	"",
	"Create a script job:",
	'kos jobs create <name> --schedule periodic --seconds <N> --type script --script "<commands>" --channel <chatId> --thread <threadId>',
	"",
	"Create an agent job:",
	'kos jobs create <name> --schedule scheduled --hour 9 --minute 0 --type agent --prompt "<what to do>" --channel <chatId> --thread <threadId>',
	"",
	"Other commands:",
	"kos jobs list",
	"kos jobs delete <name>",
	"kos jobs pause <name>",
	"kos jobs resume <name>",
	"",
	"Schedule types:",
	"- periodic: --seconds N",
	"- scheduled: --hour H --minute M (also --day, --weekday, --month)",
	"For multiple triggers per job, use --json mode with a calendar array.",
);
```

- [ ] **Step 2: Run kos-agent tests**

Run: `cd ~/projects/kos-agent && bun test`
Expected: All PASS (85 tests)

- [ ] **Step 3: Commit**

```bash
cd ~/projects/kos-agent
git add src/agent/session.ts
git commit -m "feat: swap curl templates for kos CLI commands in agent prompt"
```

---

### Task 10: Smoke Test — Local CLI Against Running Server

This is a manual verification task.

- [ ] **Step 1: Ensure kos-agent is running locally**

Run: `curl -s http://localhost:9080/health`
Expected: `{"status":"ok"}`

If not running: `cd ~/projects/kos-agent && bun run src/index.ts` (or start via LaunchAgent)

- [ ] **Step 2: Set api_url in config**

Run: `cat ~/.kos/config.json | jq '.api_url = "http://localhost:9080"' > /tmp/kos-config.json && mv /tmp/kos-config.json ~/.kos/config.json`

- [ ] **Step 3: Test kos jobs list**

Run: `kos jobs list`
Expected: JSON envelope with `ok: true` and empty or populated result array

- [ ] **Step 4: Test kos jobs create (script)**

Run: `kos jobs create smoke-test --schedule periodic --seconds 300 --type script --script "echo smoke test" --channel C123`
Expected: JSON envelope with `ok: true`, result contains created job

- [ ] **Step 5: Test kos jobs list shows the new job**

Run: `kos jobs list | jq '.result[].name'`
Expected: Contains `"smoke-test"`

- [ ] **Step 6: Test kos jobs pause**

Run: `kos jobs pause smoke-test`
Expected: JSON with `disabled: true`

- [ ] **Step 7: Test kos jobs resume**

Run: `kos jobs resume smoke-test`
Expected: JSON with `disabled: false`

- [ ] **Step 8: Test kos jobs delete**

Run: `kos jobs delete smoke-test`
Expected: `{ "ok": true, "result": { "deleted": "smoke-test" } }`

- [ ] **Step 9: Verify kos on Mac Mini PATH**

SSH into Mac Mini and run: `which kos`
If not found, ensure `~/.kos-kit/cli/src/index.ts` is symlinked or `~/.kos-kit/cli` is in PATH.

- [ ] **Step 10: Final commit with any fixes**

If any smoke test revealed issues, fix and commit.
