// @ts-nocheck

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export class MissingCommandError extends Error {
  filename: string;

  constructor(filename: string) {
    super(`command not found: ${filename}`);
    this.name = "MissingCommandError";
    this.filename = filename;
  }
}

export class CommandError extends Error {
  cmd: string[];
  stdout: string;
  stderr: string;
  returncode: number;

  constructor(cmd: string[], returncode: number, stdout: string, stderr: string) {
    super(`Command failed: ${cmd.join(" ")}`);
    this.name = "CommandError";
    this.cmd = cmd;
    this.returncode = returncode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}
