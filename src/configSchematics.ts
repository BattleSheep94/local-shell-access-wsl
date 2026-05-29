import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "defaultTarget",
    "string",
    {
      displayName: "Default target",
      hint: "Where commands run by default: host or wsl. Individual tool calls can override this with the target parameter.",
    },
    "host",
  )
  .field(
    "shell",
    "string",
    {
      displayName: "Shell binary",
      hint: "Absolute path to the shell to use. Leave blank to auto-detect from $SHELL or the user's login shell (e.g. /bin/zsh on macOS, /bin/bash on Linux).",
    },
    "",
  )
  .field(
    "loginShell",
    "boolean",
    {
      displayName: "Use login shell",
      hint: "Pass -l so the shell sources the user's login profile (~/.zprofile, ~/.bash_profile). Required to inherit the user's PATH and environment, since LM Studio's plugin runtime starts with a stripped PATH.",
    },
    true,
  )
  .field(
    "defaultCwd",
    "string",
    {
      displayName: "Default working directory",
      hint: "Directory commands run in when the model does not specify one. Leave blank to use the user's home directory.",
    },
    "",
  )
  .field(
    "wslDistro",
    "string",
    {
      displayName: "WSL distribution",
      hint: "Optional WSL distribution name, e.g. Ubuntu-24.04. Leave blank to use the default WSL distribution.",
    },
    "",
  )
  .field(
    "wslUser",
    "string",
    {
      displayName: "WSL user",
      hint: "Optional Linux user to run WSL commands as. Leave blank to use the distribution's default user. Set this to a non-root user if you do not want the model to run with root privileges.",
    },
    "",
  )
  .field(
    "wslShell",
    "string",
    {
      displayName: "WSL shell binary",
      hint: "Shell to execute inside WSL. /bin/bash is the default; use /bin/sh if your distribution does not include bash.",
    },
    "/bin/bash",
  )
  .field(
    "wslLoginShell",
    "boolean",
    {
      displayName: "Use WSL login shell",
      hint: "Pass -l to the WSL shell so it sources login profile files before running the command.",
    },
    true,
  )
  .field(
    "wslInteractiveShell",
    "boolean",
    {
      displayName: "Use WSL interactive shell",
      hint: "Pass -i to the WSL shell so Bash reads ~/.bashrc and expands aliases from files such as ~/.bash_aliases. Enable this if you want aliases/functions like bsssh to work.",
    },
    false,
  )
  .field(
    "wslDefaultCwd",
    "string",
    {
      displayName: "WSL default working directory",
      hint: "Directory for WSL commands when no cwd is provided. Linux paths and Windows paths are accepted. Leave blank to use the WSL user's home directory.",
    },
    "",
  )
  .field(
    "timeoutMs",
    "numeric",
    {
      displayName: "Default timeout (ms)",
      hint: "Default per-command timeout. Commands exceeding this are sent SIGTERM, then SIGKILL after a 2s grace period.",
      min: 1000,
      max: 600000,
      int: true,
    },
    60000,
  )
  .field(
    "maxOutputBytes",
    "numeric",
    {
      displayName: "Max output bytes",
      hint: "Per-stream cap on captured stdout/stderr. Output past this is dropped with a [truncated] marker so a chatty command does not blow up the model's context.",
      min: 1024,
      max: 10485760,
      int: true,
    },
    262144,
  )
  .build();
