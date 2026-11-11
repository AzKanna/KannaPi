import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const server = new McpServer({ name: "kannapi-test", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text for integration testing", inputSchema: z.object({ text: z.string() }) },
  async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
);
await server.connect(new StdioServerTransport());
