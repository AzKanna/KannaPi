import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { IngestHttpHandler } from "@kanna/traffic";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function existingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(message);
}

/** Serve the built React application from the same origin as the REST/WS API. */
export function createStaticWebHandler(webRoot: string): IngestHttpHandler {
  const root = resolve(webRoot);
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;
    void (async () => {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      } catch {
        sendError(response, 400, "Invalid request path");
        return;
      }
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      let candidate = resolve(root, relative);
      if (!withinRoot(root, candidate)) {
        sendError(response, 403, "Forbidden");
        return;
      }
      if (!(await existingFile(candidate))) {
        if (extname(pathname)) {
          sendError(response, 404, "Not found");
          return;
        }
        candidate = resolve(root, "index.html");
      }
      if (!(await existingFile(candidate))) {
        sendError(response, 404, "Web application is not built");
        return;
      }
      const extension = extname(candidate).toLowerCase();
      const bytes = await readFile(candidate);
      response.statusCode = 200;
      response.setHeader("content-type", CONTENT_TYPES[extension] ?? "application/octet-stream");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
      response.setHeader(
        "cache-control",
        extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      );
      response.setHeader("content-length", String(bytes.length));
      response.end(method === "HEAD" ? undefined : bytes);
    })().catch((error) => {
      if (!response.headersSent) sendError(response, 500, "Failed to load the web application");
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    return true;
  };
}
