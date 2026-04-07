# kos-agent

Personal AI agent system running on a Mac Mini. Slack bot + HTTP API + Inngest durable functions.

## Stack

- **Runtime:** Bun (not Node). Use `bun test`, `bun run typecheck`, etc.
- **Framework:** Hono (HTTP), Bolt (Slack), Inngest 4.0 (durable functions)
- **Language:** TypeScript (strict). Path aliases: `@/` → `src/`
- **Validation:** Zod everywhere. Never use `as` typecasting — use Zod schemas or type guards.
- **Tests:** Co-locate test files next to source files (e.g., `foo.test.ts` beside `foo.ts`). Never create a `tests/` directory.
- **Secrets:** varlock + 1Password. NEVER use `varlock printenv` (leaks secrets). Always use `varlock run`.

## Key Commands

```bash
bun run typecheck          # TypeScript type checking
bun test                   # Run all tests
bun run src/index.ts       # Start the agent (Hono :9080, Bolt Socket Mode, Inngest)
```

## Architecture

```
kos-agent (this repo)     — Slack bot, HTTP API, Inngest functions
~/.kos-kit/cli/           — `kos` CLI tool (captures, jobs, config)
~/.kos/                   — Shared state directory (sessions, jobs, captures, config)
~/kyrell-os-vault/        — Obsidian vault (source notes, templates, daily notes)
```

## Inngest Patterns

### `step.invoke()` — Function-to-Function Calls

Extraction functions use `invoke()` triggers for `step.invoke()` compatibility:

```typescript
import { invoke } from "inngest";
import { z } from "zod";

// Function definition — use invoke() trigger, not event trigger
export const myFunction = inngest.createFunction(
  { id: "my-function", retries: 1 },
  { trigger: invoke(z.object({ url: z.string() })) },
  async ({ event }) => {
    // Access data via event.data
    return { content: event.data.url };
  },
);

// Caller — data is wrapped in a `data` property
const result = await step.invoke("step-name", {
  function: myFunction,
  data: { url: "https://example.com" },
  timeout: "30s",
});
```

**Critical:** The `data` property wraps the payload. Do NOT spread fields at the top level.

### Registering Functions

All Inngest functions must be added to the `functions` array in `src/index.ts` to be registered with the serve handler.

## Obsidian Vault

The agent interacts with the Obsidian vault via the `obsidian` CLI (Obsidian must be running).

**NEVER hardcode note formats in TypeScript.** Use Obsidian templates from `~/kyrell-os-vault/templates/`.

### Key conventions:
- Dates: `MM-DD-YYYY` format, backlinked as `[[03-17-2026]]`
- Links: Wikilinks `[[Note Name]]`, not markdown links
- Categories: Array of wikilinks `["[[Sources]]"]` — determines note type
- Summary/description goes in **body content**, not frontmatter

### Creating notes programmatically:
```bash
obsidian create name="Title" template="Template Name" folder="sources"
obsidian property:set name=url value="https://example.com" file="Title"
obsidian append file="Title" content="Body content here"
```

See the using-obsidian skill (installed plugin) for full CLI reference.

## Capture Pipeline

**Spec:** `docs/superpowers/specs/2026-03-17-capture-pipeline-v2-design.md`
**Plan:** `docs/superpowers/plans/2026-03-17-capture-pipeline-v2.md`

The capture pipeline takes URLs, extracts content, and writes Obsidian vault notes.

### What's deployed and working (don't break these):
- `kos capture <url> --quick` / `--full` / triage mode
- Slack triage buttons (full/quick-save/skip)
- `kos config set/get/list`
- Vault note writing with idempotent updates
- Slack notifications in configured channel

### What the v2 plan changes:
- Three-tier extraction: Jina → Readability → CF Browser (separate Inngest functions)
- GitHub repo capture (clone + vault reference card)
- Obsidian template-based vault notes (replacing hardcoded TypeScript)
- Conditional notifications (CLI only; agent handles its own)
- Extraction failure handling (`status: extraction-failed`)
- Agent awareness of capture capabilities in system prompt

### Content types:
article, youtube-video, youtube-channel, hacker-news, github-repo, twitter (placeholder), file

## Voice Memo Pipeline

A separate pipeline for transcribing voice memos. Distinct from the URL capture pipeline because the input is audio (not text/HTML), the only "extraction method" is ElevenLabs Speech-to-Text, and there's no triage step — voice memos auto-process.

### Data flow

```
iPhone Voice Memo
    → Apple Shortcut (share sheet)
    → HTTPS POST to https://kos.kyrelldixon.com/api/voice-memo
        (CF Access Service Token → Cloudflare Tunnel → Mac Mini)
    → kos-agent saves to ~/.kos/agent/captures/voice-memo-{timestamp}/
    → Inngest event: voice.memo.detected
    → Transcribe (ElevenLabs scribe_v2)
    → Write vault note to ~/kyrell-os-vault/sources/
    → Slack notification
    → Cleanup capture directory
```

### Key infra facts (not derivable from code)

- **Upload route accepts a raw audio body**, not multipart/form-data. The `Content-Type` header (`audio/x-m4a`, `audio/mpeg`, `audio/wav`, `audio/webm`) determines the file extension. Optional `X-Filename` header preserves a custom name. **Why raw body:** iOS Shortcuts UI cannot reliably attach a variable as a file in a multipart form field — the variable picker shows "Shortcut Input" but tapping it doesn't apply. Raw body sidesteps the issue. Don't "fix" this back to multipart without re-confirming Shortcuts UI behavior.
- **Auth chain:** Cloudflare Access wraps the public endpoint with a Service Token (CF-Access-Client-Id + CF-Access-Client-Secret headers). The Apple Shortcut sends both. There is no app-level auth — CF Access is the only gate.
- **Capture directory lifecycle:** Each upload creates a unique `~/.kos/agent/captures/voice-memo-{timestamp}/` directory. The orchestrator deletes it after successful transcription. On failure (transcription returns empty), the directory is also cleaned up but a note with `status: transcription-failed` still gets written so the audio attempt is recorded.
- **Vault note location:** `~/kyrell-os-vault/sources/` with `source_type: voice-memo` in frontmatter. Idempotency comes from scanning existing notes for matching `file_path` frontmatter and overwriting in place — re-processing the same memo updates rather than duplicates.
- **Singleton dedup:** Inngest singleton keyed on `event.data.captureKey` (cancel mode). CaptureKey is `${timestamp}-${fileName}` so concurrent uploads of the same generic Voice Memos default name don't collide.
- **ElevenLabs API key:** Stored in 1Password (`op://Developer/ElevenLabs/token`), injected via varlock at runtime as `ELEVENLABS_API_KEY`. Same secret pattern as the Slack credentials.
- **Manual `transcribe` CLI** (in kos-kit) exists for one-off audio files outside the iPhone flow. Same ElevenLabs wrapper, no Inngest, no vault writing — just stdout + pbcopy.

### Sources doctrine

Voice memos use the same `[[Sources]]` category as URL captures and appear in the Sources base. The "Voice Memos" view filters on `source_type = "voice-memo"`. Treat voice memos as raw material — do not auto-summarize or extract topics in the pipeline. Body is raw transcript only; downstream processing is a separate concern.

## Commits

- Never include AI attribution lines
- Use conventional commit format: `feat(scope):`, `fix(scope):`, `docs:`, etc.
