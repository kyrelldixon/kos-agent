import { createBoltApp } from "./bolt/app.ts";
import { registerMessageListener } from "./bolt/listeners/message.ts";

// TODO(Task 12): Rewrite entry point with Inngest + Hono server

async function main() {
  const app = createBoltApp();
  registerMessageListener(app);
  await app.start();

  console.log("⚡ Agent system running");
}

main().catch(console.error);
