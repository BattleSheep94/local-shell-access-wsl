import { text, tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics } from "./configSchematics";
import {
  describeEnvironment,
  formatRunResult,
  resolveShellTarget,
  runShell,
  type ShellSettings,
} from "./shell";

export async function toolsProvider(ctl: ToolsProviderController) {
  const config = ctl.getPluginConfig(configSchematics);

  const getSettings = (): ShellSettings => ({
    defaultTarget: config.get("defaultTarget"),
    shell: config.get("shell"),
    loginShell: config.get("loginShell"),
    defaultCwd: config.get("defaultCwd"),
    wslDistro: config.get("wslDistro"),
    wslUser: config.get("wslUser"),
    wslShell: config.get("wslShell"),
    wslLoginShell: config.get("wslLoginShell"),
    wslInteractiveShell: config.get("wslInteractiveShell"),
    wslDefaultCwd: config.get("wslDefaultCwd"),
    timeoutMs: config.get("timeoutMs"),
    maxOutputBytes: config.get("maxOutputBytes"),
  });

  const shellExecTool = tool({
    name: "shell_exec",
    description: text`
      Run a command in the user's local shell and return its stdout, stderr, and exit code.
      The command can run on the host system or inside WSL. The command string is passed
      to the selected shell with -c, so pipes, redirects, &&, ||, globs, command
      substitution, and quoting all work as in a normal terminal.

      Each call spawns a fresh shell process — there is no persistent session, so cwd and
      environment changes do not carry over between calls. To run multiple steps with shared
      state, chain them in one command (e.g. "cd /tmp && ls && cat foo.txt") or pass cwd.

      The user's login profile is sourced by default for POSIX shells, including WSL.
      For WSL calls, cwd accepts Linux paths and Windows paths. Output is capped per
      stream — long outputs are truncated with a marker. Bash aliases from ~/.bashrc
      or ~/.bash_aliases require the WSL interactive shell option.
    `,
    parameters: {
      command: z.string().min(1).describe(
        "Shell command to run, exactly as you would type it at the terminal.",
      ),
      target: z.enum(["host", "wsl"]).optional().describe(
        "Where to run the command. Defaults to the plugin's configured default target.",
      ),
      cwd: z.string().optional().describe(
        "Path to run the command in. For host commands, use a host absolute path. For WSL commands, Linux paths and Windows paths are accepted.",
      ),
      timeout_ms: z.number().int().min(100).max(600000).optional().describe(
        "Override the default timeout for this call. The command is killed if it runs longer.",
      ),
      env: z.record(z.string()).optional().describe(
        "Extra environment variables to set for this command, merged on top of the inherited environment.",
      ),
    },
    implementation: async (
      { command, target, cwd, timeout_ms, env },
      { signal, status },
    ) => {
      const settings = getSettings();
      const selectedTarget = target ?? resolveShellTarget(settings.defaultTarget);
      status(
        `Running on ${selectedTarget}: ${
          command.length > 80 ? command.slice(0, 77) + "..." : command
        }`,
      );
      const result = await runShell(settings, command, {
        signal,
        target,
        cwd,
        timeoutMs: timeout_ms,
        env,
      });
      return formatRunResult(result, settings.maxOutputBytes);
    },
  });

  const shellInfoTool = tool({
    name: "shell_info",
    description: text`
      Return information about the shell environment commands will run in: which shell binary
      is used, the args it is invoked with, the default working directory, the user, the
      hostname, and the platform. Useful as a first call to orient yourself before running
      anything destructive. For WSL, this probes inside the selected distribution so user,
      homeDir, platform, and defaultCwd describe the Linux environment rather than the
      Windows host process.
    `,
    parameters: {
      target: z.enum(["host", "wsl"]).optional().describe(
        "Environment target to inspect. Defaults to the plugin's configured default target.",
      ),
    },
    implementation: async ({ target }) => {
      return await describeEnvironment(getSettings(), target);
    },
  });

  return [shellExecTool, shellInfoTool];
}
