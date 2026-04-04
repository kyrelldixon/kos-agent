const streams = new Map<string, AbortController>();

export function register(sessionKey: string): AbortController {
  const controller = new AbortController();
  streams.set(sessionKey, controller);
  return controller;
}

export function abort(sessionKey: string): boolean {
  const controller = streams.get(sessionKey);
  if (!controller) return false;
  controller.abort();
  streams.delete(sessionKey);
  return true;
}

export function unregister(sessionKey: string): void {
  streams.delete(sessionKey);
}
