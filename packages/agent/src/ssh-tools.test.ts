import { describe, expect, test, vi } from "vitest";
import { createSshTools } from "./ssh-tools.js";

describe("SSH Agent tools", () => {
  test("lists configured hosts without exposing private key paths and executes a command", async () => {
    const execute = vi.fn(async () => ({
      id: "sshcmd_1",
      hostId: "ssh_1",
      actor: "agent" as const,
      command: "uname -a",
      stdout: "Linux\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      startedAt: 1,
      endedAt: 2,
    }));
    const tools = createSshTools({
      list: () => [
        {
          id: "ssh_1",
          projectId: "prj_1",
          name: "Lab",
          host: "127.0.0.1",
          port: 22,
          username: "tester",
          authType: "private-key",
          privateKeyPath: "C:/secret/key",
          status: "connected",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      execute,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["ssh_list_hosts", "ssh_exec"]);
    const listed = await tools[0]?.execute("call_1", {}, undefined, undefined, {} as never);
    expect(JSON.stringify(listed)).not.toContain("privateKeyPath");
    const result = await tools[1]?.execute(
      "call_2",
      { hostId: "ssh_1", command: "uname -a", timeoutSeconds: 12 },
      undefined,
      undefined,
      {} as never,
    );
    expect(execute).toHaveBeenCalledWith("ssh_1", "uname -a", {
      timeoutMs: 12_000,
      signal: undefined,
    });
    expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Linux") });
  });
});
