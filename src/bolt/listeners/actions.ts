import type { App, ButtonAction, StaticSelectAction } from "@slack/bolt";
import type { Inngest } from "inngest";
import { z } from "zod";
import { saveChannelWorkspace } from "@/lib/channels";
import { slack } from "@/lib/slack";

const captureDecisionValueSchema = z.object({
  captureId: z.string(),
  action: z.enum(["full", "quick-save", "skip"]),
});

export function registerActionListeners(app: App, inngest: Inngest) {
  app.action("channel_workspace_select", async ({ ack, body, action }) => {
    await ack();
    const selectedPath = (action as StaticSelectAction).selected_option.value;
    const channelId = body.channel?.id;
    if (!channelId) return;

    await saveChannelWorkspace(channelId, selectedPath);
    await slack.chat.postMessage({
      channel: channelId,
      text: `Workspace set to \`${selectedPath}\`.`,
    });
  });

  app.action(/^capture_decision_/, async ({ ack, action }) => {
    await ack();
    const buttonValue = (action as ButtonAction).value;
    if (!buttonValue) return;
    const raw = JSON.parse(buttonValue);
    const value = captureDecisionValueSchema.parse(raw);
    await inngest.send({
      name: "agent.capture.decision",
      data: {
        captureId: value.captureId,
        action: value.action,
      },
    });
  });
}
