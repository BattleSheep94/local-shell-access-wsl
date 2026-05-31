import { text, tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics } from "./configSchematics";
import {
  describeEnvironment,
  formatRunResult,
  listShellSessions,
  readShellSession,
  resolveShellTarget,
  runShell,
  startShellSession,
  stopShellSession,
  writeShellSession,
  type ShellSettings,
} from "./shell";

function findRiskyCommandReasons(command: string): string[] {
  const reasons: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/, "recursive/forced deletion"],
    [/\b(?:mkfs|fdisk|parted|diskpart|format)\b/i, "disk or filesystem modification"],
    [/\b(?:shutdown|reboot|poweroff|halt)\b/i, "system shutdown or reboot"],
    [/\b(?:apt|apt-get|dnf|yum|pacman|zypper|brew|winget|choco)\b[^\n;&|]*(?:upgrade|dist-upgrade|remove|purge|autoremove|install|uninstall)\b/i, "package installation/removal/upgrade"],
    [/\b(?:git\s+push|git\s+reset\s+--hard|git\s+clean\s+-[^\n;&|]*f)\b/i, "repository mutation"],
    [/\b(?:sudo|doas)\b/i, "privileged execution"],
    [/\b(?:ssh|scp|rsync)\b/i, "remote system access or transfer"],
    [/[>|]\s*\/(?:etc|boot|usr|bin|sbin|lib|lib64|root)\b/i, "writing to sensitive system paths"],
  ];

  for (const [pattern, reason] of checks) {
    if (pattern.test(command)) reasons.push(reason);
  }

  return Array.from(new Set(reasons));
}

function formatRiskyCommandRefusal(command: string, reasons: string[]): string {
  return [
    "[confirmation required]",
    "",
    "This command may be irreversible or security-sensitive:",
    command,
    "",
    `Reason(s): ${reasons.join(", ")}`,
    "",
    "Ask the user for explicit confirmation, explain the target system and expected effect, then call the tool again with confirmed_irreversible: true.",
  ].join("\n");
}

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
      confirmed_irreversible: z.boolean().optional().describe(
        "Set to true only after the user explicitly confirms a risky, destructive, privileged, or remote command.",
      ),
    },
    implementation: async (
      { command, target, cwd, timeout_ms, env, confirmed_irreversible },
      { signal, status },
    ) => {
      const riskyReasons = findRiskyCommandReasons(command);
      if (riskyReasons.length > 0 && confirmed_irreversible !== true) {
        return formatRiskyCommandRefusal(command, riskyReasons);
      }

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

  const sessionStartTool = tool({
    name: "shell_session_start",
    description: text`
      Start a persistent shell session on the host or in WSL. Use this when state must survive
      across steps, such as an activated Python virtual environment, an SSH session, or a command
      that asks follow-up questions. This is not a full terminal emulator and may not satisfy
      programs that require a real TTY, but stdin/stdout/stderr stay connected across calls.
    `,
    parameters: {
      target: z.enum(["host", "wsl"]).optional().describe(
        "Where to start the session. Defaults to the plugin's configured default target.",
      ),
      cwd: z.string().optional().describe(
        "Path to start the session in. For WSL, Linux paths, Windows paths, and WSL UNC paths are accepted.",
      ),
      env: z.record(z.string()).optional().describe(
        "Extra environment variables to set when starting the session.",
      ),
      interactive_shell: z.boolean().optional().describe(
        "Override whether to start an interactive shell. For WSL Bash this loads ~/.bashrc and enables aliases.",
      ),
      read_delay_ms: z.number().int().min(0).max(10000).optional().describe(
        "Milliseconds to wait for initial output before returning.",
      ),
    },
    implementation: async (
      { target, cwd, env, interactive_shell, read_delay_ms },
      { signal, status },
    ) => {
      status(`Starting ${target ?? getSettings().defaultTarget} shell session`);
      return await startShellSession(getSettings(), {
        target,
        cwd,
        env,
        interactiveShell: interactive_shell,
        readDelayMs: read_delay_ms,
        signal,
      });
    },
  });

  const sessionWriteTool = tool({
    name: "shell_session_write",
    description: text`
      Send input to a persistent shell session, then return any output produced so far.
      Use this to answer prompts, continue an SSH session, activate a venv, or run commands
      that depend on previous session state.
    `,
    parameters: {
      session_id: z.string().min(1).describe("Session id returned by shell_session_start."),
      input: z.string().describe("Text to send to the session's stdin."),
      append_newline: z.boolean().optional().describe(
        "Append a newline after the input. Defaults to true.",
      ),
      read_delay_ms: z.number().int().min(0).max(30000).optional().describe(
        "Milliseconds to wait for output before returning.",
      ),
      confirmed_irreversible: z.boolean().optional().describe(
        "Set to true only after the user explicitly confirms a risky, destructive, privileged, or remote command/input.",
      ),
    },
    implementation: async (
      { session_id, input, append_newline, read_delay_ms, confirmed_irreversible },
      { signal, status },
    ) => {
      const riskyReasons = findRiskyCommandReasons(input);
      if (riskyReasons.length > 0 && confirmed_irreversible !== true) {
        return formatRiskyCommandRefusal(input, riskyReasons);
      }

      status(`Writing to shell session ${session_id}`);
      return await writeShellSession(session_id, input, {
        appendNewline: append_newline,
        readDelayMs: read_delay_ms,
        signal,
      });
    },
  });

  const sessionReadTool = tool({
    name: "shell_session_read",
    description: text`
      Read buffered output from a persistent shell session without sending input.
      Use this after waiting for a long-running command or to inspect whether a prompt appeared.
    `,
    parameters: {
      session_id: z.string().min(1).describe("Session id returned by shell_session_start."),
      read_delay_ms: z.number().int().min(0).max(30000).optional().describe(
        "Milliseconds to wait for more output before returning.",
      ),
    },
    implementation: async ({ session_id, read_delay_ms }, { signal, status }) => {
      status(`Reading shell session ${session_id}`);
      return await readShellSession(session_id, {
        readDelayMs: read_delay_ms,
        signal,
      });
    },
  });

  const sessionStopTool = tool({
    name: "shell_session_stop",
    description: text`
      Stop and remove a persistent shell session. Call this when the task is done so the
      plugin does not keep shells, SSH sessions, or background processes open.
    `,
    parameters: {
      session_id: z.string().min(1).describe("Session id returned by shell_session_start."),
      signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).optional().describe(
        "Signal used to stop the session. Defaults to SIGTERM.",
      ),
      read_delay_ms: z.number().int().min(0).max(10000).optional().describe(
        "Milliseconds to wait for final output before returning.",
      ),
    },
    implementation: async ({ session_id, signal: termSignal, read_delay_ms }, { signal, status }) => {
      status(`Stopping shell session ${session_id}`);
      return await stopShellSession(session_id, {
        signal: termSignal,
        readDelayMs: read_delay_ms,
        abortSignal: signal,
      });
    },
  });

  const sessionListTool = tool({
    name: "shell_session_list",
    description: text`
      List currently open persistent shell sessions.
    `,
    parameters: {},
    implementation: async () => {
      return listShellSessions();
    },
  });

  return [
    shellExecTool,
    shellInfoTool,
    sessionStartTool,
    sessionWriteTool,
    sessionReadTool,
    sessionStopTool,
    sessionListTool,
  ];
}
