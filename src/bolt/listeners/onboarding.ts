import type { App } from "@slack/bolt";
import { getGlobalDefault, getWorkspaces } from "@/lib/channels";

export function registerOnboardingListeners(app: App) {
  app.event("member_joined_channel", async ({ event, client }) => {
    const botInfo = await client.auth.test();
    if (event.user !== botInfo.user_id) return;

    const workspaces = await getWorkspaces();
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
              text: { type: "plain_text", text: ws.label },
              value: ws.path,
            })),
          },
        },
      ],
    });
  });
}
