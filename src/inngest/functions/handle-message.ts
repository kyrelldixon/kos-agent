import type { SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { streamAgentSession } from "@/agent/session";
import { agentMessageReceived, inngest } from "@/inngest/client";
import { getDisplayMode, resolveWorkspace } from "@/lib/channels";
import {
  formatToolUse,
  markdownToSlackMrkdwn,
  splitMessage,
} from "@/lib/format";
import { getSession, saveSession } from "@/lib/sessions";
import { slack } from "@/lib/slack";

export const handleMessage = inngest.createFunction(
  {
    id: "handle-message",
    retries: 1,
    timeouts: { finish: "5m" },
    triggers: [agentMessageReceived],
    singleton: { key: "event.data.sessionKey", mode: "cancel" },
  },
  async ({ event, step }) => {
    const { message, sessionKey, channel, destination } = event.data;

    // --- Durable bookend: resolve context ---

    const session = await step.run("resolve-session", async () => {
      return getSession(sessionKey);
    });

    const workspace = await step.run("resolve-workspace", async () => {
      return session?.workspace ?? (await resolveWorkspace(destination.chatId));
    });

    const displayMode = await step.run("resolve-display-mode", async () => {
      return getDisplayMode();
    });

    // --- Streaming zone (not in a step) ---
    // Three display modes:
    //   verbose  — every tool gets its own message (detailed, for debugging)
    //   compact  — one updating status message per tool batch, resets on text
    //   minimal  — text only, no tool messages

    let sessionId: string | undefined = session?.sessionId;
    let resultText = "";
    let statusMessageTs: string | undefined;
    let toolCount = 0;
    let textPosted = false;

    const stream = streamAgentSession({
      message,
      sessionId,
      workspace,
      destination,
    });

    for await (const msg of stream) {
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        console.log(`[agent] Session initialized: ${sessionId}`);
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const part of msg.message.content) {
          // --- Tool use ---
          if (part.type === "tool_use") {
            toolCount++;
            const toolText = formatToolUse(
              part.name,
              part.input as Record<string, unknown>,
            );
            console.log(`[agent] ${toolText}`);

            if (channel === "slack" && displayMode !== "minimal") {
              if (displayMode === "verbose") {
                // Verbose: every tool gets its own message
                await slack.chat
                  .postMessage({
                    channel: destination.chatId,
                    text: toolText,
                    thread_ts: destination.threadId,
                  })
                  .catch((err) =>
                    console.warn(
                      "tool message failed:",
                      err.data?.error ?? err.message,
                    ),
                  );
              } else {
                // Compact: one updating status message
                const statusText = `🔧 Working... (${toolText.replace(/^[^\s]+ /, "")})`;
                if (!statusMessageTs) {
                  const res = await slack.chat
                    .postMessage({
                      channel: destination.chatId,
                      text: statusText,
                      thread_ts: destination.threadId,
                    })
                    .catch((err) => {
                      console.warn(
                        "status message failed:",
                        err.data?.error ?? err.message,
                      );
                      return undefined;
                    });
                  statusMessageTs = res?.ts;
                } else {
                  await slack.chat
                    .update({
                      channel: destination.chatId,
                      ts: statusMessageTs,
                      text: statusText,
                    })
                    .catch((err) =>
                      console.warn(
                        "status update failed:",
                        err.data?.error ?? err.message,
                      ),
                    );
                }
              }
            }
          }

          // --- Text ---
          if (part.type === "text" && part.text?.trim()) {
            console.log(`[agent] Assistant text (${part.text.length} chars)`);

            if (channel === "slack") {
              // Compact: finalize the status message before posting text
              if (
                displayMode === "compact" &&
                statusMessageTs &&
                toolCount > 0
              ) {
                await slack.chat
                  .update({
                    channel: destination.chatId,
                    ts: statusMessageTs,
                    text: `🔧 Done (${toolCount} tools used)`,
                  })
                  .catch((err) =>
                    console.warn(
                      "status finalize failed:",
                      err.data?.error ?? err.message,
                    ),
                  );
                // Reset for next batch
                statusMessageTs = undefined;
                toolCount = 0;
              }

              const formatted = markdownToSlackMrkdwn(part.text);
              const chunks = splitMessage(formatted);
              for (const chunk of chunks) {
                await slack.chat
                  .postMessage({
                    channel: destination.chatId,
                    text: chunk,
                    thread_ts: destination.threadId,
                  })
                  .catch((err) =>
                    console.warn(
                      "text message failed:",
                      err.data?.error ?? err.message,
                    ),
                  );
              }
              textPosted = true;
            }
          }
        }
      }

      if (msg.type === "result") {
        const resultMsg = msg as SDKResultSuccess;
        console.log(
          `[agent] Result: ${msg.subtype}, text length: ${(resultMsg.result ?? "").length}`,
        );
        if (msg.subtype === "success") {
          resultText = resultMsg.result ?? "";
        }
      }
    }

    // Compact: finalize status message if no text came after last tool batch
    if (
      displayMode === "compact" &&
      statusMessageTs &&
      toolCount > 0 &&
      channel === "slack"
    ) {
      await slack.chat
        .update({
          channel: destination.chatId,
          ts: statusMessageTs,
          text: `✅ Done (${toolCount} tools used)`,
        })
        .catch((err) =>
          console.warn(
            "status done update failed:",
            err.data?.error ?? err.message,
          ),
        );
    }

    // If nothing was posted during streaming, post empty response
    if (!textPosted && !resultText?.trim() && channel === "slack") {
      await slack.chat
        .postMessage({
          channel: destination.chatId,
          text: "_No response generated._",
          thread_ts: destination.threadId,
        })
        .catch((err) =>
          console.warn(
            "empty response failed:",
            err.data?.error ?? err.message,
          ),
        );
    }

    console.log(
      `[agent] Done. Result length: ${resultText.length}, sessionId: ${sessionId}`,
    );

    // --- Durable bookend: persist and notify ---

    if (sessionId) {
      await step.run("save-session", async () => {
        await saveSession(sessionKey, {
          sessionId: sessionId as string,
        });
      });
    }

    // send-reply now only handles reaction swap (brain → checkmark)
    await step.sendEvent("send-reply", {
      name: "agent.reply.ready",
      data: {
        response: resultText,
        channel,
        destination,
      },
    });
  },
);
