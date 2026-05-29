import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir, hostname, platform, userInfo } from "os";

export type ShellTarget = "host" | "wsl";

export interface ShellSettings {
  shell: string;
  loginShell: boolean;
  defaultCwd: string;
  defaultTarget: string;
  wslDistro: string;
  wslUser: string;
  wslShell: string;
  wslLoginShell: boolean;
  wslInteractiveShell: boolean;
  wslDefaultCwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  target?: ShellTarget;
}

export interface RunResult {
  target: ShellTarget;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  termSignal: NodeJS.Signals | null;
  truncated: { stdout: boolean; stderr: boolean };
  timedOut: boolean;
  shell: string;
  shellArgs: string[];
  cwd: string;
}

let cachedAutoShell: string | null = null;

// LM Studio's plugin runtime does not inherit the user's interactive shell
// environment (PATH, SHELL, etc. are stripped down). To run "the user's shell"
// we have to discover it, then invoke it as a login shell so the user's
// profile is sourced — that is what gives us back their real PATH, version
// manager hooks, and so on.

function autoDetectShell(): string {
  if (cachedAutoShell !== null) return cachedAutoShell;

  const candidates: (string | undefined)[] = [];

  // 1. $SHELL if the runtime did pass it through.
  candidates.push(process.env.SHELL);

  // 2. The shell recorded for this user in /etc/passwd. os.userInfo() reads
  //    via getpwuid_r, so this works even when env is stripped.
  try {
    const info = userInfo();
    if (typeof (info as { shell?: unknown }).shell === "string") {
      candidates.push((info as { shell?: string }).shell);
    }
  } catch {
    // userInfo() can throw on some platforms — fall through to defaults.
  }

  // 3. Platform-appropriate fallbacks.
  if (process.platform === "darwin") {
    candidates.push("/bin/zsh", "/bin/bash", "/bin/sh");
  } else if (process.platform === "win32") {
    candidates.push(process.env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  } else {
    candidates.push("/bin/bash", "/bin/sh");
  }

  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0 && existsSync(c)) {
      cachedAutoShell = c;
      return c;
    }
  }

  cachedAutoShell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  return cachedAutoShell;
}

export function resolveShell(configured: string): string {
  const trimmed = configured.trim();
  if (trimmed.length > 0 && existsSync(trimmed)) return trimmed;
  return autoDetectShell();
}

export function resolveShellTarget(configured: string | undefined): ShellTarget {
  return configured?.trim().toLowerCase() === "wsl" ? "wsl" : "host";
}

export function resolveCwd(settings: ShellSettings, override?: string): string {
  const candidate =
    (override ?? "").trim() || settings.defaultCwd.trim() || homedir();
  return existsSync(candidate) ? candidate : homedir();
}

export function resolveWslCwd(settings: ShellSettings, override?: string): string {
  return (override ?? "").trim() || settings.wslDefaultCwd.trim() || "~";
}

function resolveWslExecutable(): string {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const systemWsl = `${systemRoot}\\System32\\wsl.exe`;
    if (existsSync(systemWsl)) return systemWsl;
  }
  return "wsl.exe";
}

function buildWslArgs(
  settings: ShellSettings,
  command: string,
  cwd: string,
  env?: Record<string, string>,
): { executable: string; args: string[]; shell: string; shellArgs: string[] } {
  const executable = resolveWslExecutable();
  const wslShell = settings.wslShell.trim() || "/bin/bash";
  const shellArgs = buildShellArgs(
    wslShell,
    settings.wslLoginShell,
    command,
    settings.wslInteractiveShell,
  );
  const args: string[] = [];
  const distro = settings.wslDistro.trim();

  if (distro.length > 0) {
    args.push("--distribution", distro);
  }

  const user = settings.wslUser.trim();
  if (user.length > 0) {
    args.push("--user", user);
  }

  args.push("--cd", cwd, "--exec");

  const envEntries = Object.entries(env ?? {});
  if (envEntries.length > 0) {
    args.push("/usr/bin/env");
    for (const [key, value] of envEntries) {
      args.push(`${key}=${value}`);
    }
  }

  args.push(wslShell, ...shellArgs);
  return { executable, args, shell: wslShell, shellArgs };
}

function buildShellArgs(
  shellPath: string,
  loginShell: boolean,
  command: string,
  interactiveShell = false,
): string[] {
  const lower = shellPath.toLowerCase();
  // Windows cmd.exe uses /d /s /c "command" — neither -l nor POSIX -c apply.
  if (lower.endsWith("cmd.exe") || lower.endsWith("\\cmd")) {
    return ["/d", "/s", "/c", command];
  }
  // PowerShell variants.
  if (lower.endsWith("powershell.exe") || lower.endsWith("pwsh.exe") || lower.endsWith("pwsh")) {
    return ["-NoProfile", "-Command", command];
  }
  // POSIX shells (sh, bash, zsh, dash, ksh, fish-ish).
  const args: string[] = [];
  if (loginShell) args.push("-l");
  if (interactiveShell) args.push("-i");
  args.push("-c", command);
  return args;
}

export async function runShell(
  settings: ShellSettings,
  command: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const target = opts.target ?? resolveShellTarget(settings.defaultTarget);
  const isWsl = target === "wsl";
  const hostCwd = isWsl ? homedir() : resolveCwd(settings, opts.cwd);
  const cwd = isWsl ? resolveWslCwd(settings, opts.cwd) : hostCwd;
  const shellPath = isWsl ? resolveWslExecutable() : resolveShell(settings.shell);
  const wslCommand = isWsl
    ? buildWslArgs(settings, command, cwd, opts.env)
    : null;
  const shellArgs = isWsl
    ? wslCommand!.args
    : buildShellArgs(shellPath, settings.loginShell, command);
  const timeout = opts.timeoutMs ?? settings.timeoutMs;
  const maxBytes = settings.maxOutputBytes;

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(shellPath, shellArgs, {
      cwd: hostCwd,
      env: isWsl ? process.env : { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const appendCapped = (
      chunk: Buffer,
      current: string,
      currentBytes: number,
    ): { text: string; bytes: number; truncated: boolean } => {
      if (currentBytes >= maxBytes) {
        return { text: current, bytes: currentBytes + chunk.length, truncated: true };
      }
      const remaining = maxBytes - currentBytes;
      if (chunk.length <= remaining) {
        return {
          text: current + chunk.toString("utf-8"),
          bytes: currentBytes + chunk.length,
          truncated: false,
        };
      }
      return {
        text: current + chunk.subarray(0, remaining).toString("utf-8"),
        bytes: currentBytes + chunk.length,
        truncated: true,
      };
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const r = appendCapped(chunk, stdout, stdoutBytes);
      stdout = r.text;
      stdoutBytes = r.bytes;
      if (r.truncated) stdoutTruncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const r = appendCapped(chunk, stderr, stderrBytes);
      stderr = r.text;
      stderrBytes = r.bytes;
      if (r.truncated) stderrTruncated = true;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Hard-kill if SIGTERM is ignored (common for shells that have spawned
      // their own child still busy in a syscall).
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 2000);
      escalate.unref();
    }, timeout);

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        child.kill("SIGTERM");
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      clearTimeout(killTimer);
      if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code, signalName) => {
      clearTimeout(killTimer);
      if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        target,
        stdout,
        stderr,
        exitCode: code,
        termSignal: signalName,
        truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
        timedOut,
        shell: isWsl ? wslCommand!.shell : shellPath,
        shellArgs: isWsl ? wslCommand!.shellArgs : shellArgs,
        cwd,
      });
    });
  });
}

export function formatRunResult(result: RunResult, maxBytes: number): string {
  const parts: string[] = [];

  if (result.timedOut) {
    parts.push("[command timed out and was terminated]");
  }

  const exitDesc =
    result.exitCode !== null
      ? `exit_code: ${result.exitCode}`
      : `exit_code: null (terminated by signal ${result.termSignal ?? "unknown"})`;
  parts.push(exitDesc);

  if (result.stdout.length > 0) {
    const tail = result.truncated.stdout
      ? `\n[stdout truncated at ${maxBytes} bytes]`
      : "";
    parts.push(`stdout:\n${result.stdout}${tail}`);
  } else {
    parts.push("stdout: (empty)");
  }

  if (result.stderr.length > 0) {
    const tail = result.truncated.stderr
      ? `\n[stderr truncated at ${maxBytes} bytes]`
      : "";
    parts.push(`stderr:\n${result.stderr}${tail}`);
  }

  return parts.join("\n\n");
}

export interface ShellInfo {
  target: ShellTarget;
  shell: string;
  shellArgsTemplate: string[];
  loginShell: boolean;
  interactiveShell: boolean;
  defaultCwd: string;
  user: string;
  hostname: string;
  platform: string;
  homeDir: string;
  wsl?: {
    executable: string;
    distro: string | null;
    activeDistro?: string;
    configuredUser: string | null;
    windowsHomeDir?: string;
    windowsDefaultCwd?: string;
    uname?: string;
    infoError?: string;
  };
}

interface WslEnvironmentDetails {
  user: string;
  hostname: string;
  platform: string;
  homeDir: string;
  defaultCwd: string;
  activeDistro?: string;
  windowsHomeDir?: string;
  windowsDefaultCwd?: string;
  uname?: string;
  infoError?: string;
}

async function describeWslEnvironment(settings: ShellSettings): Promise<WslEnvironmentDetails> {
  const fallback: WslEnvironmentDetails = {
    user: settings.wslUser.trim() || "unknown",
    hostname: "unknown",
    platform: "linux",
    homeDir: "unknown",
    defaultCwd: resolveWslCwd(settings),
  };

  try {
    const result = await runShell(
      settings,
      "printf '%s\\n' \"$(id -un 2>/dev/null || whoami)\" \"$(hostname)\" \"$(uname -s | tr '[:upper:]' '[:lower:]')\" \"$HOME\" \"$(pwd)\" \"$(uname -a)\" \"${WSL_DISTRO_NAME:-}\" \"$(wslpath -w \"$HOME\" 2>/dev/null || true)\" \"$(wslpath -w \"$(pwd)\" 2>/dev/null || true)\"",
      {
        target: "wsl",
        timeoutMs: Math.min(settings.timeoutMs, 5000),
      },
    );

    if (result.exitCode !== 0) {
      return {
        ...fallback,
        infoError: (result.stderr || result.stdout || "WSL environment probe failed").trim(),
      };
    }

    const lines = result.stdout.split(/\r?\n/);
    return {
      user: lines[0]?.trim() || fallback.user,
      hostname: lines[1]?.trim() || fallback.hostname,
      platform: lines[2]?.trim() || fallback.platform,
      homeDir: lines[3]?.trim() || fallback.homeDir,
      defaultCwd: lines[4]?.trim() || fallback.defaultCwd,
      uname: lines[5]?.trim() || undefined,
      activeDistro: lines[6]?.trim() || undefined,
      windowsHomeDir: lines[7]?.trim() || undefined,
      windowsDefaultCwd: lines[8]?.trim() || undefined,
    };
  } catch (err) {
    return {
      ...fallback,
      infoError: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function describeEnvironment(
  settings: ShellSettings,
  targetOverride?: ShellTarget,
): Promise<ShellInfo> {
  const target = targetOverride ?? resolveShellTarget(settings.defaultTarget);
  const isWsl = target === "wsl";
  const shellPath = isWsl
    ? settings.wslShell.trim() || "/bin/bash"
    : resolveShell(settings.shell);
  const loginShell = isWsl ? settings.wslLoginShell : settings.loginShell;
  const interactiveShell = isWsl ? settings.wslInteractiveShell : false;
  const argsTemplate = buildShellArgs(shellPath, loginShell, "<COMMAND>", interactiveShell);
  const wslDetails = isWsl ? await describeWslEnvironment(settings) : null;
  const cwd = wslDetails?.defaultCwd ?? resolveCwd(settings);
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    // ignore
  }
  return {
    target,
    shell: shellPath,
    shellArgsTemplate: argsTemplate,
    loginShell,
    interactiveShell,
    defaultCwd: cwd,
    user: wslDetails?.user ?? user,
    hostname: wslDetails?.hostname ?? hostname(),
    platform: wslDetails?.platform ?? platform(),
    homeDir: wslDetails?.homeDir ?? homedir(),
    wsl: isWsl
      ? {
          executable: resolveWslExecutable(),
          distro: settings.wslDistro.trim() || null,
          activeDistro: wslDetails?.activeDistro,
          configuredUser: settings.wslUser.trim() || null,
          windowsHomeDir: wslDetails?.windowsHomeDir,
          windowsDefaultCwd: wslDetails?.windowsDefaultCwd,
          uname: wslDetails?.uname,
          infoError: wslDetails?.infoError,
        }
      : undefined,
  };
}
