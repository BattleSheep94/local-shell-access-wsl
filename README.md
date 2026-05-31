# `mbagley/local-shell-access`

LM Studio plugin that lets the model run commands in the user's local shell.
Now with WSL Support. WIP. For Bug report: https://github.com/BattleSheep94/local-shell-access-wsl
Companion to `mbagley/agent-browser`: where that plugin gives a model a browser
it can drive, this one gives it a terminal.

> **This is a power tool.** Any command the model emits runs as your user, on
> your machine, with your permissions — including destructive ones (`rm -rf`,
> network egress, package installs, git pushes, …). Only enable it for models
> you trust, and prefer running with a model and prompt that asks before doing
> anything irreversible.

## Prerequisites

- LM Studio with plugins enabled.
- A POSIX shell available on the system (`/bin/zsh`, `/bin/bash`, `/bin/sh`)
  on macOS / Linux, or `cmd.exe` / `powershell.exe` on Windows.
- Optional: WSL installed on Windows if you want commands to run inside a
  Linux distribution as well as on the host.

LM Studio's plugin runtime starts with a stripped `PATH` and does not inherit
the user's interactive shell environment. To make commands behave the same as
they would in your terminal, this plugin auto-detects your shell (from
`$SHELL`, falling back to your login shell in `/etc/passwd`, then to
`/bin/zsh` / `/bin/bash`) and invokes it with `-l -c` by default so your login
profile is sourced. That is what restores your real `PATH`, version-manager
hooks, etc. Aliases defined only in interactive rc files (`.zshrc`, `.bashrc`)
are typically *not* available — put PATH and env in `.zprofile` /
`.bash_profile` if you need them.

## Develop

```sh
npm install
npm run dev          # lms dev — auto-rebuilds and reloads the plugin in LM Studio
npm run test:verify  # build + integration test against the local shell
```

## Publish

```sh
npm run push  # lms push
```

## Tools

| Tool | Purpose |
| --- | --- |
| `shell_exec` | Run a command on the host or in WSL. Supports pipes, redirects, `&&`, globs, command substitution, optional `target` / `cwd` / `env` / `timeout_ms` overrides. Returns exit code, stdout, stderr. |
| `shell_info` | Report the resolved shell binary, args template, default cwd, user, hostname, platform, home directory, and WSL settings for the selected target. For WSL, these values are probed inside the Linux distribution. |
| `shell_session_start` | Start a persistent host or WSL shell for stateful work such as SSH, prompts, or Python virtual environments. |
| `shell_session_write` | Send input or a command to a persistent shell session and read output. |
| `shell_session_read` | Read output from a persistent shell session without sending input. |
| `shell_session_stop` | Stop and remove a persistent shell session. |
| `shell_session_list` | List currently open persistent shell sessions. |

Each `shell_exec` call spawns a fresh shell process — there is no persistent
session, so `cd` and exported vars do **not** carry over between calls. Chain
steps in one command (`cd /tmp && ls`) or pass `cwd` per-call.

To choose WSL for one call, pass `target: "wsl"` to `shell_exec` or
`shell_info`. Leave it out to use the configured default target. For WSL calls,
`cwd` accepts Linux paths such as `/home/me/project` and Windows paths such as
`P:\repo\project`; `wsl.exe --cd` handles the conversion.

### WSL default working directory examples

`wslDefaultCwd` is the directory where WSL commands start when a tool call does
not provide `cwd`. You can use any path accepted by `wsl.exe --cd`:

| Desired start directory | Recommended value |
| --- | --- |
| WSL user's home | Leave blank |
| Root user's home | `/root` or `\\wsl.localhost\Ubuntu-24.04\root` |
| Normal user's home | `/home/alice` or `\\wsl.localhost\Ubuntu-24.04\home\alice` |
| Windows project folder | `P:\Programmierung\Visual Studio 18\Projects\lsa\local-shell-access` |
| Same folder as WSL mount | `/mnt/p/Programmierung/Visual Studio 18/Projects/lsa/local-shell-access` |

In `shell_info`, `defaultCwd` is the Linux path actually used by the shell.
`wsl.windowsDefaultCwd` is the Windows/Explorer view of the same location, such
as `\\wsl.localhost\Ubuntu-24.04\root`.

If your WSL distribution defaults to `root`, set `wslUser` to an unprivileged
Linux user before giving a model tool access. When `wslUser` is blank, WSL uses
the distribution's configured default user. In `shell_info`, `defaultCwd` is the
actual Linux directory where commands start when no `cwd` override is provided.
The `wsl` block also includes Windows path equivalents such as
`\\wsl.localhost\Ubuntu-24.04\root` in `windowsHomeDir` and
`windowsDefaultCwd` for tools that need to orient from the Windows side.

Bash aliases are normally available only in interactive shells. If you need
aliases or shell functions from `~/.bashrc` / `~/.bash_aliases` (for example
`bsssh`), enable `wslInteractiveShell`. Without it, WSL commands run through
`bash -l -c`, which is suitable for scripts but does not expand interactive
aliases.

### SSH command placement

Shell operators outside `ssh` still run locally. This command connects over SSH,
then writes the file locally in WSL after SSH exits:

```sh
bsssh && echo "Das ist ein Test!" > LMSTUDIO.txt
```

To write on the remote server, pass the command to SSH:

```sh
bsssh 'echo "Das ist ein Test!" > ~/LMSTUDIO.txt'
bsssh 'cat ~/LMSTUDIO.txt'
```

For server updates, prefer an explicit remote command:

```sh
bsssh 'apt update && apt upgrade'
```

If the command asks questions or needs state, use a persistent shell session
instead of `shell_exec`.

### Persistent sessions

`shell_exec` is intentionally stateless: every call starts a fresh shell. Use
the session tools when you need state:

```text
shell_session_start target=wsl interactive_shell=true
shell_session_write session_id=... input="bsssh"
shell_session_read session_id=...
shell_session_write session_id=... input="apt update && apt upgrade"
shell_session_read session_id=...
shell_session_write session_id=... input="y"
shell_session_stop session_id=...
```

This also works for Python virtual environments:

```text
shell_session_start target=wsl cwd="/path/to/project"
shell_session_write session_id=... input="source .venv/bin/activate"
shell_session_write session_id=... input="python --version"
shell_session_stop session_id=...
```

The session tools keep stdin/stdout/stderr connected, but they are not a full
terminal emulator. Some programs that require a real TTY may still need flags
such as `ssh -tt` or a non-interactive command form.

## Configuration

| Field | Default | Notes |
| --- | --- | --- |
| `promptGuidance` | `true` | Inject shell usage and safety guidance into prompts. |
| `defaultTarget` | `host` | Where commands run when a tool call does not specify `target`. Use `host` or `wsl`. |
| `shell` | (auto-detect) | Absolute path to a shell binary. Blank = auto. |
| `loginShell` | `true` | Pass `-l` so the login profile is sourced. Disable for faster startup if your environment doesn't depend on profile-sourced PATH. |
| `defaultCwd` | (home) | Working directory when the model doesn't specify one. |
| `wslDistro` | (default distro) | Optional WSL distribution name, e.g. `Ubuntu-24.04`. |
| `wslUser` | (distro default user) | Optional Linux user for WSL commands. Set this to a non-root user to avoid giving the model root privileges. |
| `wslShell` | `/bin/bash` | Shell binary to run inside WSL. |
| `wslLoginShell` | `true` | Pass `-l` to the WSL shell before running commands. |
| `wslInteractiveShell` | `false` | Pass `-i` to the WSL shell so Bash reads `~/.bashrc` and expands aliases/functions. |
| `wslDefaultCwd` | (WSL home) | Working directory for WSL commands when no `cwd` is specified. Linux and Windows paths are accepted. |
| `timeoutMs` | `60000` | Default per-command timeout. SIGTERM, then SIGKILL after a 2s grace. |
| `maxOutputBytes` | `262144` | Per-stream cap on captured stdout/stderr. Output past this is truncated with a marker. |
