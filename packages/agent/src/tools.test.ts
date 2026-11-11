import { ApprovalManager, AuditLogger, PolicyEngine, RateLimiter, ToolGuard } from "@kanna/security";
import { defaultLocalScope } from "@kanna/shared";
import { describe, expect, test, vi } from "vitest";
import { createKannaTools, KANNA_TOOL_NAMES } from "./index.js";

describe("Kanna tool factory", () => {
  test("registers exactly the 15 guarded Phase 1 tools", async () => {
    const audit = vi.fn();
    const guard = new ToolGuard({
      scope: defaultLocalScope([3000]),
      policy: new PolicyEngine(),
      rateLimiter: new RateLimiter(100),
      approvals: new ApprovalManager(async () => "denied"),
      audit: new AuditLogger({ append: audit }),
    });
    const deps = {
      sessionId: "sess_1",
      guard,
      browser: {
        navigate: vi.fn(),
        click: vi.fn(),
        type: vi.fn(),
        pressKey: vi.fn(),
        back: vi.fn(),
        reload: vi.fn(),
        screenshot: vi.fn(),
        getPage: vi.fn(),
      },
      flows: {
        list: vi.fn(),
        getDetail: vi.fn(),
        recent: vi.fn(() => []),
        listByAction: vi.fn(),
      },
      state: { compactSnapshot: vi.fn(() => ({ state: { sessionId: "sess_1" }, counts: {} })) },
      findings: { report: vi.fn() },
      searchTraffic: vi.fn(),
    };
    const tools = createKannaTools(deps);
    expect(tools.map((t) => t.name)).toEqual(KANNA_TOOL_NAMES);
    expect(new Set(tools.map((t) => t.name)).size).toBe(15);

    const observe = tools.find((t) => t.name === "security_observe");
    const result = await observe?.execute("call_1", {}, undefined, undefined, {} as never);
    expect(result?.content[0]).toMatchObject({ type: "text" });
    expect(deps.state.compactSnapshot).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalled();
  });
});
