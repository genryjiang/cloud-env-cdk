// @ts-nocheck

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CommandError, MissingCommandError } from "./errors.js";
import { isFile } from "./fsUtils.js";

export function run(cmd: string[], options: Record<string, any> = {}) {
  const captureOutput = options.captureOutput ?? true;
  const check = options.check ?? true;
  const hasInput = options.input !== undefined;

  let stdio: "pipe" | "inherit" | ["pipe", "inherit", "inherit"];
  if (captureOutput) {
    stdio = "pipe";
  } else if (hasInput) {
    stdio = ["pipe", "inherit", "inherit"];
  } else {
    stdio = "inherit";
  }

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    stdio,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new MissingCommandError(cmd[0]);
    }
    throw err;
  }

  const completed = {
    cmd,
    returncode: result.status ?? 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };

  if (check && completed.returncode !== 0) {
    throw new CommandError(cmd, completed.returncode, completed.stdout, completed.stderr);
  }

  return completed;
}

export function which(command: string): string | null {
  const pathValue = process.env.PATH ?? "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (!isFile(candidate)) {
        continue;
      }
      try {
        if (process.platform === "win32") {
          return candidate;
        }
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function requireCommand(command: string): void {
  if (which(command) === null) {
    console.log(`Error: required command not found: ${command}`);
    process.exit(1);
  }
}
