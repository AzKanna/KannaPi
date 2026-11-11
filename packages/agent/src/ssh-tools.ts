import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SshCommandResult, SshHost } from "@kanna/shared";
import { Type } from "typebox";

export interface SshToolPort {
  list(): SshHost[];
  execute(
    hostId: string,
    command: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SshCommandResult>;
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

export function createSshTools(port: SshToolPort): ToolDefinition[] {
  return [
    defineTool({
      name: "ssh_list_hosts",
      label: "List SSH Hosts",
      description:
        "List SSH hosts explicitly configured for the current project and their connection state. Use this before ssh_exec to select a connected host id.",
      parameters: Type.Object({}),
      async execute() {
        return result(port.list().map(({ privateKeyPath: _privateKeyPath, ...host }) => host));
      },
    }),
    defineTool({
      name: "ssh_exec",
      label: "Execute SSH Command",
      description:
        "Execute one non-interactive shell command on an SSH host that the user explicitly configured and connected in this project. Do not use a disconnected host and do not invent host ids.",
      parameters: Type.Object({
        hostId: Type.String({ description: "Configured host id returned by ssh_list_hosts" }),
        command: Type.String({
          minLength: 1,
          maxLength: 4_000,
          description: "Exact remote shell command to execute",
        }),
        timeoutSeconds: Type.Optional(
          Type.Number({ minimum: 1, maximum: 120, description: "Command timeout in seconds" }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        return result(
          await port.execute(params.hostId, params.command, {
            timeoutMs: params.timeoutSeconds ? params.timeoutSeconds * 1_000 : undefined,
            signal,
          }),
        );
      },
    }),
  ];
}
