import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FindingInput, ToolGuard } from "@kanna/security";
import { analyzePassive, SecretRedactor } from "@kanna/security";
import type { Finding, TrafficFlow } from "@kanna/shared";
import { OUTPUT_LIMITS, StringEnum } from "@kanna/shared";
import { type Static, type TSchema, Type } from "typebox";

export const KANNA_TOOL_NAMES = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_back",
  "browser_reload",
  "browser_screenshot",
  "browser_get_page",
  "traffic_list",
  "traffic_get",
  "traffic_search",
  "traffic_get_recent",
  "security_observe",
  "security_analyze_passive",
  "security_report_finding",
] as const;

interface BrowserPort {
  navigate(url: string): Promise<unknown>;
  click(selector: string, options?: { text?: string; timeoutMs?: number }): Promise<unknown>;
  type(selector: string, text: string, submit?: boolean): Promise<unknown>;
  pressKey(key: string): Promise<unknown>;
  back(): Promise<unknown>;
  reload(): Promise<unknown>;
  screenshot(fullPage?: boolean): Promise<unknown>;
  getPage(include?: Array<"text" | "forms" | "links" | "inputs">): Promise<unknown>;
}

interface FlowPort {
  list(sessionId: string, filter: Record<string, unknown>): unknown;
  getDetail(
    sessionId: string,
    flowId: string,
  ):
    | { flow: TrafficFlow; requestBodyText?: string; responseBodyText?: string; truncated: boolean }
    | undefined;
  recent(sessionId: string, seconds: number): TrafficFlow[];
  listByAction(actionId: string): TrafficFlow[];
}

interface StatePort {
  compactSnapshot(limits?: Record<string, number>): unknown;
}
interface FindingPort {
  report(sessionId: string, input: FindingInput): Finding;
}

export interface KannaToolDependencies {
  sessionId: string;
  guard: ToolGuard;
  browser: BrowserPort;
  flows: FlowPort;
  state: StatePort;
  findings: FindingPort;
  searchTraffic: (
    query: string,
    field: "url" | "headers" | "bodies",
    limit: number,
  ) => Promise<unknown> | unknown;
  redactor?: SecretRedactor;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

export function createKannaTools(deps: KannaToolDependencies): ToolDefinition[] {
  const redactor = deps.redactor ?? new SecretRedactor();
  const make = <T extends TSchema>(
    name: string,
    description: string,
    parameters: T,
    handler: (params: Static<T>) => Promise<unknown> | unknown,
  ) => {
    const definition: ToolDefinition = {
      name,
      label: name,
      description,
      // pi 0.85.1 pins TypeBox 1.3.7 while the workspace uses 1.3.28. Both emit
      // the same JSON Schema; keep the version boundary inside this facade.
      parameters: parameters as unknown as ToolDefinition["parameters"],
      async execute(_toolCallId, rawParams) {
        const params = rawParams as Static<T>;
        const safeParams = params as Record<string, unknown>;
        const value = await deps.guard.invoke(name, safeParams, async () => handler(params));
        return jsonResult(redactor.redact(value));
      },
    };
    return defineTool(definition);
  };

  const pageInclude = StringEnum(["text", "forms", "links", "inputs"] as const);
  return [
    make(
      "browser_navigate",
      "Navigate the controlled browser to an in-scope URL.",
      Type.Object({ url: Type.String() }),
      (p) => deps.browser.navigate(p.url),
    ),
    make(
      "browser_click",
      "Click one element in the current page.",
      Type.Object({
        selector: Type.String(),
        text: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      (p) => deps.browser.click(p.selector, { text: p.text, timeoutMs: p.timeoutMs }),
    ),
    make(
      "browser_type",
      "Fill an input, optionally submitting it.",
      Type.Object({ selector: Type.String(), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
      (p) => deps.browser.type(p.selector, p.text, p.submit),
    ),
    make(
      "browser_press_key",
      "Press a keyboard key in the current page.",
      Type.Object({ key: Type.String() }),
      (p) => deps.browser.pressKey(p.key),
    ),
    make("browser_back", "Navigate the current page backward.", Type.Object({}), () => deps.browser.back()),
    make("browser_reload", "Reload the current page.", Type.Object({}), () => deps.browser.reload()),
    make(
      "browser_screenshot",
      "Capture a screenshot as local evidence.",
      Type.Object({ fullPage: Type.Optional(Type.Boolean()) }),
      (p) => deps.browser.screenshot(p.fullPage),
    ),
    make(
      "browser_get_page",
      "Return bounded page text, forms, links and inputs.",
      Type.Object({ include: Type.Optional(Type.Array(pageInclude, { maxItems: 4 })) }),
      (p) => deps.browser.getPage(p.include),
    ),
    make(
      "traffic_list",
      "List bounded traffic metadata without bodies.",
      Type.Object({
        host: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        method: Type.Optional(Type.String()),
        status: Type.Optional(Type.Number()),
        actionId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ maximum: OUTPUT_LIMITS.maxListRows })),
        offset: Type.Optional(Type.Number()),
      }),
      (p) => deps.flows.list(deps.sessionId, p),
    ),
    make(
      "traffic_get",
      "Get one captured flow with optional bounded bodies.",
      Type.Object({ flowId: Type.String(), includeBodies: Type.Optional(Type.Boolean()) }),
      (p) => {
        const detail = deps.flows.getDetail(deps.sessionId, p.flowId);
        if (!detail) throw new Error(`Flow not found: ${p.flowId}`);
        return p.includeBodies ? detail : { flow: detail.flow, truncated: detail.truncated };
      },
    ),
    make(
      "traffic_search",
      "Search captured URL, header, or body text with bounded results.",
      Type.Object({
        query: Type.String(),
        in: StringEnum(["url", "headers", "bodies"] as const),
        limit: Type.Optional(Type.Number({ maximum: OUTPUT_LIMITS.maxListRows })),
      }),
      (p) => deps.searchTraffic(p.query, p.in, Math.min(p.limit ?? 20, OUTPUT_LIMITS.maxListRows)),
    ),
    make(
      "traffic_get_recent",
      "Return traffic captured during a recent time window or for an action.",
      Type.Object({
        sinceActionId: Type.Optional(Type.String()),
        seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3600 })),
      }),
      (p) =>
        p.sinceActionId
          ? deps.flows.listByAction(p.sinceActionId)
          : deps.flows.recent(deps.sessionId, p.seconds ?? 30),
    ),
    make("security_observe", "Return a compact application-state snapshot.", Type.Object({}), () =>
      deps.state.compactSnapshot(),
    ),
    make(
      "security_analyze_passive",
      "Run deterministic passive analysis over recent captured traffic.",
      Type.Object({ seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3600 })) }),
      (p) => analyzePassive(deps.flows.recent(deps.sessionId, p.seconds ?? 300)),
    ),
    make(
      "security_report_finding",
      "Persist an evidence-linked finding. Confirmed findings require flow evidence.",
      Type.Object({
        title: Type.String({ maxLength: 500 }),
        category: StringEnum([
          "security-headers",
          "cookie-flags",
          "cors",
          "csp",
          "information-disclosure",
          "sensitive-data",
          "server-fingerprint",
          "secrets",
          "suspicious-parameters",
          "reflected-xss",
          "sql-injection",
          "idor",
          "open-redirect",
          "csrf",
          "path-traversal",
          "authentication",
          "session-management",
          "business-logic",
          "other",
        ] as const),
        severity: StringEnum(["info", "low", "medium", "high", "critical"] as const),
        confidence: StringEnum(["low", "medium", "high"] as const),
        description: Type.String({ maxLength: OUTPUT_LIMITS.maxDescriptionChars }),
        reproduction: Type.String({ maxLength: OUTPUT_LIMITS.maxDescriptionChars }),
        remediation: Type.String({ maxLength: OUTPUT_LIMITS.maxDescriptionChars }),
        status: StringEnum(["suspected", "confirmed", "false_positive", "needs_review"] as const),
        requestIds: Type.Array(Type.String(), { minItems: 1 }),
        evidenceFlowIds: Type.Array(Type.String(), { minItems: 1 }),
        endpointMethod: Type.Optional(Type.String()),
        endpointPath: Type.Optional(Type.String()),
        parameter: Type.Optional(Type.String()),
        wstgIds: Type.Optional(Type.Array(Type.String())),
        cweId: Type.Optional(Type.Number()),
      }),
      (p) =>
        deps.findings.report(deps.sessionId, {
          title: p.title,
          category: p.category,
          severity: p.severity,
          confidence: p.confidence,
          description: p.description,
          reproduction: p.reproduction,
          remediation: p.remediation,
          status: p.status,
          requestIds: p.requestIds,
          evidence: { flowIds: p.evidenceFlowIds },
          endpoint:
            p.endpointMethod && p.endpointPath
              ? { method: p.endpointMethod, pathTemplate: p.endpointPath }
              : undefined,
          parameter: p.parameter,
          wstgIds: p.wstgIds,
          cweId: p.cweId,
        }),
    ),
  ];
}
