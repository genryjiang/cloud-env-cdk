#!/usr/bin/env node
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAwsHelpers } from "./core/awsHelpers.js";
import { createJsonCache } from "./core/cache.js";
import { CommandError, MissingCommandError, RuntimeError } from "./core/errors.js";
import { expandUser, isDir, isFile, readText, splitLines } from "./core/fsUtils.js";
import { requireCommand, run } from "./core/processUtils.js";
import { createCompletionSupport } from "./cli/completionSupport.js";
import { createCloudCommands } from "./commands/cloud.js";
import { createCloudParsers } from "./commands/cloudParsers.js";
import { createNonCloudCommands } from "./commands/nonCloud.js";
import { createNonCloudParsers } from "./commands/nonCloudParsers.js";

const CLI_NAME = "devbox";
const DEFAULT_REGION = "ap-southeast-2";
const CONTAINER_NAME_PREFIX = CLI_NAME;
const CACHE_NAMESPACE = "devbox";
const API_URL_CACHE_TTL_SECONDS = 6 * 60 * 60;
const USER_ID_CACHE_TTL_SECONDS = 12 * 60 * 60;
const CLOUD_INSTANCE_CACHE_TTL_SECONDS = 6 * 60 * 60;
const IMDS_TIMEOUT_MS = 200;
const SSH_KEY_PROPAGATION_WAIT_SECONDS = 2;
const WSL_KEY_PROPAGATION_INITIAL_WAIT_SECONDS = 0.35;
const SSH_KEY_INSTALL_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const WSL_SSH_CONNECT_MAX_ATTEMPTS = 3;
const WSL_SSH_CONNECT_RETRY_DELAY_SECONDS = 0.5;
const WSL_SSH_FAST_RETRY_MAX_ELAPSED_MS = 3000;
const DEFAULT_STACK_NAME = "CloudDevEnvStack";
const DEVTOOLS_SUBMODULE_URL = "https://github.com/YOUR_ORG/dev-tools";
const DEVTOOLS_SUBMODULE_PATH = "dev-tools";
const DEVTOOLS_MARKER_FILE = ".dev-env";
const ECR_REPO_PREFERENCE = ["devcontainer", "dev", "embedded", "qnx"];
const DEFAULT_QNX_BASE = "/home/developer/qnx800";
const DEFAULT_RTI_BASE = "/home/developer/rti_connext_dds-7.3.1";
const DEFAULT_DEVCONTAINER_IMAGE =
  "000000000000.dkr.ecr.ap-southeast-2.amazonaws.com/dev-container:latest";
const BASE_DEVCONTAINER_EXTENSIONS = [
  "ms-vscode.cpptools",
  "ms-vscode.cmake-tools",
  "twxs.cmake",
  "ms-python.python",
  "ms-python.vscode-pylance",
];
const OPTIONAL_HOST_EXTENSION_IDS = [
  "amazonwebservices.amazon-q-vscode",
  "openai.chatgpt",
  "openai.codex",
  "rti.rti-connext-copilot",
  "rti.rti-chat-extension",
];
const DEFAULT_WORKSPACE_MOUNT = "/home/ec2-user/workspace";
const DEFAULT_SSH_MOUNT = "/home/ec2-user/.ssh";
const LOCAL_SSH_MOUNT = "${localEnv:HOME}/.ssh";
const INTERNAL_COMPLETION_INSTALL_ENV = "DEVBOX_INTERNAL_COMPLETION_INSTALL";
const DEVTOOLS_CONTAINER_RELATIVE_PATHS = [
  `${DEVTOOLS_SUBMODULE_PATH}/host`,
  `${DEVTOOLS_SUBMODULE_PATH}/target`,
  "host",
  "target",
];
const ALLOW_CLOUD_CONTROL_ENV = "DEVBOX_ALLOW_CLOUD_CONTROL_ON_CLOUD";
const ASSUME_CLOUD_INSTANCE_ENV = "DEVBOX_ASSUME_CLOUD_INSTANCE";

const SECURITY_GROUP_ID_RE = /sg-[0-9a-f]+/gi;
const SUBNET_ID_RE = /subnet-[0-9a-f]+/gi;
const DEVBOX_SECURITY_GROUP_OUTPUT_KEYS = [
  "DevboxSecurityGroupIds",
  "DevboxSecurityGroupId",
  "DevboxSecurityGroup",
  "DevboxSgIds",
  "DevboxSgId",
];
const GENERIC_SECURITY_GROUP_OUTPUT_KEYS = ["SecurityGroupIds", "SecurityGroupId", "SecurityGroup"];
const DEVBOX_SUBNET_OUTPUT_KEYS = [
  "DevboxSubnetIds",
  "DevboxSubnetId",
  "DevboxSubnet",
  "DevboxPrivateSubnetIds",
  "DevboxPrivateSubnetId",
];
const GENERIC_SUBNET_OUTPUT_KEYS = ["PrivateSubnetIds", "PrivateSubnetId", "SubnetIds", "SubnetId"];

interface CompletedProcess {
  cmd: string[];
  returncode: number;
  stdout: string;
  stderr: string;
}

type AnyDict = Record<string, any>;

type CommandFunc = (args: AnyDict) => Promise<void>;

const { cacheGet, cacheSet } = createJsonCache(CACHE_NAMESPACE);

async function imdsGet(url: string, token: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMDS_TIMEOUT_MS);
  try {
    const headers = token ? ({ "X-aws-ec2-metadata-token": token } as Record<string, string>) : {};
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`IMDS request failed: ${response.status}`);
    }
    return (await response.text()).trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function detectEc2Instance(): Promise<boolean> {
  const indicators = [
    readText("/sys/hypervisor/uuid").toLowerCase(),
    readText("/sys/devices/virtual/dmi/id/product_uuid").toLowerCase(),
    readText("/sys/devices/virtual/dmi/id/sys_vendor").toLowerCase(),
    readText("/sys/devices/virtual/dmi/id/board_vendor").toLowerCase(),
    readText("/sys/devices/virtual/dmi/id/product_name").toLowerCase(),
    readText("/sys/devices/virtual/dmi/id/bios_vendor").toLowerCase(),
    readText("/sys/devices/virtual/dmi/id/chassis_asset_tag").toLowerCase(),
  ];

  if (indicators.some((value) => value.startsWith("ec2"))) {
    return true;
  }
  if (indicators.some((value) => value.includes("amazon ec2"))) {
    return true;
  }

  const boardAssetTag = readText("/sys/devices/virtual/dmi/id/board_asset_tag").toLowerCase();
  if (boardAssetTag.startsWith("i-")) {
    return true;
  }

  let token = "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMDS_TIMEOUT_MS);
    try {
      const response = await fetch("http://169.254.169.254/latest/api/token", {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
        signal: controller.signal,
      });
      if (response.ok) {
        token = (await response.text()).trim();
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    token = "";
  }

  try {
    const instanceId = await imdsGet("http://169.254.169.254/latest/meta-data/instance-id", token);
    if (instanceId.startsWith("i-")) {
      return true;
    }
  } catch {
    // Continue to identity document fallback.
  }

  try {
    const identityDocRaw = await imdsGet(
      "http://169.254.169.254/latest/dynamic/instance-identity/document",
      token,
    );
    const identityDoc = JSON.parse(identityDocRaw) as AnyDict;
    const instanceId = String(identityDoc.instanceId ?? "").trim();
    if (instanceId.startsWith("i-")) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

let cloudInstanceCache: boolean | undefined;

async function isCloudInstance(): Promise<boolean> {
  const forced = (process.env[ASSUME_CLOUD_INSTANCE_ENV] ?? "").trim();
  if (forced === "1") {
    return true;
  }
  if (forced === "0") {
    return false;
  }
  if (cloudInstanceCache !== undefined) {
    return cloudInstanceCache;
  }

  const cached = cacheGet("cloud_instance", CLOUD_INSTANCE_CACHE_TTL_SECONDS);
  if (cached === "1") {
    cloudInstanceCache = true;
    return true;
  }
  if (cached === "0") {
    cloudInstanceCache = false;
    return false;
  }

  cloudInstanceCache = await detectEc2Instance();
  cacheSet("cloud_instance", cloudInstanceCache ? "1" : "0");
  return cloudInstanceCache;
}

async function enforceLocalCloudControl(action: string): Promise<void> {
  if ((process.env[ALLOW_CLOUD_CONTROL_ENV] ?? "").trim() === "1") {
    return;
  }
  if (await isCloudInstance()) {
    throw new RuntimeError(
      `${CLI_NAME} cloud ${action} is disabled on cloud instances. ` +
        `Run this command from your local machine. ` +
        `Override with ${ALLOW_CLOUD_CONTROL_ENV}=1 if needed.`,
    );
  }
}

function formatLocalIsoSeconds(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

function formatTimestampForFilename(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
}

function formatAmzDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function formatAmzDateStamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function promptInputSync(prompt: string): string {
  process.stdout.write(prompt);
  const oneByte = Buffer.alloc(1);
  let result = "";

  while (true) {
    const bytesRead = fs.readSync(0, oneByte, 0, 1, null);
    if (bytesRead === 0) {
      break;
    }
    const ch = oneByte.toString("utf8");
    if (ch === "\n") {
      break;
    }
    if (ch !== "\r") {
      result += ch;
    }
  }

  return result;
}

function getGitRoot(cwd?: string): string {
  let result: CompletedProcess;
  try {
    result = run(["git", "rev-parse", "--show-toplevel"], {
      captureOutput: true,
      check: true,
      cwd,
    });
  } catch (error) {
    if (error instanceof CommandError) {
      throw new RuntimeError("Not inside a git repository");
    }
    throw error;
  }

  const root = result.stdout.trim();
  if (!root) {
    throw new RuntimeError("Unable to resolve git root");
  }
  return root;
}

function ensureMarkerFile(repoRoot: string): boolean {
  const markerPath = path.join(repoRoot, DEVTOOLS_MARKER_FILE);
  if (fs.existsSync(markerPath)) {
    return false;
  }
  fs.closeSync(fs.openSync(markerPath, "w"));
  return true;
}

function devtoolsSubmoduleConfigured(repoRoot: string): boolean {
  const gitmodulesPath = path.join(repoRoot, ".gitmodules");
  if (!isFile(gitmodulesPath)) {
    return false;
  }
  const content = fs.readFileSync(gitmodulesPath, "utf8");
  if (content.includes(DEVTOOLS_SUBMODULE_URL)) {
    return true;
  }
  return content.includes(`path = ${DEVTOOLS_SUBMODULE_PATH}`);
}

function ensureDevtoolsSubmodule(repoRoot: string): "added" | "initialized" | "present" {
  if (!devtoolsSubmoduleConfigured(repoRoot)) {
    const submodulePath = path.join(repoRoot, DEVTOOLS_SUBMODULE_PATH);
    if (fs.existsSync(submodulePath)) {
      throw new RuntimeError(
        `Dev tools path exists but is not configured as a submodule: ${submodulePath}`,
      );
    }
    run(["git", "submodule", "add", DEVTOOLS_SUBMODULE_URL, DEVTOOLS_SUBMODULE_PATH], {
      captureOutput: false,
      check: true,
      cwd: repoRoot,
    });
    return "added";
  }

  const submodulePath = path.join(repoRoot, DEVTOOLS_SUBMODULE_PATH);
  if (!fs.existsSync(submodulePath)) {
    run(["git", "submodule", "update", "--init", "--recursive", DEVTOOLS_SUBMODULE_PATH], {
      captureOutput: false,
      check: true,
      cwd: repoRoot,
    });
    return "initialized";
  }

  return "present";
}

function updateSubmodulesIfPresent(repoRoot: string): boolean {
  if (!isFile(path.join(repoRoot, ".gitmodules"))) {
    return false;
  }
  run(["git", "submodule", "update", "--init", "--recursive"], {
    captureOutput: false,
    check: true,
    cwd: repoRoot,
  });
  return true;
}

function resolveDevtoolsRoot(repoRoot: string): string {
  const submoduleRoot = path.join(repoRoot, DEVTOOLS_SUBMODULE_PATH);
  if (isDir(path.join(submoduleRoot, "host")) && isDir(path.join(submoduleRoot, "target"))) {
    return submoduleRoot;
  }
  if (isDir(path.join(repoRoot, "host")) && isDir(path.join(repoRoot, "target"))) {
    return repoRoot;
  }
  return submoduleRoot;
}

function resolveShellName(shellOverride?: string): string {
  if (shellOverride) {
    return shellOverride;
  }
  const shell = process.env.SHELL ?? "";
  return path.basename(shell);
}

function getShellRcPath(shellName: string): string {
  if (shellName === "zsh") {
    return path.join(os.homedir(), ".zshrc");
  }
  if (shellName === "bash") {
    return path.join(os.homedir(), ".bashrc");
  }
  if (shellName === "fish") {
    return path.join(os.homedir(), ".config", "fish", "config.fish");
  }
  throw new RuntimeError(`Unsupported shell: ${shellName}`);
}

function findShellBlock(
  lines: string[],
  startMarker: string,
  endMarker: string,
): [number, number] | null {
  let startIdx: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === startMarker) {
      startIdx = i;
      continue;
    }
    if (startIdx !== null && line.trim() === endMarker) {
      return [startIdx, i];
    }
  }
  if (startIdx !== null) {
    return [startIdx, lines.length];
  }
  return null;
}

function upsertShellBlock(
  rcPath: string,
  blockLines: string[],
  legacyMarkers?: [string, string][],
): boolean {
  const content = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
  const lines = splitLines(content);

  if (blockLines.length < 2) {
    throw new RuntimeError("Invalid shell block definition");
  }

  const startMarker = blockLines[0];
  const endMarker = blockLines[blockLines.length - 1];
  let block = findShellBlock(lines, startMarker, endMarker);

  if (block === null && legacyMarkers) {
    for (const [legacyStart, legacyEnd] of legacyMarkers) {
      block = findShellBlock(lines, legacyStart, legacyEnd);
      if (block !== null) {
        break;
      }
    }
  }

  let newLines: string[];
  if (block !== null) {
    const [startIdx, endIdx] = block;
    const existing = lines.slice(startIdx, endIdx + 1);
    if (
      existing.length === blockLines.length &&
      existing.every((line, index) => line === blockLines[index])
    ) {
      return false;
    }
    newLines = [...lines.slice(0, startIdx), ...blockLines, ...lines.slice(endIdx + 1)];
  } else {
    newLines = [...lines];
    if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") {
      newLines.push("");
    }
    newLines.push(...blockLines);
  }

  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  fs.writeFileSync(rcPath, `${newLines.join("\n")}\n`);
  return true;
}

function buildDevtoolsPathBlock(shellName: string, repoRoot: string, devtoolsRoot: string): string[] {
  const hostDir = path.resolve(devtoolsRoot, "host");
  const targetDir = path.resolve(devtoolsRoot, "target");

  if (!isDir(hostDir) || !isDir(targetDir)) {
    throw new RuntimeError(`Dev tools directories not found under: ${devtoolsRoot}`);
  }

  const startMarker = `# ${CLI_NAME} devtools start: ${repoRoot}`;
  const endMarker = `# ${CLI_NAME} devtools end: ${repoRoot}`;

  if (shellName === "bash" || shellName === "zsh") {
    return [startMarker, `export PATH="$PATH:${hostDir}:${targetDir}"`, endMarker];
  }
  if (shellName === "fish") {
    return [startMarker, `set -gx PATH $PATH ${hostDir} ${targetDir}`, endMarker];
  }
  throw new RuntimeError(`Unsupported shell: ${shellName}`);
}

const {
  awsCmd,
  awsJson,
  resolveRegion,
  resolveWorkspaceMount,
  resolveSshMount,
  isWsl,
  detectWindowsUserprofile,
  toWslPath,
  getUserId,
  getStackOutputs,
  getOutputValue,
  resolveApiUrlFromOutputs,
  buildDevboxNetworkPayload,
  getApiUrl,
  signRequest,
} = createAwsHelpers({
  DEFAULT_REGION,
  DEFAULT_WORKSPACE_MOUNT,
  LOCAL_SSH_MOUNT,
  SECURITY_GROUP_ID_RE,
  SUBNET_ID_RE,
  DEVBOX_SECURITY_GROUP_OUTPUT_KEYS,
  GENERIC_SECURITY_GROUP_OUTPUT_KEYS,
  DEVBOX_SUBNET_OUTPUT_KEYS,
  GENERIC_SUBNET_OUTPUT_KEYS,
  API_URL_CACHE_TTL_SECONDS,
  USER_ID_CACHE_TTL_SECONDS,
  RuntimeError,
  CommandError,
  MissingCommandError,
  run,
  isFile,
  expandUser,
  cacheGet,
  cacheSet,
  formatAmzDate,
  formatAmzDateStamp,
});


const {
  getArtifactsBucket,
  cmdDevboxProvision,
  cmdDevboxStatus,
  cmdDevboxStop,
  cmdDevboxStart,
  cmdDevboxTerminate,
  cmdDevboxLogs,
  cmdDevboxCheck,
  cmdDevboxConnect,
  cmdDebug,
  cmdDevboxSsh,
  cmdDevboxSshConfig,
  cmdDevboxUnsafeCopyGitKey,
} = createCloudCommands({
  CLI_NAME,
  SSH_KEY_PROPAGATION_WAIT_SECONDS,
  WSL_KEY_PROPAGATION_INITIAL_WAIT_SECONDS,
  SSH_KEY_INSTALL_CACHE_TTL_SECONDS,
  WSL_SSH_CONNECT_MAX_ATTEMPTS,
  WSL_SSH_CONNECT_RETRY_DELAY_SECONDS,
  WSL_SSH_FAST_RETRY_MAX_ELAPSED_MS,
  RuntimeError,
  CommandError,
  signRequest,
  getApiUrl,
  getStackOutputs,
  getOutputValue,
  resolveApiUrlFromOutputs,
  buildDevboxNetworkPayload,
  getUserId,
  awsCmd,
  timeSleep,
  isFile,
  isDir,
  splitLines,
  formatLocalIsoSeconds,
  formatTimestampForFilename,
  requireCommand,
  run,
  isWsl,
  cacheGet,
  cacheSet,
  expandUser,
  detectWindowsUserprofile,
  toWslPath,
  promptInputSync,
});

const {
  cmdDockerPull,
  cmdDockerUpdate,
  cmdDevcontainerGenerate,
  cmdArtifactsUpload,
  cmdArtifactsDownload,
  cmdArtifactsList,
} = createNonCloudCommands({
  CLI_NAME,
  CONTAINER_NAME_PREFIX,
  ECR_REPO_PREFERENCE,
  DEFAULT_DEVCONTAINER_IMAGE,
  BASE_DEVCONTAINER_EXTENSIONS,
  OPTIONAL_HOST_EXTENSION_IDS,
  DEFAULT_QNX_BASE,
  DEFAULT_RTI_BASE,
  DEVTOOLS_MARKER_FILE,
  DEVTOOLS_SUBMODULE_PATH,
  DEVTOOLS_CONTAINER_RELATIVE_PATHS,
  RuntimeError,
  CommandError,
  MissingCommandError,
  awsJson,
  awsCmd,
  run,
  requireCommand,
  resolveRegion,
  expandUser,
  isDir,
  isFile,
  splitLines,
  resolveWorkspaceMount,
  resolveSshMount,
  getGitRoot,
  ensureMarkerFile,
  ensureDevtoolsSubmodule,
  updateSubmodulesIfPresent,
  resolveShellName,
  resolveDevtoolsRoot,
  getShellRcPath,
  buildDevtoolsPathBlock,
  upsertShellBlock,
  getUserId,
  getArtifactsBucket,
});

function timeSleep(seconds: number): void {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, seconds * 1000);
}

const { parseOptions, cmdCompleteInternal, cmdCompletionInstall, parseInternalCompletionInstall } =
  createCompletionSupport({
    CLI_NAME,
    CACHE_NAMESPACE,
    INTERNAL_COMPLETION_INSTALL_ENV,
    RuntimeError,
    splitLines,
    getShellRcPath,
    upsertShellBlock,
  });

const { parseDocker, parseDevcontainer, parseArtifacts } =
  createNonCloudParsers({
    parseOptions,
    RuntimeError,
    cmdDockerPull,
    cmdDockerUpdate,
    cmdDevcontainerGenerate,
    cmdArtifactsUpload,
    cmdArtifactsDownload,
    cmdArtifactsList,
  });

function printHelp(topic = "main"): void {
  const helpByTopic: Record<string, string> = {
    main: `
Usage: ${CLI_NAME} [--profile PROFILE] [--region REGION] [--stack-name STACK_NAME] <command> [options]

Commands:
  cloud         Cloud devbox lifecycle and SSH helpers
  debug         Debug helpers for cloud devbox
  docker        Docker image helper
  devcontainer  Placeholder for devcontainer setup
  artifacts     Artifact management

Examples:
  ${CLI_NAME} cloud status
  ${CLI_NAME} cloud init
  ${CLI_NAME} debug --ssm
  ${CLI_NAME} docker pull --prune
  ${CLI_NAME} docker update --tag amd64-latest
  ${CLI_NAME} devcontainer generate --project-dir /path/to/repo
`.trim(),
    cloud: `
Usage: ${CLI_NAME} cloud <subcommand> [options]

Subcommands:
  provision
  status
  start
  stop
  terminate
  connect
  init
  unsafe-copy-git-key
`.trim(),
    "cloud.provision": `
Usage: ${CLI_NAME} cloud provision [options]

Options:
  --user-id <id>
  --wait
  --security-group-id <sg-id>
  --security-group-ids <sg-id[,sg-id...]>
  --subnet-id <subnet-id>
  -h, --help
`.trim(),
    "cloud.status": `
Usage: ${CLI_NAME} cloud status [options]

Options:
  --user-id <id>
  -h, --help
`.trim(),
    "cloud.start": `
Usage: ${CLI_NAME} cloud start [options]

Options:
  --user-id <id>
  -h, --help
`.trim(),
    "cloud.stop": `
Usage: ${CLI_NAME} cloud stop [options]

Options:
  --user-id <id>
  -h, --help
`.trim(),
    "cloud.terminate": `
Usage: ${CLI_NAME} cloud terminate [options]

Options:
  --user-id <id>
  -h, --help
`.trim(),
    "cloud.connect": `
Usage: ${CLI_NAME} cloud connect [options]

Options:
  --user-id <id>
  --ssh-user <name>
  -h, --help
`.trim(),
    "cloud.init": `
Usage: ${CLI_NAME} cloud init [options]

Options:
  --user-id <id>
  --ssh-user <name>
  --config-path <path>
  --wsl
  --wsl-distro <name>
  --windows-user <name>
  --dry-run
  -h, --help
`.trim(),
    "cloud.unsafe-copy-git-key": `
Usage: ${CLI_NAME} cloud unsafe-copy-git-key [options]

Options:
  --user-id <id>
  --ssh-user <name>
  --key-path <path>
  --remote-path <dir>
  -h, --help
`.trim(),
    debug: `
Usage: ${CLI_NAME} debug [options]

Options:
  --user-id <id>
  --cloud-logs
  --docker-check
  --ssm
  --save
  --log-dir <path>
  --full
  -h, --help
`.trim(),
    docker: `
Usage: ${CLI_NAME} docker <subcommand> [options]

Subcommands:
  pull
  update
`.trim(),
    "docker.pull": `
Usage: ${CLI_NAME} docker pull [options]

Options:
  --repository <name>
  --tag <tag>
  --prune
  --start
  --gui
  --container-name <name>
  --list-repos
  -h, --help
`.trim(),
    "docker.update": `
Usage: ${CLI_NAME} docker update [options]

Options:
  --repository <name>
  --tag <tag>
  --prune
  --start
  --gui
  --container-name <name>
  --list-repos
  -h, --help
`.trim(),
    devcontainer: `
Usage: ${CLI_NAME} devcontainer <subcommand> [options]

Subcommands:
  generate      TODO stub (no files generated)
`.trim(),
    "devcontainer.generate": `
Usage: ${CLI_NAME} devcontainer generate [options]

Options:
  --project-dir <path>       Project directory (default: .)
  -h, --help
`.trim(),
    artifacts: `
Usage: ${CLI_NAME} artifacts <subcommand> [options]

Subcommands:
  upload <file>
  download [filename]
  list
`.trim(),
    "artifacts.upload": `
Usage: ${CLI_NAME} artifacts upload [options] <file>

Options:
  --user-id <id>
  -h, --help
`.trim(),
    "artifacts.download": `
Usage: ${CLI_NAME} artifacts download [options] [filename]

Options:
  --user-id <id>
  -h, --help
`.trim(),
    "artifacts.list": `
Usage: ${CLI_NAME} artifacts list [options]

Options:
  --user-id <id>
  -h, --help
`.trim(),
  };

  console.log(helpByTopic[topic] ?? helpByTopic.main);
}

const { parseCloud, parseDebug } = createCloudParsers({
  parseOptions,
  RuntimeError,
  cmdDevboxProvision,
  cmdDevboxStatus,
  cmdDevboxStart,
  cmdDevboxStop,
  cmdDevboxTerminate,
  cmdDevboxSsh,
  cmdDevboxSshConfig,
  cmdDevboxUnsafeCopyGitKey,
  cmdDebug,
});

function parseMainArgs(argv: string[]): AnyDict {
  const args: AnyDict = {
    profile: process.env.AWS_PROFILE,
    region: undefined,
    stack_name: DEFAULT_STACK_NAME,
  };

  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    args.help = true;
    return args;
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      break;
    }

    const equalsIdx = token.indexOf("=");
    const key = equalsIdx >= 0 ? token.slice(2, equalsIdx) : token.slice(2);
    const valueInToken = equalsIdx >= 0 ? token.slice(equalsIdx + 1) : undefined;

    if (!["profile", "region", "stack-name"].includes(key)) {
      break;
    }

    const value =
      valueInToken !== undefined
        ? valueInToken
        : i + 1 < argv.length && !argv[i + 1].startsWith("--")
          ? argv[i + 1]
          : (() => {
              throw new RuntimeError(`Option requires value: --${key}`);
            })();

    if (key === "profile") {
      args.profile = value;
    } else if (key === "region") {
      args.region = value;
    } else if (key === "stack-name") {
      args.stack_name = value;
    }

    i += valueInToken !== undefined ? 1 : 2;
  }

  if (i >= argv.length) {
    return args;
  }

  if (argv[i] === "--help" || argv[i] === "-h") {
    args.help = true;
    return args;
  }

  const command = argv[i];
  args.command = command;
  const rest = argv.slice(i + 1);

  if (command === "cloud") {
    parseCloud(rest, args);
    return args;
  }
  if (command === "debug") {
    parseDebug(rest, args);
    return args;
  }
  if (command === "docker") {
    parseDocker(rest, args);
    return args;
  }
  if (command === "devcontainer") {
    parseDevcontainer(rest, args);
    return args;
  }
  if (command === "artifacts") {
    parseArtifacts(rest, args);
    return args;
  }
  if (command === "__complete") {
    args.complete_tokens = rest;
    args.func = cmdCompleteInternal as CommandFunc;
    return args;
  }
  if (command === "__completion-install") {
    parseInternalCompletionInstall(rest, args);
    return args;
  }

  throw new RuntimeError(`Unknown command: ${command}`);
}

async function main(argv?: string[]): Promise<void> {
  const parsedArgs = parseMainArgs(argv ?? process.argv.slice(2));

  if (parsedArgs.help || parsedArgs.help_topic || !parsedArgs.command) {
    printHelp(parsedArgs.help_topic ?? "main");
    return;
  }

  if (parsedArgs.region === undefined) {
    parsedArgs.region = resolveRegion(parsedArgs.region, parsedArgs.profile);
  }

  try {
    if (typeof parsedArgs.func === "function") {
      if (parsedArgs.command === "cloud") {
        await enforceLocalCloudControl(parsedArgs.cloud_command || "command");
      }
      await parsedArgs.func(parsedArgs);
    } else {
      printHelp();
    }
  } catch (error) {
    if (error instanceof RuntimeError) {
      console.log(`Error: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof MissingCommandError) {
      console.log(`Error: command not found: ${error.filename}`);
      process.exit(1);
    }
    if (error instanceof CommandError) {
      console.log(`Command failed: ${error.cmd.join(" ")}`);
      if (error.stdout) {
        console.log(error.stdout);
      }
      if (error.stderr) {
        console.log(error.stderr);
      }
      process.exit(error.returncode);
    }
    throw error;
  }
}

const entryArg = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
const thisFile = fs.realpathSync(fileURLToPath(import.meta.url));
if (entryArg && thisFile === entryArg) {
  main().catch((error) => {
    if (error instanceof RuntimeError) {
      console.log(`Error: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof MissingCommandError) {
      console.log(`Error: command not found: ${error.filename}`);
      process.exit(1);
    }
    if (error instanceof CommandError) {
      console.log(`Command failed: ${error.cmd.join(" ")}`);
      if (error.stdout) {
        console.log(error.stdout);
      }
      if (error.stderr) {
        console.log(error.stderr);
      }
      process.exit(error.returncode);
    }

    console.error(error);
    process.exit(1);
  });
}

export { main };
