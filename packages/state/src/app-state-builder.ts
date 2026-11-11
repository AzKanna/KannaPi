import type {
  ApplicationState,
  CookieSummary,
  Endpoint,
  FormRecord,
  PageRecord,
  ParameterIndex,
  ParameterLocation,
  TechnologyFingerprint,
  TrafficFlow,
} from "@kanna/shared";
import { newId } from "@kanna/shared";

export interface EndpointWriter {
  save(sessionId: string, endpoint: Endpoint): void;
}
export interface SnapshotLimits {
  endpoints?: number;
  parameters?: number;
  pages?: number;
  forms?: number;
  graph?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const INTEGER = /^\d+$/;
const SENSITIVE_PARAMETER = /password|passwd|secret|token|authorization|cookie|api[_-]?key/i;

function dynamicSegment(value: string): boolean {
  return INTEGER.test(value) || UUID.test(value) || LONG_HEX.test(value);
}

export function normalizePath(path: string): string {
  const clean = path.split("?", 1)[0] || "/";
  return (
    clean
      .split("/")
      .map((part) => (dynamicSegment(part) ? ":param" : part))
      .join("/") || "/"
  );
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function addBounded<T>(values: T[] | undefined, value: T, max = 10): T[] {
  const next = unique([...(values ?? []), value]);
  return next.slice(-max);
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function parseCookies(header: string | undefined): CookieSummary[] {
  if (!header) return [];
  return header
    .split(/,(?=[^;,]+=)/)
    .map((raw) => {
      const parts = raw.split(";").map((s) => s.trim());
      const [name = ""] = (parts[0] ?? "").split("=", 1);
      const attrs = parts.slice(1);
      const attrValue = (key: string) =>
        attrs
          .find((a) => a.toLowerCase().startsWith(`${key.toLowerCase()}=`))
          ?.split("=")
          .slice(1)
          .join("=");
      return {
        name,
        domain: attrValue("domain"),
        path: attrValue("path"),
        secure: attrs.some((a) => a.toLowerCase() === "secure"),
        httpOnly: attrs.some((a) => a.toLowerCase() === "httponly"),
        sameSite: attrValue("samesite"),
        session: !attrs.some((a) => /^(expires|max-age)=/i.test(a)),
      };
    })
    .filter((c) => c.name.length > 0);
}

function requestParameters(
  flow: TrafficFlow,
): Array<{ name: string; location: ParameterLocation; value: unknown }> {
  const values: Array<{ name: string; location: ParameterLocation; value: unknown }> = [];
  try {
    const url = new URL(flow.url);
    for (const [name, value] of url.searchParams) values.push({ name, location: "query", value });
    const segments = url.pathname.split("/").filter(Boolean);
    segments.forEach((segment, index) => {
      if (!dynamicSegment(segment)) return;
      const previous = segments[index - 1]?.replace(/[^a-z0-9_]+/gi, "_") || "segment";
      values.push({
        name: `${previous.replace(/s$/i, "") || previous}_id`,
        location: "path",
        value: segment,
      });
    });
  } catch {
    /* malformed proxy input is ignored here */
  }
  const contentType = getHeader(flow.requestHeaders, "content-type")?.toLowerCase() ?? "";
  const preview = flow.requestBody?.textPreview;
  if (preview && contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(preview) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed)) {
          values.push({
            name,
            location: "body",
            value: SENSITIVE_PARAMETER.test(name) ? "[REDACTED]" : value,
          });
        }
      }
    } catch {
      /* a truncated JSON preview is expected sometimes */
    }
  } else if (preview && contentType.includes("application/x-www-form-urlencoded")) {
    for (const [name, value] of new URLSearchParams(preview)) {
      values.push({
        name,
        location: "body",
        value: SENSITIVE_PARAMETER.test(name) ? "[REDACTED]" : value,
      });
    }
  }
  for (const [name, value] of Object.entries(flow.requestHeaders)) {
    if (/^x-/i.test(name) || ["authorization", "proxy-authorization"].includes(name.toLowerCase())) {
      values.push({
        name: name.toLowerCase(),
        location: "header",
        value: SENSITIVE_PARAMETER.test(name) ? "[present]" : value.slice(0, 200),
      });
    }
  }
  return values;
}

export class AppStateBuilder {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly parameters = new Map<string, ParameterIndex>();
  private readonly pages = new Map<string, PageRecord>();
  private readonly forms: FormRecord[] = [];
  private readonly cookies = new Map<string, CookieSummary>();
  private readonly technologies = new Map<string, TechnologyFingerprint>();
  private readonly graph = new Map<string, string[]>();
  private readonly tokenHeaders = new Set<string>();
  private readonly authEvidence = new Set<string>();
  private readonly findings = new Set<string>();
  private readonly testedHypotheses = new Set<string>();
  private updatedAt = Date.now();

  constructor(
    readonly sessionId: string,
    private readonly endpointWriter?: EndpointWriter,
  ) {}

  consume(flow: TrafficFlow): Endpoint {
    if (flow.sessionId !== this.sessionId) throw new Error(`flow ${flow.id} belongs to a different session`);
    const pathTemplate = normalizePath(flow.path || new URL(flow.url).pathname);
    const key = `${flow.host}\0${flow.method.toUpperCase()}\0${pathTemplate}`;
    const existing = this.endpoints.get(key);
    const parameters = requestParameters(flow);
    const endpoint =
      existing ??
      ({
        id: newId("ep"),
        host: flow.host,
        method: flow.method.toUpperCase(),
        pathTemplate,
        parameters: [],
        contentTypes: [],
        authRequired: "unknown",
        observedStatusCodes: [],
        observedFromFlowIds: [],
        firstSeen: flow.timestampStart,
        lastSeen: flow.timestampStart,
        testState: "untested",
      } satisfies Endpoint);

    endpoint.lastSeen = Math.max(endpoint.lastSeen, flow.timestampEnd ?? flow.timestampStart);
    if (flow.statusCode !== undefined)
      endpoint.observedStatusCodes = addBounded(endpoint.observedStatusCodes, flow.statusCode, 20);
    if (flow.contentType) endpoint.contentTypes = addBounded(endpoint.contentTypes, flow.contentType, 10);
    endpoint.observedFromFlowIds = addBounded(endpoint.observedFromFlowIds, flow.id, 20);

    const authHeader = Object.keys(flow.requestHeaders).find((h) =>
      ["authorization", "proxy-authorization", "x-api-key"].includes(h.toLowerCase()),
    );
    const requestCookie = getHeader(flow.requestHeaders, "cookie");
    if (authHeader) {
      this.tokenHeaders.add(authHeader.toLowerCase());
      this.authEvidence.add(flow.id);
    }
    if (requestCookie) this.authEvidence.add(flow.id);
    if (authHeader || requestCookie) endpoint.authRequired = true;

    for (const parameter of parameters) {
      this.mergeEndpointParameter(endpoint, parameter.name, parameter.location, parameter.value);
      this.mergeParameterIndex(endpoint, flow.id, parameter.name, parameter.location, parameter.value);
    }
    this.endpoints.set(key, endpoint);
    this.endpointWriter?.save(this.sessionId, endpoint);

    for (const cookie of parseCookies(getHeader(flow.responseHeaders, "set-cookie"))) {
      this.cookies.set(cookie.name, cookie);
      this.authEvidence.add(flow.id);
    }
    this.addTechnology(
      getHeader(flow.responseHeaders, "server"),
      "server",
      "Server response header",
      flow.id,
    );
    this.addTechnology(
      getHeader(flow.responseHeaders, "x-powered-by"),
      "framework",
      "X-Powered-By response header",
      flow.id,
    );
    if (flow.browserActionId)
      this.graph.set(flow.browserActionId, addBounded(this.graph.get(flow.browserActionId), flow.id, 100));
    this.updatedAt = Math.max(this.updatedAt, flow.timestampEnd ?? flow.timestampStart);
    return endpoint;
  }

  addPage(page: PageRecord, forms: FormRecord[] = []): void {
    this.pages.set(page.url, page);
    this.forms.push(...forms);
    this.updatedAt = Math.max(this.updatedAt, page.timestamp);
  }

  addFinding(id: string): void {
    this.findings.add(id);
  }
  addTestedHypothesis(id: string): void {
    this.testedHypotheses.add(id);
  }

  snapshot(): ApplicationState {
    return {
      sessionId: this.sessionId,
      updatedAt: this.updatedAt,
      pages: [...this.pages.values()],
      endpoints: [...this.endpoints.values()].sort((a, b) => b.lastSeen - a.lastSeen),
      parameters: [...this.parameters.values()],
      forms: [...this.forms],
      authState: {
        loggedIn: this.authEvidence.size > 0 ? true : undefined,
        cookieNames: [...this.cookies.keys()],
        tokenHeaders: [...this.tokenHeaders],
        evidence: [...this.authEvidence].slice(-20),
      },
      cookies: [...this.cookies.values()],
      technologies: [...this.technologies.values()],
      trafficGraph: [...this.graph].map(([actionId, flowIds]) => ({ actionId, flowIds })),
      findings: [...this.findings],
      testedHypotheses: [...this.testedHypotheses],
    };
  }

  compactSnapshot(limits: SnapshotLimits = {}): { state: ApplicationState; counts: Record<string, number> } {
    const state = this.snapshot();
    const counts = {
      endpoints: state.endpoints.length,
      parameters: state.parameters.length,
      pages: state.pages.length,
      forms: state.forms.length,
      graph: state.trafficGraph.length,
    };
    state.endpoints = state.endpoints.slice(0, limits.endpoints ?? 50);
    state.parameters = state.parameters.slice(0, limits.parameters ?? 100);
    state.pages = state.pages.slice(0, limits.pages ?? 30);
    state.forms = state.forms.slice(0, limits.forms ?? 30);
    state.trafficGraph = state.trafficGraph.slice(-(limits.graph ?? 50));
    return { state, counts };
  }

  private mergeEndpointParameter(
    endpoint: Endpoint,
    name: string,
    location: ParameterLocation,
    value: unknown,
  ): void {
    let parameter = endpoint.parameters.find((p) => p.name === name);
    if (!parameter) {
      parameter = { name, locations: [] };
      endpoint.parameters.push(parameter);
    }
    parameter.locations = addBounded(parameter.locations, location, 4);
    parameter.observedTypes = addBounded(parameter.observedTypes, valueType(value), 8);
    parameter.sampleValues = addBounded(parameter.sampleValues, value, 5);
  }

  private mergeParameterIndex(
    endpoint: Endpoint,
    flowId: string,
    name: string,
    location: ParameterLocation,
    value: unknown,
  ): void {
    const item = this.parameters.get(name) ?? { name, locations: [], endpoints: [], flowIds: [] };
    item.locations = addBounded(item.locations, location, 4);
    if (
      !item.endpoints.some(
        (e) =>
          e.host === endpoint.host &&
          e.method === endpoint.method &&
          e.pathTemplate === endpoint.pathTemplate,
      )
    )
      item.endpoints.push({
        host: endpoint.host,
        method: endpoint.method,
        pathTemplate: endpoint.pathTemplate,
      });
    item.sampleValues = addBounded(item.sampleValues, value, 5);
    item.flowIds = addBounded(item.flowIds, flowId, 20);
    this.parameters.set(name, item);
  }

  private addTechnology(
    name: string | undefined,
    category: TechnologyFingerprint["category"],
    header: string,
    flowId: string,
  ): void {
    if (!name) return;
    const key = `${category}:${name}`;
    this.technologies.set(key, { name, category, evidence: `${header} in ${flowId}`, confidence: "high" });
  }
}
