import { describe, expect, test } from "bun:test";
import { abort, register, unregister } from "@/lib/streams";

describe("streams", () => {
  test("register returns an AbortController", () => {
    const controller = register("test-key-1");
    expect(controller).toBeInstanceOf(AbortController);
    unregister("test-key-1");
  });

  test("abort returns false when no stream registered", () => {
    expect(abort("nonexistent")).toBe(false);
  });

  test("abort signals the registered controller and returns true", () => {
    const controller = register("test-key-2");
    expect(controller.signal.aborted).toBe(false);
    expect(abort("test-key-2")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  test("abort removes the entry after aborting", () => {
    register("test-key-3");
    abort("test-key-3");
    expect(abort("test-key-3")).toBe(false);
  });

  test("unregister removes the entry without aborting", () => {
    const controller = register("test-key-4");
    unregister("test-key-4");
    expect(controller.signal.aborted).toBe(false);
    expect(abort("test-key-4")).toBe(false);
  });

  test("register replaces existing entry", () => {
    const first = register("test-key-5");
    const second = register("test-key-5");
    expect(first).not.toBe(second);
    unregister("test-key-5");
  });
});
