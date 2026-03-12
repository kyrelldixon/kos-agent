import * as restate from "@restatedev/restate-sdk";
import { pingService } from "./services/ping.ts";

export function createRestateServer() {
  const server = restate.endpoint();
  server.bind(pingService);
  return server;
}

export async function startRestateServer() {
  const port = Number(process.env.RESTATE_PORT) || 9080;
  const server = createRestateServer();
  server.listen(port);
  console.log(`🔄 Restate handlers on :${port}`);
}
