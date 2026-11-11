import type { FindingCategory, Observation, Severity, TrafficFlow } from "@kanna/shared";
import { newId } from "@kanna/shared";

const SUSPICIOUS_PARAMETERS =
  /^(redirect|return|return_url|next|url|uri|callback|continue|dest|destination|file|filename|path|template|cmd|command|exec|query|search|id|uid|user_id|account_id|tenant_id|role|admin)$/i;
const SECRET_PATTERN =
  /(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*["']?\s*[:=]\s*["']?[^\s,"';}]{8,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

function header(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function isHtml(flow: TrafficFlow): boolean {
  const contentType = (flow.contentType ?? header(flow.responseHeaders, "content-type") ?? "").toLowerCase();
  return (
    contentType.includes("text/html") ||
    /^\s*<!doctype\s+html|^\s*<html\b/i.test(flow.responseBody?.textPreview ?? "")
  );
}

function observation(
  flow: TrafficFlow,
  moduleId: string,
  category: FindingCategory,
  title: string,
  detail: string,
  severityHint: Severity,
  wstgIds?: string[],
): Observation {
  return {
    id: newId("obs"),
    moduleId,
    category,
    title,
    detail,
    flowId: flow.id,
    severityHint,
    wstgIds,
    timestamp: flow.timestampEnd ?? flow.timestampStart,
  };
}

function defensiveHeaders(flow: TrafficFlow): Observation | undefined {
  if (flow.statusCode === undefined) return undefined;
  const missing: string[] = [];
  if (!header(flow.responseHeaders, "x-content-type-options")) missing.push("X-Content-Type-Options");
  let url: URL | undefined;
  try {
    url = new URL(flow.url);
  } catch {
    /* malformed captured URL */
  }
  if (url?.protocol === "https:" && !header(flow.responseHeaders, "strict-transport-security"))
    missing.push("Strict-Transport-Security");
  if (isHtml(flow)) {
    const csp = header(flow.responseHeaders, "content-security-policy");
    if (!csp) missing.push("Content-Security-Policy");
    if (!header(flow.responseHeaders, "x-frame-options") && !/\bframe-ancestors\b/i.test(csp ?? ""))
      missing.push("X-Frame-Options/frame-ancestors");
    if (!header(flow.responseHeaders, "referrer-policy")) missing.push("Referrer-Policy");
    if (!header(flow.responseHeaders, "permissions-policy")) missing.push("Permissions-Policy");
  }
  return missing.length
    ? observation(
        flow,
        "security-headers",
        "security-headers",
        "Missing contextual defensive headers",
        missing.join(", "),
        "low",
        ["WSTG-CONF-14"],
      )
    : undefined;
}

function cookieObservations(flow: TrafficFlow): Observation[] {
  const setCookie = header(flow.responseHeaders, "set-cookie");
  if (!setCookie) return [];
  const cookies = setCookie.split(/,(?=\s*[^;,=\s]+=[^;])/);
  const secureTransport = (() => {
    try {
      return new URL(flow.url).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const output: Observation[] = [];
  for (const raw of cookies.slice(0, 20)) {
    const name = raw.split("=", 1)[0]?.trim() || "cookie";
    const missing = [
      !/;\s*httponly\b/i.test(raw) ? "HttpOnly" : undefined,
      secureTransport && !/;\s*secure\b/i.test(raw) ? "Secure" : undefined,
      !/;\s*samesite\s*=/i.test(raw) ? "SameSite" : undefined,
    ].filter(Boolean);
    if (missing.length)
      output.push(
        observation(
          flow,
          "cookie-flags",
          "cookie-flags",
          `Cookie ${name} is missing ${missing.join(", ")}`,
          "Review the cookie attributes in the captured Set-Cookie header",
          "medium",
          ["WSTG-SESS-02"],
        ),
      );
    if (/;\s*samesite\s*=\s*none\b/i.test(raw) && !/;\s*secure\b/i.test(raw))
      output.push(
        observation(
          flow,
          "cookie-samesite",
          "cookie-flags",
          `Cookie ${name} uses SameSite=None without Secure`,
          "Browsers may reject this cookie; verify the intended cross-site session behavior",
          "medium",
          ["WSTG-SESS-02"],
        ),
      );
  }
  return output;
}

function corsObservation(flow: TrafficFlow): Observation | undefined {
  const allowedOrigin = header(flow.responseHeaders, "access-control-allow-origin");
  if (!allowedOrigin) return undefined;
  const credentials =
    header(flow.responseHeaders, "access-control-allow-credentials")?.toLowerCase() === "true";
  const requestOrigin = header(flow.requestHeaders, "origin");
  const vary = header(flow.responseHeaders, "vary") ?? "";
  if (allowedOrigin === "*" && credentials)
    return observation(
      flow,
      "cors",
      "cors",
      "Invalid wildcard credentialed CORS policy",
      "Access-Control-Allow-Origin is * while credentials are enabled",
      "medium",
      ["WSTG-CLNT-07"],
    );
  if (requestOrigin && allowedOrigin === requestOrigin && credentials)
    return observation(
      flow,
      "cors",
      "cors",
      "Credentialed request origin was allowed",
      /(?:^|,)\s*origin\s*(?:,|$)/i.test(vary)
        ? `The response allowed ${requestOrigin}; verify that the server uses an explicit allowlist`
        : `The response allowed ${requestOrigin} without Vary: Origin`,
      "medium",
      ["WSTG-CLNT-07"],
    );
  if (allowedOrigin === "*")
    return observation(
      flow,
      "cors",
      "cors",
      "Wildcard CORS policy observed",
      "Public cross-origin reads are allowed; confirm that the response contains only public data",
      "info",
      ["WSTG-CLNT-07"],
    );
  return undefined;
}

export function analyzePassive(flows: TrafficFlow[]): Observation[] {
  const output: Observation[] = [];
  for (const flow of flows) {
    const headers = defensiveHeaders(flow);
    if (headers) output.push(headers);
    output.push(...cookieObservations(flow));
    const cors = corsObservation(flow);
    if (cors) output.push(cors);

    const csp = header(flow.responseHeaders, "content-security-policy");
    if (csp && (/\bunsafe-eval\b/i.test(csp) || /\bunsafe-inline\b/i.test(csp)))
      output.push(
        observation(
          flow,
          "csp-policy",
          "csp",
          "Content Security Policy permits unsafe script behavior",
          ["unsafe-inline", "unsafe-eval"].filter((item) => csp.includes(`'${item}'`)).join(", "),
          "low",
          ["WSTG-CONF-12"],
        ),
      );

    const server = header(flow.responseHeaders, "server") ?? header(flow.responseHeaders, "x-powered-by");
    if (server)
      output.push(
        observation(
          flow,
          "server-fingerprint",
          "server-fingerprint",
          "Technology disclosed by response headers",
          server.slice(0, 200),
          /\d+\.\d+/.test(server) ? "low" : "info",
          ["WSTG-INFO-08"],
        ),
      );

    const preview = flow.responseBody?.textPreview ?? "";
    if (
      /\b(stack trace|stacktrace|exception|traceback|sql syntax|fatal error|undefined index|at [\w.$]+\([^)]*:\d+\))\b/i.test(
        preview,
      )
    )
      output.push(
        observation(
          flow,
          "information-disclosure",
          "information-disclosure",
          "Verbose error information disclosed",
          preview.slice(0, 300),
          "medium",
          ["WSTG-ERRH-01"],
        ),
      );
    if (SECRET_PATTERN.test(preview))
      output.push(
        observation(
          flow,
          "secrets",
          "secrets",
          "Potential secret-shaped value in response",
          "A key, token, password, private-key marker or JWT-shaped value was detected; inspect the evidence manually",
          "high",
          ["WSTG-INFO-05"],
        ),
      );

    const hasAuth = Boolean(
      header(flow.requestHeaders, "authorization") ||
        header(flow.requestHeaders, "cookie") ||
        header(flow.requestHeaders, "x-api-key"),
    );
    const cacheControl = header(flow.responseHeaders, "cache-control") ?? "";
    if (hasAuth && flow.statusCode && flow.statusCode < 400 && !/\b(no-store|private)\b/i.test(cacheControl))
      output.push(
        observation(
          flow,
          "authenticated-cache",
          "sensitive-data",
          "Authenticated response lacks an explicit private cache policy",
          cacheControl ? `Observed Cache-Control: ${cacheControl}` : "No Cache-Control header was observed",
          "low",
          ["WSTG-ATHN-06"],
        ),
      );

    if (isHtml(flow)) {
      let securePage = false;
      try {
        securePage = new URL(flow.url).protocol === "https:";
      } catch {
        /* malformed URL */
      }
      if (securePage && /(?:src|href)\s*=\s*["']http:\/\//i.test(preview))
        output.push(
          observation(
            flow,
            "mixed-content",
            "sensitive-data",
            "Potential mixed content in an HTTPS page",
            "An HTTP resource reference was observed in the captured HTML preview",
            "low",
            ["WSTG-CRYP-03"],
          ),
        );
    }

    try {
      const names = [...new URL(flow.url).searchParams.keys()].filter((name) =>
        SUSPICIOUS_PARAMETERS.test(name),
      );
      if (names.length)
        output.push(
          observation(
            flow,
            "suspicious-parameters",
            "suspicious-parameters",
            "Security-sensitive parameters observed",
            [...new Set(names)].join(", "),
            "info",
            ["WSTG-INFO-06"],
          ),
        );
    } catch {
      /* ignore malformed URL */
    }
  }
  return output;
}
