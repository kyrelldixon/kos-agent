import type { App, StaticSelectAction } from "@slack/bolt";
import { saveChannelWorkspace } from "@/lib/channels";
import { slack } from "@/lib/slack";

export function registerActionListeners(app: App) {
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
}
