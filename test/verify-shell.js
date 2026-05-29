// Integration test for the shell wrapper.
//
// Drives src/shell.ts (via the compiled dist/) under a stripped PATH that
// mimics LM Studio's plugin runtime. Validates shell discovery, cwd handling,
// truncation, timeout behavior, and WSL execution when available.
//
// Run: npm run test:verify

"use strict";

// Strip the inherited shell PATH so we exercise the wrapper's discovery logic
// the same way LM Studio's plugin runtime does.
process.env.PATH = process.platform === "win32" ? "" : "/usr/bin:/bin";

const path = require("path");
const os = require("os");
const { runShell, describeEnvironment, formatRunResult } = require(
  path.join(__dirname, "..", "dist", "shell"),
);

const IS_WINDOWS = process.platform === "win32";
const SETTINGS = {
  defaultTarget: "host",
  shell: "",
  loginShell: true,
  defaultCwd: "",
  wslDistro: "",
  wslUser: "",
  wslShell: "/bin/bash",
  wslLoginShell: true,
  wslInteractiveShell: false,
  wslDefaultCwd: "",
  timeoutMs: 10000,
  maxOutputBytes: 256,
};

function bar(label) {
  console.log("\n" + "=".repeat(8) + " " + label + " " + "=".repeat(8));
}

function assert(cond, msg) {
  if (!cond) {
    console.log("FAIL:", msg);
    return false;
  }
  return true;
}

function normalizePathForCompare(value) {
  return path.resolve(value.trim()).toLowerCase();
}

function hostCommandsFor(shell) {
  const lower = shell.toLowerCase();
  if (lower.endsWith("powershell.exe") || lower.endsWith("pwsh.exe") || lower.endsWith("pwsh")) {
    return {
      echo: "Write-Output 'hello world'",
      pwd: "(Get-Location).Path",
      fail: "exit 1",
      env: "Write-Output $env:LMS_TEST_VAR",
      stderr: "[Console]::Error.WriteLine('to-stderr'); exit 3",
      big: "[Console]::Out.Write(('x' * 2000))",
      pipeline: "Write-Output 'a','b','c' | Measure-Object | ForEach-Object Count",
      timeout: "Start-Sleep -Seconds 5; Write-Output 'should-not-print'",
      pipelineExpected: "3",
    };
  }
  if (lower.endsWith("cmd.exe") || lower.endsWith("\\cmd")) {
    return {
      echo: "echo hello world",
      pwd: "cd",
      fail: "exit /b 1",
      env: "echo %LMS_TEST_VAR%",
      stderr: "echo to-stderr 1>&2 & exit /b 3",
      big: "(for /L %i in (1,1,2000) do @<nul set /p=x) & exit /b 0",
      pipeline: "echo first && echo second",
      timeout: '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "Start-Sleep -Seconds 5" && echo should-not-print',
      pipelineExpected: "first\nsecond",
    };
  }
  return {
    echo: "echo hello world",
    pwd: "pwd",
    fail: "false",
    env: "echo $LMS_TEST_VAR",
    stderr: "echo to-stderr 1>&2; exit 3",
    big: "printf 'x%.0s' {1..2000}",
    pipeline: "printf 'a\\nb\\nc\\n' | wc -l | tr -d ' '",
    timeout: "sleep 5 && echo should-not-print",
    pipelineExpected: "3",
  };
}

async function runHostTests() {
  let failed = false;

  bar("environment");
  const info = await describeEnvironment(SETTINGS);
  console.log(info);
  if (!assert(info.target === "host", "host target reported")) failed = true;
  if (!assert(typeof info.shell === "string" && info.shell.length > 0, "shell resolved")) failed = true;
  if (!assert(info.user.length > 0, "user populated")) failed = true;
  const commands = hostCommandsFor(info.shell);

  bar("echo hello");
  const echo = await runShell(SETTINGS, commands.echo);
  console.log(formatRunResult(echo, SETTINGS.maxOutputBytes));
  if (!assert(echo.exitCode === 0, "echo exit 0")) failed = true;
  if (!assert(echo.stdout.trim() === "hello world", "echo stdout matches")) failed = true;

  bar("pwd defaults to home");
  const pwd = await runShell(SETTINGS, commands.pwd);
  console.log(formatRunResult(pwd, SETTINGS.maxOutputBytes));
  if (!assert(pwd.exitCode === 0, "pwd exit 0")) failed = true;
  if (IS_WINDOWS) {
    const actual = normalizePathForCompare(pwd.stdout);
    const expected = normalizePathForCompare(os.homedir());
    if (!assert(actual === expected, `pwd is home (${os.homedir()})`)) failed = true;
  } else if (!assert(pwd.stdout.trim() === os.homedir(), `pwd is home (${os.homedir()})`)) {
    failed = true;
  }

  bar("explicit cwd override");
  const tmpDir = os.tmpdir();
  const tmpPwd = await runShell(SETTINGS, commands.pwd, { cwd: tmpDir });
  console.log(formatRunResult(tmpPwd, SETTINGS.maxOutputBytes));
  if (IS_WINDOWS) {
    const actual = normalizePathForCompare(tmpPwd.stdout);
    const expected = normalizePathForCompare(tmpDir);
    if (!assert(actual === expected, "pwd reflects cwd override")) failed = true;
  } else {
    const tmpOk = tmpPwd.stdout.trim() === tmpDir || tmpPwd.stdout.trim() === "/private/tmp";
    if (!assert(tmpOk, "pwd reflects cwd override")) failed = true;
  }

  bar("nonzero exit");
  const fail = await runShell(SETTINGS, commands.fail);
  console.log(formatRunResult(fail, SETTINGS.maxOutputBytes));
  if (!assert(fail.exitCode === 1, "nonzero exit propagated")) failed = true;

  bar("env override");
  const envOut = await runShell(SETTINGS, commands.env, {
    env: { LMS_TEST_VAR: "verified" },
  });
  console.log(formatRunResult(envOut, SETTINGS.maxOutputBytes));
  if (!assert(envOut.stdout.trim() === "verified", "env var is set in child")) failed = true;

  bar("stderr capture");
  const stderr = await runShell(SETTINGS, commands.stderr);
  console.log(formatRunResult(stderr, SETTINGS.maxOutputBytes));
  if (!assert(stderr.exitCode === 3, "exit code propagated")) failed = true;
  if (!assert(stderr.stderr.includes("to-stderr"), "stderr captured")) failed = true;

  bar("output truncation");
  const big = await runShell(SETTINGS, commands.big);
  if (!assert(big.truncated.stdout, "stdout marked truncated")) failed = true;
  if (!assert(big.stdout.length <= SETTINGS.maxOutputBytes, "stdout capped at maxOutputBytes")) failed = true;
  console.log("captured length:", big.stdout.length, "truncated:", big.truncated.stdout);

  bar("pipes and command chaining");
  const piped = await runShell(SETTINGS, commands.pipeline);
  console.log(formatRunResult(piped, SETTINGS.maxOutputBytes));
  if (!assert(piped.exitCode === 0, "pipeline exit 0")) failed = true;
  if (commands.pipelineExpected.includes("\n")) {
    if (!assert(piped.stdout.includes("first") && piped.stdout.includes("second"), "chain output correct")) failed = true;
  } else if (!assert(piped.stdout.trim() === commands.pipelineExpected, "pipeline output correct")) {
    failed = true;
  }

  bar("timeout kills runaway");
  const timed = await runShell(
    { ...SETTINGS, timeoutMs: 500 },
    commands.timeout,
  );
  console.log(formatRunResult(timed, SETTINGS.maxOutputBytes));
  if (!assert(timed.timedOut === true, "timedOut flag set")) failed = true;
  if (!assert(!timed.stdout.includes("should-not-print"), "command did not finish")) failed = true;

  return failed;
}

async function wslAvailable() {
  if (!IS_WINDOWS) return false;
  try {
    const probe = await runShell(
      { ...SETTINGS, defaultTarget: "wsl", timeoutMs: 5000 },
      "printf wsl-ok",
    );
    return probe.exitCode === 0 && probe.stdout.trim() === "wsl-ok";
  } catch {
    return false;
  }
}

async function runWslTests() {
  let failed = false;
  const wslSettings = { ...SETTINGS, defaultTarget: "wsl" };

  bar("wsl environment");
  const info = await describeEnvironment(wslSettings);
  console.log(info);
  if (!assert(info.target === "wsl", "wsl target reported")) failed = true;
  if (!assert(info.wsl && info.wsl.executable.length > 0, "wsl executable reported")) failed = true;
  if (!assert(info.user !== "unknown", "wsl user is probed")) failed = true;
  if (!assert(info.homeDir.startsWith("/"), "wsl homeDir is Linux path")) failed = true;
  if (!assert(info.defaultCwd.startsWith("/"), "wsl defaultCwd is resolved Linux path")) failed = true;
  if (!assert(info.platform === "linux", "wsl platform is linux")) failed = true;
  if (!assert(info.wsl.activeDistro && info.wsl.activeDistro.length > 0, "wsl active distro is probed")) failed = true;
  if (!assert(info.wsl.windowsHomeDir && info.wsl.windowsHomeDir.includes("\\wsl"), "wsl Windows home path is probed")) failed = true;
  if (!assert(info.wsl.windowsDefaultCwd && info.wsl.windowsDefaultCwd.includes("\\wsl"), "wsl Windows cwd path is probed")) failed = true;

  bar("wsl echo");
  const echo = await runShell(SETTINGS, "printf wsl-ok", { target: "wsl" });
  console.log(formatRunResult(echo, SETTINGS.maxOutputBytes));
  if (!assert(echo.target === "wsl", "result target is wsl")) failed = true;
  if (!assert(echo.exitCode === 0, "wsl echo exit 0")) failed = true;
  if (!assert(echo.stdout.trim() === "wsl-ok", "wsl stdout matches")) failed = true;

  bar("wsl cwd override");
  const tmpPwd = await runShell(SETTINGS, "pwd", { target: "wsl", cwd: "/tmp" });
  console.log(formatRunResult(tmpPwd, SETTINGS.maxOutputBytes));
  if (!assert(tmpPwd.stdout.trim() === "/tmp", "wsl cwd reflects override")) failed = true;

  bar("wsl env override");
  const envOut = await runShell(SETTINGS, "printf '%s' \"$LMS_TEST_VAR\"", {
    target: "wsl",
    env: { LMS_TEST_VAR: "verified" },
  });
  console.log(formatRunResult(envOut, SETTINGS.maxOutputBytes));
  if (!assert(envOut.stdout.trim() === "verified", "wsl env var is set")) failed = true;

  bar("wsl interactive aliases");
  const interactiveInfo = await describeEnvironment({ ...SETTINGS, defaultTarget: "wsl", wslInteractiveShell: true });
  console.log(interactiveInfo);
  if (!assert(interactiveInfo.interactiveShell === true, "wsl interactive shell is reported")) failed = true;
  if (!assert(interactiveInfo.shellArgsTemplate.includes("-i"), "wsl interactive shell args include -i")) failed = true;

  const aliasShell = await runShell(
    { ...SETTINGS, wslInteractiveShell: true },
    "shopt expand_aliases",
    { target: "wsl" },
  );
  console.log(formatRunResult(aliasShell, SETTINGS.maxOutputBytes));
  if (!assert(aliasShell.exitCode === 0, "wsl interactive alias probe exit 0")) failed = true;
  if (!assert(aliasShell.stdout.includes("on"), "wsl interactive shell expands aliases")) failed = true;

  bar("wsl user override");
  const rootOut = await runShell({ ...SETTINGS, wslUser: "root" }, "whoami", { target: "wsl" });
  console.log(formatRunResult(rootOut, SETTINGS.maxOutputBytes));
  if (!assert(rootOut.exitCode === 0, "wsl root override exit 0")) failed = true;
  if (!assert(rootOut.stdout.trim() === "root", "wsl user override applied")) failed = true;

  return failed;
}

async function main() {
  let failed = false;
  const t0 = Date.now();

  if (await runHostTests()) failed = true;

  if (await wslAvailable()) {
    if (await runWslTests()) failed = true;
  } else {
    bar("wsl skipped");
    console.log("WSL is not available on this machine or no default distro can run commands.");
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  bar(failed ? `FAIL  (${elapsed}s)` : `PASS  (${elapsed}s)`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("THREW:", err);
  process.exit(1);
});
