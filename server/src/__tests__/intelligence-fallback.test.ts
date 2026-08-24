import { describe, expect, it } from "vitest";
import {
  FALLBACK_SOURCE_CONTEXT_KEY,
  type FallbackSourceSpec,
  isSourceExhaustionFailure,
  readFallbackChain,
  readFallbackSourceOverride,
  selectNextFallbackSource,
} from "../services/intelligence-fallback.ts";

const claudeAlt: FallbackSourceSpec = {
  adapterType: "claude_local",
  env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "second-sub" } },
  label: "Claude sub #2",
};
const codex: FallbackSourceSpec = { adapterType: "codex_local", label: "Codex" };

describe("isSourceExhaustionFailure", () => {
  it("triggers only on provider quota / rate-limit exhaustion", () => {
    expect(isSourceExhaustionFailure({ errorCode: "provider_quota", errorFamily: null })).toBe(true);
    expect(isSourceExhaustionFailure({ errorCode: "adapter_failed", errorFamily: "provider_quota" })).toBe(true);
  });

  it("never treats a real failure or a budget cap as source exhaustion", () => {
    // Budget exhaustion is a deliberate spend cap, not a source problem.
    expect(isSourceExhaustionFailure({ errorCode: "budget_exhausted", errorFamily: null })).toBe(false);
    expect(isSourceExhaustionFailure({ errorCode: "adapter_failed", errorFamily: null })).toBe(false);
    expect(isSourceExhaustionFailure({ errorCode: null, errorFamily: null })).toBe(false);
  });
});

describe("selectNextFallbackSource", () => {
  const chain = [claudeAlt, codex];

  it("returns the first fallback after the default source runs", () => {
    const next = selectNextFallbackSource(chain, 0);
    expect(next).toMatchObject({ index: 1, adapterType: "claude_local", label: "Claude sub #2" });
  });

  it("advances to the next source on each subsequent exhaustion", () => {
    expect(selectNextFallbackSource(chain, 1)).toMatchObject({ index: 2, adapterType: "codex_local" });
  });

  it("returns null once the chain is exhausted", () => {
    expect(selectNextFallbackSource(chain, 2)).toBeNull();
    expect(selectNextFallbackSource([], 0)).toBeNull();
  });
});

describe("readFallbackChain", () => {
  it("reads a valid chain from runtimeConfig", () => {
    const chain = readFallbackChain({ fallbackChain: [claudeAlt, codex] });
    expect(chain).toHaveLength(2);
    expect(chain[1].adapterType).toBe("codex_local");
  });

  it("caps the chain length defensively", () => {
    const many = Array.from({ length: 9 }, () => ({ adapterType: "codex_local" }));
    expect(readFallbackChain({ fallbackChain: many })).toHaveLength(4);
  });

  it("returns an empty chain for missing or malformed config", () => {
    expect(readFallbackChain(undefined)).toEqual([]);
    expect(readFallbackChain({})).toEqual([]);
    expect(readFallbackChain({ fallbackChain: "nope" })).toEqual([]);
    // Entries without an adapterType are dropped.
    expect(readFallbackChain({ fallbackChain: [{ model: "gpt" }, null, 42] })).toEqual([]);
  });
});

describe("readFallbackSourceOverride", () => {
  it("round-trips a persisted override off a run context snapshot", () => {
    const override = { index: 1, adapterType: "codex_local", model: "gpt", env: { A: 1 }, label: "Codex" };
    const snapshot = { issueId: "x", [FALLBACK_SOURCE_CONTEXT_KEY]: override };
    expect(readFallbackSourceOverride(snapshot)).toEqual(override);
  });

  it("ignores absent or invalid overrides", () => {
    expect(readFallbackSourceOverride({ issueId: "x" })).toBeNull();
    expect(readFallbackSourceOverride(null)).toBeNull();
    // index 0 is the default source, never a valid override.
    expect(readFallbackSourceOverride({ [FALLBACK_SOURCE_CONTEXT_KEY]: { index: 0, adapterType: "codex_local" } })).toBeNull();
    expect(readFallbackSourceOverride({ [FALLBACK_SOURCE_CONTEXT_KEY]: { index: 1 } })).toBeNull();
  });
});
