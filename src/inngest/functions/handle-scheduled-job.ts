import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { NonRetriableError } from "inngest";
import { streamAgentSession } from "@/agent/session";
import { agentJobTriggered, inngest } from "@/inngest/client";
import { type JobConfig, JobConfigSchema } from "@/jobs/schema";
import { resolveWorkspace } from "@/lib/channels";
import { markdownToSlackMrkdwn, splitMessage } from "@/lib/format";
import { getSession, saveSession } from "@/lib/sessions";
import { slack } from "@/lib/slack";

const DEFAULT_JOBS_DIR = join(homedir(), ".kos/agent/jobs");

/** Exported for testing. Pass jobsDir override in tests. */
export async function loadJobConfig(
  jobName: string,
  jobsDir = DEFAULT_JOBS_DIR,
): Promise<JobConfig> {
  const configPath = join(jobsDir, jobName, "job.json");
  if (!existsSync(configPath)) {
    throw new NonRetriableError(`Job '${jobName}' not found: ${configPath}`);
  }
  const raw = await readFile(configPath, "utf-8");
  const parsed = JobConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new NonRetriableError(
      `Job '${jobName}' has invalid config: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Post error to Slack. Best-effort — does not throw. */
async function postJobError(config: JobConfig, error: string): Promise<void> {
  await slack.chat
    .postMessage({
      channel: config.destination.chatId,
      text: `Job \`${config.name}\` failed: ${error.slice(0, 300)}`,
      thread_ts: config.destination.threadId,
    })
    .catch((err) => console.warn("job error notification failed:", err));
}

export const handleScheduledJob = inngest.createFunction(
  {
    id: "handle-scheduled-job",
    retries: 1,
    timeouts: { finish: "5m" },
    triggers: [agentJobTriggered],
    singleton: { key: "event.data.job", mode: "cancel" },
  },
  async ({ event, step }) => {
    const { job: jobName } = event.data;

    const config = await step.run("load-config", () => loadJobConfig(jobName));
    const { destination } = config;

    try {
      if (config.execution.type === "script") {
        // --- Script job ---
        const scriptPath = join(DEFAULT_JOBS_DIR, jobName, "script");
        if (!existsSync(scriptPath)) {
          await postJobError(config, "No script file found");
          throw new NonRetriableError(`Job '${jobName}' has no script file`);
        }

        const output = await step.run("execute-script", async () => {
          const proc = Bun.spawn(["./script"], {
            cwd: join(DEFAULT_JOBS_DIR, jobName),
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          return { stdout, stderr, exitCode };
        });

        await step.run("post-script-result", async () => {
          const text =
            output.exitCode === 0
              ? output.stdout.trim() || "_Script completed with no output._"
              : `Script failed (exit ${output.exitCode}):\n\`\`\`\n${(output.stderr || output.stdout).trim()}\n\`\`\``;

          const chunks = splitMessage(text);
          for (const chunk of chunks) {
            await slack.chat.postMessage({
              channel: destination.chatId,
              text: chunk,
              thread_ts: destination.threadId,
            });
          }
        });

        if (output.exitCode !== 0) {
          throw new Error(
            `Script '${jobName}' failed with exit code ${output.exitCode}`,
          );
        }
      } else {
        // --- Agent job ---
        const { prompt } = config.execution;
        const sessionKey = destination.threadId
          ? `slack-${destination.chatId}-${destination.threadId}`
          : `slack-${destination.chatId}`;

        const session = await step.run("resolve-session", async () => {
          return getSession(sessionKey);
        });

        const workspace = await step.run("resolve-workspace", async () => {
          return (
            session?.workspace ?? (await resolveWorkspace(destination.chatId))
          );
        });

        // Streaming zone — not in a step
        let sessionId: string | undefined = session?.sessionId;
        let resultText = "";

        const stream = streamAgentSession({
          message: prompt,
          sessionId,
          workspace,
          destination,
        });

        for await (const msg of stream) {
          if (msg.type === "system" && msg.subtype === "init") {
            sessionId = msg.session_id;
          }
          if (msg.type === "result") {
            const resultMsg = msg as SDKResultSuccess;
            if (msg.subtype === "success") {
              resultText = resultMsg.result ?? "";
            }
          }
        }

        // Post final text only (minimal mode)
        if (resultText.trim()) {
          const formatted = markdownToSlackMrkdwn(resultText);
          const chunks = splitMessage(formatted);
          for (const chunk of chunks) {
            await slack.chat.postMessage({
              channel: destination.chatId,
              text: chunk,
              thread_ts: destination.threadId,
            });
          }
        } else {
          await slack.chat.postMessage({
            channel: destination.chatId,
            text: "_No response generated._",
            thread_ts: destination.threadId,
          });
        }

        if (sessionId) {
          await step.run("save-session", async () => {
            await saveSession(sessionKey, {
              sessionId: sessionId as string,
              workspace,
            });
          });
        }
      }
    } catch (error) {
      // Post error to Slack before re-throwing (handleFailure can't handle
      // job events since they lack destination in event data)
      if (!(error instanceof NonRetriableError)) {
        await postJobError(
          config,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }

    return { job: jobName, type: config.execution.type };
  },
);
