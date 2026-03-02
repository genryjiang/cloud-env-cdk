#!/usr/bin/env node
// @ts-nocheck

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_SHELLS = new Set(["bash", "zsh", "fish"]);
const INTERNAL_COMPLETION_INSTALL_ENV = "DEVBOX_INTERNAL_COMPLETION_INSTALL";

function normalizeShellName(raw: string | undefined): string {
  if (!raw) {
    return "";
  }
  const shellName = path.basename(raw).trim().toLowerCase();
  return SUPPORTED_SHELLS.has(shellName) ? shellName : "";
}

function inferCompletionShells(): string[] {
  const shells = new Set<string>();
  const home = os.homedir();

  const envShell = normalizeShellName(process.env.SHELL);
  if (envShell) {
    shells.add(envShell);
  }

  const userInfoShell = normalizeShellName((os.userInfo() as { shell?: string }).shell);
  if (userInfoShell) {
    shells.add(userInfoShell);
  }

  if (fs.existsSync(path.join(home, ".zshrc"))) {
    shells.add("zsh");
  }
  if (fs.existsSync(path.join(home, ".bashrc"))) {
    shells.add("bash");
  }
  if (fs.existsSync(path.join(home, ".config", "fish", "config.fish"))) {
    shells.add("fish");
  }

  return [...shells];
}

function runAutoCompletionInstall(): void {
  const isGlobal = String(process.env.npm_config_global ?? "").toLowerCase() === "true";
  if (!isGlobal) {
    return;
  }

  const currentFile = fileURLToPath(import.meta.url);
  const cliPath = path.join(path.dirname(currentFile), "cli.js");
  if (!fs.existsSync(cliPath)) {
    return;
  }

  try {
    const internalEnv = {
      ...process.env,
      [INTERNAL_COMPLETION_INSTALL_ENV]: "1",
    };
    const shells = inferCompletionShells();
    if (shells.length === 0) {
      spawnSync(process.execPath, [cliPath, "__completion-install", "--quiet"], {
        stdio: "ignore",
        cwd: path.dirname(cliPath),
        env: internalEnv,
      });
      return;
    }

    for (const shell of shells) {
      spawnSync(process.execPath, [cliPath, "__completion-install", "--quiet", "--shell", shell], {
        stdio: "ignore",
        cwd: path.dirname(cliPath),
        env: internalEnv,
      });
    }
  } catch {
    // Keep install non-fatal if completion setup fails.
  }
}

runAutoCompletionInstall();
