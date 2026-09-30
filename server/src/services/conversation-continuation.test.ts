import { describe, expect, it, vi } from "vitest";
import { persistedConversationProcessLiveness } from "./conversation-continuation.js";

describe("persisted conversation process ownership", () => {
  const stored = {
    processPid: 49773,
    processGroupId: 49773,
    processStartedAt: new Date("2026-09-30T06:30:00.000Z"),
  };

  it("does not hold a terminal run when both its PID and group number were reused", async () => {
    const isAlive = vi.fn().mockReturnValue(true);
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

  it("keeps a different live group when only the PID is known to be reused", async () => {
    await expect(persistedConversationProcessLiveness({ ...stored, processGroupId: 60000 }, {
      isAlive: () => true,
      startedAt: async () => "2026-09-30T10:00:00.000Z",
    })).resolves.toEqual({ pidAlive: false, groupAlive: true });
  });
});
