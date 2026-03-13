import type { App } from "@slack/bolt";
import type { Inngest } from "inngest";
import { registerActionListeners } from "@/bolt/listeners/actions";
import { registerMessageListeners } from "@/bolt/listeners/message";
import { registerOnboardingListeners } from "@/bolt/listeners/onboarding";

export function registerListeners(app: App, inngest: Inngest) {
  registerMessageListeners(app, inngest);
  registerOnboardingListeners(app);
  registerActionListeners(app);
}
