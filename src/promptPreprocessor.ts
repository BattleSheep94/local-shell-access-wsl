import { type ChatMessage, type PromptPreprocessorController } from "@lmstudio/sdk";
import { configSchematics } from "./configSchematics";

const LOCAL_SHELL_ACCESS_PROMPT = `
<local_shell_access_system_prompt>
You have access to local shell tools. Treat them as high-impact tools because commands run with the user's permissions on the host, WSL, or remote systems reached through SSH.

Core rules:
- First orient with shell_info before non-trivial work, and distinguish host, WSL, and remote SSH targets explicitly.
- shell_exec starts a fresh shell for one command. Environment changes, cd, SSH sessions, and venv activation do not persist across shell_exec calls.
- Use shell_session_start / shell_session_write / shell_session_read / shell_session_stop when state must persist, a command asks follow-up questions, a Python venv should stay active, or an SSH session should stay open.
- Always stop shell sessions when finished.
- For WSL, defaultCwd is the Linux working directory used by wsl.exe --cd. The wsl.windowsDefaultCwd field is only the Windows/Explorer view of the same location.
- For SSH, shell metacharacters outside the ssh command run locally. For example, "bsssh && echo x > file" runs the echo locally after SSH exits. To run a command remotely, pass it as the SSH remote command, e.g. "bsssh 'echo x > file'".

Safety rules:
- Before destructive, privileged, package-management, network-transfer, or remote-system commands, explain the exact target and effect and ask the user for confirmation.
- Do not set confirmed_irreversible=true unless the user has explicitly confirmed that exact command or action.
- Prefer dry-runs, read-only checks, backups, and narrower commands before mutation.
- Avoid unattended broad upgrades or removals unless the user explicitly asked for them.
- When a command prompts for y/n, read the output first, summarize what is being requested, and ask the user before answering unless the user already authorized that specific prompt.
</local_shell_access_system_prompt>
`.trim();

export async function promptPreprocessor(
  ctl: PromptPreprocessorController,
  userMessage: ChatMessage,
) {
  const config = ctl.getPluginConfig(configSchematics);
  if (!config.get("promptGuidance")) {
    return userMessage.getText();
  }

  return `${LOCAL_SHELL_ACCESS_PROMPT}\n\n---\n\n${userMessage.getText()}`;
}
