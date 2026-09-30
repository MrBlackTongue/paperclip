import { describe, expect, it, vi } from "vitest";
import { persistedConversationProcessLiveness } from "./conversation-continuation.js";

describe("persisted conversation process ownership", () => {
  const stored = {
    processPid: 49773,
    processGroupId: 49773,
    processStartedAt: new Date("2026-09-30T06:30:00.000Z"),
  };

  it("does not hold a terminal run when its PID was reused and its group is gone", async () => {
    const isAlive = vi.fn((pid: number) => pid > 0);
    const startedAt = vi.fn().mockResolvedValue("2026-09-30T10:00:00.000Z");
    await expect(persistedConversationProcessLiveness(stored, { isAlive, startedAt }))
      .resolves.toEqual({ pidAlive: false, groupAlive: false });
    expect(isAlive).toHaveBeenCalledWith(49773);
    expect(isAlive).toHaveBeenCalledWith(-49773);
  });

  it("retains the hold when process identity cannot be read", async () => {
    await expect(persistedConversationProcessLiveness(stored, {
      isAlive: () => true,
      startedAt: async () => { throw new Error("unreadable"); },
    })).resolves.toEqual({ pidAlive: true, groupAlive: true });
  });

  it("keeps a live group after its leader PID is reused", async () => {
    await expect(persistedConversationProcessLiveness(stored, {
      isAlive: () => true,
      startedAt: async () => "2026-09-30T10:00:00.000Z",
    })).resolves.toEqual({ pidAlive: false, groupAlive: true });
  });

  it("keeps a live PID when its recorded timestamp differs by less than five seconds", async () => {
    await expect(persistedConversationProcessLiveness(stored, {
      isAlive: () => true,
      startedAt: async () => "2026-09-30T06:30:03.000Z",
    })).resolves.toEqual({ pidAlive: true, groupAlive: true });
  });
});
