// @ts-nocheck

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createCloudCommands(deps: Record<string, any>) {
  const {
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
  } = deps;

  async function callDevboxApi(
    apiUrl: string,
    action: string,
    userId: string,
    region: string,
    profile: string | undefined,
    payloadExtra?: AnyDict,
  ): Promise<AnyDict> {
    const url = `${apiUrl.replace(/\/+$/, "")}/devbox`;
    const payloadDict: AnyDict = { action, userId };
    if (payloadExtra) {
      Object.assign(payloadDict, payloadExtra);
    }

    const payload = Buffer.from(JSON.stringify(payloadDict), "utf8");
    const headers = signRequest("POST", url, payload, region, profile);

    let raw = "";
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
      });
      raw = await response.text();
      if (!response.ok) {
        throw new RuntimeError(`Devbox API error (${response.status}): ${raw}`);
      }
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw error;
      }

      const err = error as Error & { cause?: Error };
      const reason = err.cause?.message || err.message || "unknown error";
      throw new RuntimeError(`Devbox API request failed: ${reason}`);
    }

    try {
      return JSON.parse(raw) as AnyDict;
    } catch {
      return { raw };
    }
  }

  const devboxStatusCache = new Map<string, AnyDict>();

  async function getDevboxStatus(
    profile: string | undefined,
    region: string,
    stackName: string,
    userId: string,
  ): Promise<AnyDict> {
    const key = `${profile ?? ""}|${region}|${stackName}|${userId}`;
    if (devboxStatusCache.has(key)) {
      return devboxStatusCache.get(key) as AnyDict;
    }
    const apiUrl = getApiUrl(profile, region, stackName);
    const status = await callDevboxApi(apiUrl, "status", userId, region, profile);
    devboxStatusCache.set(key, status);
    return status;
  }

  function ensureInstanceRunning(status: AnyDict, _userId: string): string {
    const instanceId = status.instanceId;
    const state = status.status;

    if (!instanceId || instanceId === "null") {
      console.log("No devbox found. Provision one first:");
      console.log(`  ${CLI_NAME} cloud provision`);
      process.exit(1);
    }

    if (state !== "running") {
      console.log(`Devbox is ${state}, not running`);
      process.exit(1);
    }

    return String(instanceId);
  }

  function findSshPublicKey(): string | undefined {
    const envPub = process.env.SSH_PUBKEY_PATH;
    if (envPub && isFile(envPub)) {
      return envPub;
    }

    const envKey = process.env.SSH_KEY_PATH;
    if (envKey && isFile(`${envKey}.pub`)) {
      return `${envKey}.pub`;
    }

    const ed25519 = path.join(os.homedir(), ".ssh", "id_ed25519.pub");
    if (isFile(ed25519)) {
      return ed25519;
    }

    const rsa = path.join(os.homedir(), ".ssh", "id_rsa.pub");
    if (isFile(rsa)) {
      return rsa;
    }

    return undefined;
  }

  function findSshPrivateKey(): string | undefined {
    const envKey = process.env.SSH_KEY_PATH;
    if (envKey && isFile(envKey)) {
      return envKey;
    }

    const envPub = process.env.SSH_PUBKEY_PATH;
    if (envPub && envPub.endsWith(".pub") && isFile(envPub)) {
      const privateKey = envPub.slice(0, -4);
      if (isFile(privateKey)) {
        return privateKey;
      }
    }

    const ed25519 = path.join(os.homedir(), ".ssh", "id_ed25519");
    if (isFile(ed25519)) {
      return ed25519;
    }

    const rsa = path.join(os.homedir(), ".ssh", "id_rsa");
    if (isFile(rsa)) {
      return rsa;
    }

    return undefined;
  }

  function sendSsmCommands(
    instanceId: string,
    commands: string[],
    profile: string | undefined,
    region: string,
  ): string {
    const params = `commands=${JSON.stringify(commands)}`;
    const result = awsCmd(
      [
        "ssm",
        "send-command",
        "--instance-ids",
        instanceId,
        "--document-name",
        "AWS-RunShellScript",
        "--parameters",
        params,
        "--query",
        "Command.CommandId",
        "--output",
        "text",
      ],
      profile,
      region,
    );
    return result.stdout.trim();
  }

  function getSsmOutput(
    commandId: string,
    instanceId: string,
    profile: string | undefined,
    region: string,
  ): string {
    const result = awsCmd(
      [
        "ssm",
        "get-command-invocation",
        "--command-id",
        commandId,
        "--instance-id",
        instanceId,
        "--query",
        "StandardOutputContent",
        "--output",
        "text",
      ],
      profile,
      region,
    );
    return result.stdout;
  }

  function formatProxyCommand(region: string, profile?: string): string {
    const base = ["aws"];
    if (profile) {
      base.push("--profile", profile);
    }
    base.push(
      "ssm",
      "start-session",
      "--target",
      "%h",
      "--document-name",
      "AWS-StartSSHSession",
      "--parameters",
      "portNumber=%p",
      "--region",
      region,
    );
    return `sh -lc 'AWS_PAGER= exec ${base.join(" ")}'`;
  }

  function formatFastProxyCommand(region: string, profile?: string): string {
    const base = ["aws", "--no-cli-pager"];
    if (profile) {
      base.push("--profile", profile);
    }
    base.push(
      "ssm",
      "start-session",
      "--target",
      "%h",
      "--document-name",
      "AWS-StartSSHSession",
      "--parameters",
      "portNumber=%p",
      "--region",
      region,
    );
    return base.join(" ");
  }

  function buildSshKeyInstallCacheKey(instanceId: string, sshUser: string, pubKey: string): string {
    const pubKeyHash = crypto.createHash("sha256").update(pubKey, "utf8").digest("hex").slice(0, 16);
    return `ssh_key_installed:${instanceId}:${sshUser}:${pubKeyHash}`;
  }

  function formatWslProxyCommand(region: string, profile: string | undefined, distro: string): string {
    const distroArg = distro.includes(" ") ? `"${distro}"` : distro;
    const base = ["wsl", "-d", distroArg, "--", "aws"];
    if (profile) {
      base.push("--profile", profile);
    }
    base.push(
      "ssm",
      "start-session",
      "--target",
      "%h",
      "--document-name",
      "AWS-StartSSHSession",
      "--parameters",
      '"portNumber=%p"',
      "--region",
      region,
    );
    return base.join(" ");
  }

  function buildSshConfigEntry(
    host: string,
    instanceId: string,
    sshUser: string,
    region: string,
    profile: string | undefined,
  ): string {
    const proxyCommand = formatProxyCommand(region, profile);
    return [
      `Host ${host}`,
      `    HostName ${instanceId}`,
      `    User ${sshUser}`,
      `    ProxyCommand ${proxyCommand}`,
      "    StrictHostKeyChecking no",
      "    UserKnownHostsFile /dev/null",
      "",
    ].join("\n");
  }

  function buildWslSshConfigEntry(
    host: string,
    instanceId: string,
    sshUser: string,
    region: string,
    profile: string | undefined,
    identityFile: string,
    wslDistro: string,
  ): string {
    const proxyCommand = formatWslProxyCommand(region, profile, wslDistro);
    const identityValue = identityFile.includes(" ") ? `"${identityFile}"` : identityFile;
    return [
      `Host ${host}`,
      `    HostName ${instanceId}`,
      `    User ${sshUser}`,
      `    IdentityFile ${identityValue}`,
      "    IdentitiesOnly yes",
      `    ProxyCommand ${proxyCommand}`,
      "    StrictHostKeyChecking no",
      "    UserKnownHostsFile /dev/null",
      "",
    ].join("\n");
  }

  function copyKeyToWindows(privateKey: string, windowsSshDir: string): string {
    fs.mkdirSync(windowsSshDir, { recursive: true });
    const destKey = path.join(windowsSshDir, path.basename(privateKey));

    try {
      if (path.resolve(privateKey) !== path.resolve(destKey)) {
        fs.copyFileSync(privateKey, destKey);
      }
    } catch {
      // Keep behavior: ignore same file copies.
    }

    const pubKey = `${privateKey}.pub`;
    if (isFile(pubKey)) {
      const destPub = path.join(windowsSshDir, path.basename(pubKey));
      try {
        if (path.resolve(pubKey) !== path.resolve(destPub)) {
          fs.copyFileSync(pubKey, destPub);
        }
      } catch {
        // Keep behavior: ignore same file copies.
      }
    }

    return destKey;
  }

  function findHostBlock(lines: string[], host: string): [number, number] | null {
    let start: number | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line.startsWith("Host ")) {
        if (line === `Host ${host}`) {
          start = i;
          continue;
        }
        if (start !== null) {
          return [start, i];
        }
      }
    }

    if (start !== null) {
      return [start, lines.length];
    }
    return null;
  }

  function updateSshConfig(
    host: string,
    entry: string,
    configPath: string,
    overwrite: boolean,
    dryRun: boolean,
  ): void {
    if (dryRun) {
      console.log(entry);
      return;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const lines = fs.existsSync(configPath) ? splitLines(fs.readFileSync(configPath, "utf8")) : [];

    const block = findHostBlock(lines, host);
    if (block && !overwrite) {
      console.log(`SSH config entry already exists for ${host}`);
      const confirm = promptInputSync("Overwrite existing entry? (yes/no): ").trim().toLowerCase();
      if (confirm !== "yes") {
        console.log("Cancelled.");
        return;
      }
    }

    let newLines: string[];
    if (block) {
      const [start, end] = block;
      newLines = [...lines.slice(0, start), ...entry.split("\n"), ...lines.slice(end)];
    } else {
      newLines = [...lines, ...entry.split("\n")];
    }

    fs.writeFileSync(configPath, `${newLines.join("\n")}\n`);
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // Keep behavior: ignore permission errors.
    }

    console.log(`Updated SSH config: ${configPath}`);
  }

  function confirmPrompt(prompt: string): boolean {
    const response = promptInputSync(prompt).trim().toLowerCase();
    return response === "yes";
  }

  function boldRed(text: string): string {
    return `\x1b[1;31m${text}\x1b[0m`;
  }

  function getArtifactsBucket(profile: string | undefined, region: string, stackName: string): string {
    const outputs = getStackOutputs(profile, region, stackName);
    const bucket = getOutputValue(outputs, "ArtifactsBucket");
    if (!bucket) {
      throw new RuntimeError("Artifacts bucket not found in stack outputs");
    }
    return bucket;
  }

  function getUserTable(profile: string | undefined, region: string, stackName: string): string {
    const outputs = getStackOutputs(profile, region, stackName);
    const table = getOutputValue(outputs, "UserTable");
    if (!table) {
      throw new RuntimeError("User table not found in stack outputs");
    }
    return table;
  }

  function getInstanceIdFromTable(
    profile: string | undefined,
    region: string,
    stackName: string,
    userId: string,
  ): string {
    const table = getUserTable(profile, region, stackName);
    const result = awsCmd(
      [
        "dynamodb",
        "get-item",
        "--table-name",
        table,
        "--key",
        JSON.stringify({ userId: { S: userId } }),
        "--query",
        "Item.instanceId.S",
        "--output",
        "text",
      ],
      profile,
      region,
    );
    const instanceId = result.stdout.trim();
    if (!instanceId || instanceId === "None") {
      throw new RuntimeError(`No devbox found for ${userId}`);
    }
    return instanceId;
  }

  function getInstanceState(profile: string | undefined, region: string, instanceId: string): string {
    const result = awsCmd(
      [
        "ec2",
        "describe-instances",
        "--instance-ids",
        instanceId,
        "--query",
        "Reservations[0].Instances[0].State.Name",
        "--output",
        "text",
      ],
      profile,
      region,
    );
    return result.stdout.trim();
  }

  async function cmdDevboxProvision(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    const outputs = getStackOutputs(args.profile, args.region, args.stack_name);
    const apiUrl = resolveApiUrlFromOutputs(outputs);
    const networkPayload = buildDevboxNetworkPayload(outputs, args, args.profile, args.region);

    const response = await callDevboxApi(
      apiUrl,
      "provision",
      userId,
      args.region,
      args.profile,
      networkPayload,
    );

    console.log(JSON.stringify(response, null, 2));
    const status = response.status;

    if (args.wait && status === "pending") {
      console.log("Waiting for instance to be ready (about 2 minutes)...");
      try {
        timeSleep(120);
      } catch {
        console.log("Cancelled.");
        return;
      }
      console.log(`Devbox should be ready. Check status with: ${CLI_NAME} cloud status`);
    }
  }

  async function cmdDevboxStatus(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    const status = await getDevboxStatus(args.profile, args.region, args.stack_name, userId);
    console.log(JSON.stringify(status, null, 2));
  }

  async function cmdDevboxStop(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    const apiUrl = getApiUrl(args.profile, args.region, args.stack_name);
    const response = await callDevboxApi(apiUrl, "stop", userId, args.region, args.profile);
    console.log(JSON.stringify(response, null, 2));
  }

  async function cmdDevboxStart(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    const status = await getDevboxStatus(args.profile, args.region, args.stack_name, userId);
    const instanceId = status.instanceId;

    if (!instanceId || instanceId === "null") {
      throw new RuntimeError(`No devbox found for ${userId}`);
    }

    const state = status.status;
    if (state === "running") {
      console.log("Devbox is already running");
      return;
    }

    console.log(`Starting devbox ${instanceId}...`);
    awsCmd(["ec2", "start-instances", "--instance-ids", String(instanceId)], args.profile, args.region);
    console.log("Devbox starting. Wait 1-2 minutes before connecting.");
  }

  async function cmdDevboxTerminate(args: AnyDict): Promise<void> {
    if (!confirmPrompt("This will DELETE the devbox and all data. Continue? (yes/no): ")) {
      console.log("Cancelled.");
      return;
    }

    const userId = args.user_id || getUserId(args.profile);
    const apiUrl = getApiUrl(args.profile, args.region, args.stack_name);
    const response = await callDevboxApi(apiUrl, "terminate", userId, args.region, args.profile);
    console.log(JSON.stringify(response, null, 2));
  }

  async function cmdDevboxLogs(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    const instanceId = getInstanceIdFromTable(args.profile, args.region, args.stack_name, userId);
    const state = getInstanceState(args.profile, args.region, instanceId);

    const logLines: string[] = [];
    logLines.push("=== Devbox Log Check ===");
    logLines.push(`User: ${userId}`);
    logLines.push(`Time: ${formatLocalIsoSeconds(new Date())}`);
    logLines.push("");
    logLines.push(`Instance: ${instanceId}`);
    logLines.push(`Status: ${state}`);
    logLines.push("");
    logLines.push("=== Console Output (last 100 lines) ===");

    const consoleResult = awsCmd(
      ["ec2", "get-console-output", "--instance-id", instanceId, "--output", "text"],
      args.profile,
      args.region,
    );

    const consoleLines = splitLines(consoleResult.stdout).slice(-100);
    logLines.push(...consoleLines);
    logLines.push("");

    if (state === "running" && args.full) {
      const ssmCommands = [
        "echo '=== Docker Images ==='",
        "docker images",
        "echo",
        "echo '=== Cloud-Init Output Log ==='",
        "cat /var/log/cloud-init-output.log | tail -100",
        "echo",
        "echo '=== User Data Log ==='",
        "cat /var/log/user-data.log 2>/dev/null || echo No user-data.log found",
      ];
      const cmdId = sendSsmCommands(instanceId, ssmCommands, args.profile, args.region);
      timeSleep(3);
      const ssmOutput = getSsmOutput(cmdId, instanceId, args.profile, args.region).trim();
      if (ssmOutput) {
        logLines.push(ssmOutput);
        logLines.push("");
      }
    }

    const output = logLines.join("\n");
    console.log(output);

    if (args.save) {
      let logDir = args.log_dir ? args.log_dir : undefined;
      if (!logDir) {
        if (isDir(path.join("scripts", "logs"))) {
          logDir = path.join("scripts", "logs");
        } else {
          logDir = "logs";
        }
      }

      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `devbox-${userId}-${formatTimestampForFilename(new Date())}.log`);
      fs.writeFileSync(logFile, `${output}\n`);
      console.log(`Log saved to: ${logFile}`);
    }
  }

  async function cmdDevboxCheck(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    const status = await getDevboxStatus(args.profile, args.region, args.stack_name, userId);
    const instanceId = ensureInstanceRunning(status, userId);

    const commands = [
      "echo ===DOCKER STATUS===",
      "sudo systemctl status docker --no-pager",
      "echo",
      "echo ===DOCKER VERSION===",
      "docker --version",
      "echo",
      "echo ===DOCKER IMAGES===",
      "docker images",
      "echo",
      "echo ===WORKSPACE===",
      "ls -la /home/ec2-user/workspace",
    ];

    const cmdId = sendSsmCommands(instanceId, commands, args.profile, args.region);
    console.log("Waiting for command to complete...");
    timeSleep(3);
    const output = getSsmOutput(cmdId, instanceId, args.profile, args.region);
    console.log(output);
  }

  async function cmdDevboxConnect(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    console.log(`Looking up devbox for ${userId}...`);
    const status = await getDevboxStatus(args.profile, args.region, args.stack_name, userId);
    const instanceId = ensureInstanceRunning(status, userId);
    console.log(`Found instance: ${instanceId}`);
    console.log("Connecting via SSM...");
    console.log("");
    awsCmd(["ssm", "start-session", "--target", instanceId], args.profile, args.region, false, true);
  }

  async function cmdDebug(args: AnyDict): Promise<void> {
    if (!(args.cloud_logs || args.docker_check || args.ssm)) {
      throw new RuntimeError("Select a debug action: --cloud-logs, --docker-check, or --ssm");
    }

    if (!args.user_id) {
      args.user_id = getUserId(args.profile);
    }

    if (args.cloud_logs) {
      await cmdDevboxLogs(args);
    }
    if (args.docker_check) {
      await cmdDevboxCheck(args);
    }
    if (args.ssm) {
      if (args.cloud_logs || args.docker_check) {
        console.log("Opening SSM session (this will take over the terminal)...");
      }
      await cmdDevboxConnect(args);
    }
  }

  async function cmdDevboxSsh(args: AnyDict): Promise<void> {
    requireCommand("ssh");
    const fastSshConnect = isWsl() || process.platform === "win32";

    const userId = args.user_id || getUserId(args.profile);
    console.log(`Looking up devbox for ${userId}...`);

    const status = await getDevboxStatus(args.profile, args.region, args.stack_name, userId);
    const instanceId = ensureInstanceRunning(status, userId);

    const pubkeyPath = findSshPublicKey();
    if (!pubkeyPath) {
      console.log("No SSH public key found. Generate one with:");
      console.log("  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519");
      process.exit(1);
    }

    const privateKey = pubkeyPath.endsWith(".pub") ? pubkeyPath.slice(0, -4) : pubkeyPath;
    if (!isFile(privateKey)) {
      console.log(`Private key not found for ${pubkeyPath}`);
      process.exit(1);
    }

    console.log(`Found instance: ${instanceId}`);
    console.log("Ensuring SSH key is available via SSM (EC2 Instance Connect not available in private subnet)...");

    const pubKey = fs.readFileSync(pubkeyPath, "utf8").trim();
    const keyInstallCacheKey = buildSshKeyInstallCacheKey(String(instanceId), String(args.ssh_user), pubKey);
    const keyInstallCached =
      fastSshConnect && cacheGet(keyInstallCacheKey, SSH_KEY_INSTALL_CACHE_TTL_SECONDS) === "1";
    const commands = [
      `mkdir -p /home/${args.ssh_user}/.ssh`,
      `echo '${pubKey}' >> /home/${args.ssh_user}/.ssh/authorized_keys`,
      `chmod 700 /home/${args.ssh_user}/.ssh`,
      `chmod 600 /home/${args.ssh_user}/.ssh/authorized_keys`,
      `chown -R ${args.ssh_user}:${args.ssh_user} /home/${args.ssh_user}/.ssh`,
      `sort -u /home/${args.ssh_user}/.ssh/authorized_keys -o /home/${args.ssh_user}/.ssh/authorized_keys`,
    ];

    if (keyInstallCached) {
      console.log("Skipping SSM key install (recently cached for this devbox/key).");
    } else {
      sendSsmCommands(instanceId, commands, args.profile, args.region);
      cacheSet(keyInstallCacheKey, "1");
      console.log("Waiting for key to be added...");
      if (fastSshConnect) {
        timeSleep(WSL_KEY_PROPAGATION_INITIAL_WAIT_SECONDS);
      } else {
        timeSleep(SSH_KEY_PROPAGATION_WAIT_SECONDS);
      }
    }

    console.log("Connecting via SSH over SSM...");
    const proxyCommand = fastSshConnect
      ? formatFastProxyCommand(args.region, args.profile)
      : formatProxyCommand(args.region, args.profile);
    const sshCmd = [
      "ssh",
      "-i",
      privateKey,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      `ProxyCommand=${proxyCommand}`,
      `${args.ssh_user}@${instanceId}`,
    ];

    if (!fastSshConnect) {
      run(sshCmd, { captureOutput: false, check: true });
      return;
    }

    let didRefreshKeyInstall = !keyInstallCached;
    for (let attempt = 1; attempt <= WSL_SSH_CONNECT_MAX_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();
      const result = run(sshCmd, { captureOutput: false, check: false });
      if (result.returncode === 0) {
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      let refreshedKeyInstallThisAttempt = false;
      if (keyInstallCached && !didRefreshKeyInstall) {
        console.log("Cached SSH key may be stale, reinstalling via SSM and retrying...");
        sendSsmCommands(instanceId, commands, args.profile, args.region);
        cacheSet(keyInstallCacheKey, "1");
        didRefreshKeyInstall = true;
        refreshedKeyInstallThisAttempt = true;
        timeSleep(WSL_KEY_PROPAGATION_INITIAL_WAIT_SECONDS);
      }

      const canRetry =
        attempt < WSL_SSH_CONNECT_MAX_ATTEMPTS &&
        (refreshedKeyInstallThisAttempt || elapsedMs <= WSL_SSH_FAST_RETRY_MAX_ELAPSED_MS);
      if (!canRetry) {
        throw new CommandError(sshCmd, result.returncode, result.stdout, result.stderr);
      }

      console.log("SSH key still propagating, retrying...");
      timeSleep(WSL_SSH_CONNECT_RETRY_DELAY_SECONDS);
    }
  }

  async function cmdDevboxSshConfig(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    const status = await getDevboxStatus(args.profile, args.region, args.stack_name, userId);
    const instanceId = status.instanceId;

    if (!instanceId || instanceId === "null") {
      throw new RuntimeError(`No devbox found for ${userId}`);
    }

    const host = `devbox-${userId}`;

    if (args.wsl) {
      if (!isWsl()) {
        throw new RuntimeError("--wsl is only supported when running inside WSL");
      }

      const wslDistro = args.wsl_distro || process.env.WSL_DISTRO_NAME;
      if (!wslDistro) {
        throw new RuntimeError("Could not determine WSL distro. Pass --wsl-distro.");
      }

      let windowsHome: string | undefined;
      if (args.windows_user) {
        windowsHome = `C:\\Users\\${args.windows_user}`;
      } else {
        windowsHome = detectWindowsUserprofile();
      }

      if (!windowsHome) {
        throw new RuntimeError("Could not determine Windows user profile. Pass --windows-user.");
      }
      windowsHome = windowsHome.replace(/[\\/]+$/, "");

      const privateKey = findSshPrivateKey();
      if (!privateKey) {
        throw new RuntimeError("No SSH private key found. Set SSH_KEY_PATH or generate a key.");
      }

      const windowsSshDir = path.join(toWslPath(windowsHome), ".ssh");
      const configPath = args.config_path ? toWslPath(args.config_path) : path.join(windowsSshDir, "config");
      const identityFile = `${windowsHome}\\.ssh\\${path.basename(privateKey)}`;

      if (args.dry_run) {
        const destKey = path.join(windowsSshDir, path.basename(privateKey));
        console.log(`Dry run: would copy ${privateKey} to ${destKey}`);
      } else {
        const destKey = copyKeyToWindows(privateKey, windowsSshDir);
        console.log(`Copied SSH key to ${destKey}`);
      }

      const entry = buildWslSshConfigEntry(
        host,
        String(instanceId),
        args.ssh_user,
        args.region,
        args.profile,
        identityFile,
        wslDistro,
      );

      updateSshConfig(host, entry, configPath, true, args.dry_run);
      return;
    }

    const configPath = args.config_path ? expandUser(args.config_path) : expandUser("~/.ssh/config");
    const entry = buildSshConfigEntry(host, String(instanceId), args.ssh_user, args.region, args.profile);
    updateSshConfig(host, entry, configPath, true, args.dry_run);
  }

  async function cmdDevboxUnsafeCopyGitKey(args: AnyDict): Promise<void> {
    const userId = args.user_id || getUserId(args.profile);
    const status = await getDevboxStatus(args.profile, args.region, args.stack_name, userId);
    const instanceId = ensureInstanceRunning(status, userId);

    const requestedKeyPath = expandUser(args.key_path);
    const publicKeyPath = requestedKeyPath.endsWith(".pub") ? requestedKeyPath : `${requestedKeyPath}.pub`;
    const privateKeyPath = requestedKeyPath.endsWith(".pub")
      ? requestedKeyPath.slice(0, -4)
      : requestedKeyPath;

    if (!isFile(privateKeyPath)) {
      throw new RuntimeError(`Private key file not found: ${privateKeyPath}`);
    }
    if (!isFile(publicKeyPath)) {
      throw new RuntimeError(`Public key file not found: ${publicKeyPath}`);
    }

    const warning =
      "DANGER: You are about to copy a PRIVATE SSH key onto the devbox. " +
      "This is unsafe, should be a last resort, and can compromise your account.";
    console.log(boldRed(warning));

    if (!confirmPrompt("Continue? (yes/no): ")) {
      console.log("Cancelled.");
      return;
    }
    if (!confirmPrompt("Are you absolutely sure? (yes/no): ")) {
      console.log("Cancelled.");
      return;
    }

    const privateKeyB64 = fs.readFileSync(privateKeyPath).toString("base64");
    const publicKeyB64 = fs.readFileSync(publicKeyPath).toString("base64");
    const remoteDir = args.remote_path || `/home/${args.ssh_user}/.ssh`;
    const remotePrivatePath = path.posix.join(remoteDir, path.basename(privateKeyPath));
    const remotePublicPath = path.posix.join(remoteDir, path.basename(publicKeyPath));

    const commands = [
      `mkdir -p ${remoteDir}`,
      `echo '${privateKeyB64}' | base64 -d > ${remotePrivatePath}`,
      `echo '${publicKeyB64}' | base64 -d > ${remotePublicPath}`,
      `chmod 700 ${remoteDir}`,
      `chmod 600 ${remotePrivatePath}`,
      `chmod 644 ${remotePublicPath}`,
      `chown ${args.ssh_user}:${args.ssh_user} ${remoteDir}`,
      `chown ${args.ssh_user}:${args.ssh_user} ${remotePrivatePath}`,
      `chown ${args.ssh_user}:${args.ssh_user} ${remotePublicPath}`,
    ];

    sendSsmCommands(instanceId, commands, args.profile, args.region);
    console.log(
      `SSH key pair copied to ${remotePrivatePath} and ${remotePublicPath} on ${instanceId}`,
    );
  }

  return {
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
  };
}
