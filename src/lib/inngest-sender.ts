/**
 * Minimal interface for the subset of the Inngest client that route
 * factories need. Using method syntax (not an arrow property) enables
 * TypeScript's bivariant parameter check, which lets a real Inngest
 * client — whose `send` signature is stricter — satisfy this contract
 * without importing the full generic `Inngest` type (which would pull
 * the event registry and risk circular imports via `@/inngest/client`).
 *
 * Accepts a single event or an array, matching the real Inngest API.
 */
export interface InngestEvent {
  name: string;
  data: unknown;
}

export interface InngestSender {
  send(events: InngestEvent | InngestEvent[]): Promise<unknown>;
}
