export type PolicyTier = 0 | 1 | 2 | 3;
export interface ToolPolicy {
  tier: PolicyTier;
  requiresTarget?: boolean;
}

const DEFAULT_POLICIES: Record<string, ToolPolicy> = {
  browser_get_page: { tier: 0 },
  browser_get_state: { tier: 0 },
  traffic_list: { tier: 0 },
  traffic_get: { tier: 0 },
  security_observe: { tier: 0 },
  security_analyze_passive: { tier: 0 },
  security_report_finding: { tier: 0 },
  traffic_get_recent: { tier: 0 },
  browser_navigate: { tier: 1, requiresTarget: true },
  browser_click: { tier: 1 },
  browser_type: { tier: 1 },
  browser_press_key: { tier: 1 },
  browser_back: { tier: 1 },
  browser_reload: { tier: 1 },
  browser_screenshot: { tier: 1 },
  browser_wait: { tier: 1 },
  traffic_search: { tier: 2 },
  traffic_replay: { tier: 3, requiresTarget: true },
  security_execute_test: { tier: 3, requiresTarget: true },
};

export class PolicyEngine {
  private readonly policies: Map<string, ToolPolicy>;
  constructor(overrides: Record<string, ToolPolicy> = {}) {
    this.policies = new Map(Object.entries({ ...DEFAULT_POLICIES, ...overrides }));
  }
  get(toolName: string, params: Record<string, unknown> = {}): ToolPolicy {
    const policy = this.policies.get(toolName);
    if (!policy) throw new Error(`No policy registered for tool '${toolName}'`);
    if (toolName === "traffic_get" && params.includeBodies === true) return { ...policy, tier: 2 };
    return policy;
  }
}
