import { createBoltApp } from "./bolt/app.ts";
import { registerMessageListener } from "./bolt/listeners/message.ts";
import { startRestateServer } from "./restate/server.ts";

async function main() {
  await startRestateServer();

  const app = createBoltApp();
  registerMessageListener(app);
  await app.start();

  console.log("⚡ Agent system running");
}

main().catch(console.error);
