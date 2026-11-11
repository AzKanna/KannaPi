import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import * as z from "zod/v4";
import { connectMcpServer, inspectSkillPath } from "./capabilities.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Agent capabilities", () => {
  it("discovers a valid Agent Skill from an explicit path", async () => {
    const root = await mkdtemp(join(tmpdir(), "kannapi-skill-"));
    temporary.push(root);
    const skillDir = join(root, "skills", "release-helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: release-helper\ndescription: Helps prepare releases\n---\n\n# Instructions\nRun the checks.\n");

    const result = inspectSkillPath({ path: skillDir, cwd: root, agentDir: join(root, ".agent") });

    expect(result.names).toEqual(["release-helper"]);
    expect(result.descriptions).toEqual(["Helps prepare releases"]);
    expect(result.path).toBe(skillDir);
  });

  it("connects to a stdio MCP server and converts its tools for Pi", async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "test-mcp-server.mjs");
    const connection = await connectMcpServer({
      name: "Test Server",
      transport: "stdio",
      command: process.execPath,
      args: [fixture],
    });
    try {
      expect(connection.toolNames).toEqual(["mcp__test_server__echo"]);
      const result = await connection.tools[0]?.execute(
        "call-1",
        { text: "hello" },
        undefined,
        undefined,
        {} as never,
      );
      expect(result?.content).toEqual([{ type: "text", text: "echo:hello" }]);
    } finally {
      await connection.close();
    }
  });

  it("connects to a legacy SSE MCP server", async () => {
    const mcp = new McpServer({ name: "legacy-test", version: "1.0.0" });
    mcp.registerTool(
      "echo",
      { description: "Echo over SSE", inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: "text", text: `sse:${text}` }] }),
    );
    let serverTransport: SSEServerTransport | undefined;
    const http = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET" && url.pathname === "/sse") {
          serverTransport = new SSEServerTransport("/messages", response);
          await mcp.connect(serverTransport);
        } else if (request.method === "POST" && url.pathname === "/messages" && serverTransport) {
          await serverTransport.handlePostMessage(request, response);
        } else {
          response.statusCode = 404;
          response.end();
        }
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("SSE test server did not bind");
    let connection: Awaited<ReturnType<typeof connectMcpServer>> | undefined;
    try {
      connection = await connectMcpServer({
        name: "Burp",
        transport: "sse",
        url: `http://127.0.0.1:${address.port}/sse`,
      });
      expect(connection.toolNames).toEqual(["mcp__burp__echo"]);
      const result = await connection.tools[0]?.execute("call-2", { text: "hello" }, undefined, undefined, {} as never);
      expect(result?.content).toEqual([{ type: "text", text: "sse:hello" }]);
    } finally {
      await connection?.close();
      await mcp.close();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    }
  });
});
