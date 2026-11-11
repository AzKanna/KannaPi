/**
 * IngestServer — local HTTP+WS server the mitmproxy addon connects to.
 * Path /proxy only (the UI bus on /ui is attached by the app layer).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { isProxyEvent, PROXY_DEFAULTS, type ProxyEvent, WS_PATHS } from "@kanna/shared";
import { type WebSocket, WebSocketServer } from "ws";

export interface IngestServerOptions {
  host?: string;
  /** 0 = ephemeral. */
  port?: number;
  onProxyEvent(ev: ProxyEvent): void;
  onInvalidMessage?(issues: string): void;
}

export type IngestHttpHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

export class IngestServer {
  private httpServer: Server;
  private wss: WebSocketServer;
  private actualPort = 0;
  private invalidCount = 0;
  private httpHandler?: IngestHttpHandler;
  private readonly websocketRoutes = new Map<string, WebSocketServer>();
  private readonly opts: IngestServerOptions;
  private proxyEventHandler: (event: ProxyEvent) => void;

  constructor(options: IngestServerOptions) {
    this.opts = { host: PROXY_DEFAULTS.ingestHost, port: 0, ...options };
    this.proxyEventHandler = options.onProxyEvent;
    this.httpServer = createServer((req, res) => {
      if (this.httpHandler?.(req, res)) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "kanna-ingest" }));
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.websocketRoutes.set(WS_PATHS.proxyIngest, this.wss);
    this.httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const route = this.websocketRoutes.get(path);
      if (!route) {
        socket.destroy();
        return;
      }
      route.handleUpgrade(request, socket, head, (ws) => route.emit("connection", ws, request));
    });
    this.wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          this.invalidCount++;
          this.opts.onInvalidMessage?.("non-JSON message");
          return;
        }
        if (isProxyEvent(parsed)) {
          this.proxyEventHandler(parsed);
        } else {
          this.invalidCount++;
          this.opts.onInvalidMessage?.(`invalid proxy event: ${JSON.stringify(parsed).slice(0, 200)}`);
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.opts.port, this.opts.host, () => resolve());
    });
    const addr = this.httpServer.address();
    this.actualPort = typeof addr === "object" && addr ? addr.port : (this.opts.port ?? 0);
  }

  get port(): number {
    return this.actualPort;
  }

  /** Shared HTTP server used by the REST API and /ui WebSocket bus. */
  get rawHttpServer(): Server {
    return this.httpServer;
  }

  /** Backward-compatible descriptive alias used by the app layer. */
  get server(): Server {
    return this.httpServer;
  }

  setHttpHandler(handler: IngestHttpHandler): void {
    this.httpHandler = handler;
  }

  setProxyEventHandler(handler: (event: ProxyEvent) => void): void {
    this.proxyEventHandler = handler;
  }

  /** Send an interception control command to the connected local proxy addon. */
  sendProxyCommand(command: Record<string, unknown>): boolean {
    const payload = JSON.stringify(command);
    let delivered = false;
    for (const client of this.wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      client.send(payload);
      delivered = true;
    }
    return delivered;
  }

  registerWebSocketPath(path: string, server: WebSocketServer): () => void {
    if (this.websocketRoutes.has(path)) throw new Error(`WebSocket path already registered: ${path}`);
    this.websocketRoutes.set(path, server);
    return () => this.websocketRoutes.delete(path);
  }

  /** URL for the addon's kanna_ingest_url option. */
  get ingestUrl(): string {
    return `ws://${this.opts.host}:${this.actualPort}${WS_PATHS.proxyIngest}`;
  }

  getInvalidCount(): number {
    return this.invalidCount;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
