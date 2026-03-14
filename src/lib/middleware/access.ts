import type { Context, Next } from "hono";

export function cfAccessMiddleware(expectedClientId: string) {
  return async (c: Context, next: Next) => {
    const clientId = c.req.header("CF-Access-Client-Id");
    if (clientId !== expectedClientId) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}
