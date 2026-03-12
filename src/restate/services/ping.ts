import * as restate from "@restatedev/restate-sdk";

export const pingService = restate.service({
  name: "ping",
  handlers: {
    ping: async (ctx: restate.Context, input: { message: string }) => {
      const timestamp = await ctx.run("timestamp", () =>
        new Date().toISOString(),
      );
      return { pong: input.message, at: timestamp };
    },
  },
});
