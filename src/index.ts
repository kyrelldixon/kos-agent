import { createBoltApp } from "./bolt/app.ts";
import { registerMessageListener } from "./bolt/listeners/message.ts";

async function main() {
  const app = createBoltApp();
  registerMessageListener(app);

  await app.start();
  console.log("⚡ Bolt app running (Socket Mode)");
}

main().catch(console.error);
