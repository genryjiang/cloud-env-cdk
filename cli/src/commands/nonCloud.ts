// @ts-nocheck

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createNonCloudCommands(deps: Record<string, any>) {
  const {
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
  } = deps;

  function listEcrRepositories(region: string, profile: string | undefined): AnyDict[] {
    const data = awsJson(["ecr", "describe-repositories"], profile, region);
    return Array.isArray(data.repositories) ? data.repositories : [];
  }

  function getLatestImageTag(
    repositoryName: string,
    region: string,
    profile: string | undefined,
  ): string | undefined {
    let result: CompletedProcess;
    try {
      result = awsCmd(
        [
          "ecr",
          "describe-images",
          "--repository-name",
          repositoryName,
          "--query",
          "sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]",
          "--output",
          "text",
        ],
        profile,
        region,
      );
    } catch (error) {
      if (error instanceof CommandError) {
        return undefined;
      }
      throw error;
    }

    const tag = result.stdout.trim();
    if (!tag || tag === "None") {
      return undefined;
    }
    return tag;
  }

  function findRepository(repositories: AnyDict[]): AnyDict | undefined {
    if (repositories.length === 0) {
      return undefined;
    }

    const normalized = repositories.map((repo) => [repo, String(repo.repositoryName ?? "").toLowerCase()] as const);
    for (const pattern of ECR_REPO_PREFERENCE) {
      for (const [repo, name] of normalized) {
        if (name.includes(pattern)) {
          return repo;
        }
      }
    }

    return repositories[0];
  }

  function ecrLogin(registry: string, region: string, profile: string | undefined): void {
    const result = awsCmd(["ecr", "get-login-password"], profile, region);
    const login = run(["docker", "login", "--username", "AWS", "--password-stdin", registry], {
      input: result.stdout,
      check: false,
      captureOutput: false,
    });

    if (login.returncode !== 0) {
      throw new RuntimeError("Docker login failed");
    }
  }

  function sanitizeContainerName(value: string): string {
    const sanitized = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
    return sanitized || "dev";
  }

  function defaultContainerName(repoName: string): string {
    if (repoName) {
      return `${CONTAINER_NAME_PREFIX}-${sanitizeContainerName(repoName)}`;
    }
    return `${CONTAINER_NAME_PREFIX}-dev`;
  }

  function buildGuiDockerRunArgs(): string[] {
    const args = ["-e", "QT_X11_NO_MITSHM=1"];
    const display = process.env.DISPLAY;

    if (display) {
      args.push("-e", `DISPLAY=${display}`);
    } else {
      console.log("Warning: DISPLAY is not set; GUI apps may not work.");
    }

    const x11Socket = "/tmp/.X11-unix";
    if (fs.existsSync(x11Socket)) {
      args.push("-v", `${x11Socket}:${x11Socket}:rw`);
    } else {
      console.log("Warning: /tmp/.X11-unix not found; GUI apps may not work.");
    }

    const xauthority = process.env.XAUTHORITY;
    if (xauthority) {
      const xauthPath = expandUser(xauthority);
      if (fs.existsSync(xauthPath)) {
        args.push("-e", `XAUTHORITY=${xauthPath}`, "-v", `${xauthPath}:${xauthPath}:ro`);
      }
    }

    return args;
  }

  function dockerContainerExists(name: string): boolean {
    const result = run(["docker", "inspect", "-f", "{{.Id}}", name], {
      captureOutput: true,
      check: false,
    });
    return result.returncode === 0 && result.stdout.trim().length > 0;
  }

  function startDockerContainer(imageUri: string, containerName: string, gui: boolean): void {
    if (dockerContainerExists(containerName)) {
      console.log(`Starting existing container: ${containerName}`);
      run(["docker", "start", containerName], { captureOutput: false, check: true });
      return;
    }

    const cmd = ["docker", "run", "-d", "--name", containerName];
    if (gui) {
      cmd.push(...buildGuiDockerRunArgs());
    }
    cmd.push(imageUri);

    console.log(`Creating container: ${containerName}`);
    run(cmd, { captureOutput: false, check: true });
  }

  async function cmdDockerPull(args: AnyDict): Promise<void> {
    requireCommand("docker");
    requireCommand("aws");

    const region = args.region || resolveRegion(undefined, args.profile);
    const repositories = listEcrRepositories(region, args.profile);
    if (repositories.length === 0) {
      throw new RuntimeError("No ECR repositories found in this account/region");
    }

    if (args.list_repos) {
      console.log("Available ECR repositories:");
      for (const repo of repositories) {
        const name = String(repo.repositoryName ?? "");
        const uri = String(repo.repositoryUri ?? "");
        const latestTag = getLatestImageTag(name, region, args.profile);
        console.log(`  - ${name}`);
        console.log(`    URI: ${uri}`);
        console.log(`    Latest tag: ${latestTag || "N/A"}`);
        console.log("");
      }
      return;
    }

    let targetRepo: AnyDict | undefined;
    if (args.repository) {
      targetRepo = repositories.find((r) => String(r.repositoryName ?? "") === args.repository);
      if (!targetRepo) {
        throw new RuntimeError(`Repository not found: ${args.repository}`);
      }
    } else {
      targetRepo = findRepository(repositories);
      if (!targetRepo) {
        throw new RuntimeError("Could not auto-detect repository");
      }
    }

    const repoUri = String(targetRepo.repositoryUri ?? "");
    const repoName = String(targetRepo.repositoryName ?? "");
    console.log(`Using repository: ${repoName}`);

    const tag = String(args.tag ?? "").trim();
    if (!tag) {
      throw new RuntimeError(
        "Missing Docker image tag. Pass --tag (for example: --tag amd64-latest or --tag mvp-latest).",
      );
    }
    if (tag === "amd64-latest") {
      const detectedTag = getLatestImageTag(repoName, region, args.profile);
      if (detectedTag) {
        console.log(`Detected latest tag: ${detectedTag}`);
      }
    }

    const imageUri = `${repoUri}:${tag}`;
    console.log(`Target image: ${imageUri}`);

    const registry = repoUri.split("/")[0];
    console.log(`Logging into ECR: ${registry}`);
    ecrLogin(registry, region, args.profile);

    console.log(`Pulling image: ${imageUri}`);
    run(["docker", "pull", imageUri], { captureOutput: false, check: true });
    console.log("Image pulled successfully");

    if (args.prune) {
      console.log("Pruning stopped containers...");
      run(["docker", "container", "prune", "-f"], { captureOutput: false, check: true });
      console.log("Pruning dangling images...");
      run(["docker", "image", "prune", "-f"], { captureOutput: false, check: true });
    }

    if (args.start || args.gui) {
      const containerName = args.container_name || defaultContainerName(repoName);
      startDockerContainer(imageUri, containerName, args.gui);
      if (args.gui) {
        console.log("Note: you may need to run `xhost +local:docker` on your host for GUI access.");
      }
    }

    console.log("Docker image pull complete");
  }

  async function cmdDockerUpdate(args: AnyDict): Promise<void> {
    await cmdDockerPull(args);
  }

  function getEcrImageUri(region: string, profile: string | undefined): string | undefined {
    try {
      const repositories = listEcrRepositories(region, profile);
      const targetRepo = findRepository(repositories);
      if (targetRepo) {
        return String(targetRepo.repositoryUri ?? "");
      }
    } catch (error) {
      if (error instanceof CommandError || error instanceof MissingCommandError) {
        return undefined;
      }
      throw error;
    }
    return undefined;
  }

  function repositoryPreferenceRank(repositoryName: string): number {
    const normalized = repositoryName.toLowerCase();
    for (let i = 0; i < ECR_REPO_PREFERENCE.length; i += 1) {
      if (normalized.includes(ECR_REPO_PREFERENCE[i])) {
        return i;
      }
    }
    return ECR_REPO_PREFERENCE.length;
  }

  function orderRepositoriesByPreference(repositories: AnyDict[]): AnyDict[] {
    return [...repositories].sort((left, right) => {
      const leftName = String(left.repositoryName ?? "");
      const rightName = String(right.repositoryName ?? "");
      return repositoryPreferenceRank(leftName) - repositoryPreferenceRank(rightName);
    });
  }

  function repositoryHasTag(
    repositoryName: string,
    tag: string,
    region: string,
    profile: string | undefined,
  ): boolean {
    try {
      const result = awsCmd(
        [
          "ecr",
          "describe-images",
          "--repository-name",
          repositoryName,
          "--image-ids",
          `imageTag=${tag}`,
          "--query",
          "length(imageDetails)",
          "--output",
          "text",
        ],
        profile,
        region,
      );
      const raw = result.stdout.trim();
      const count = Number(raw);
      return Number.isFinite(count) && count > 0;
    } catch (error) {
      if (error instanceof CommandError) {
        return false;
      }
      throw error;
    }
  }

  function resolveDevcontainerImage(region: string, profile: string | undefined, useMvpTag: boolean): string {
    const preferredTag = useMvpTag ? "mvp-latest" : "amd64-latest";
    try {
      const repositories = listEcrRepositories(region, profile);
      if (repositories.length === 0) {
        return DEFAULT_DEVCONTAINER_IMAGE;
      }
      const ordered = orderRepositoriesByPreference(repositories);
      let selectedRepo = ordered[0];
      if (useMvpTag) {
        const repoWithMvpTag = ordered.find((repo) =>
          repositoryHasTag(String(repo.repositoryName ?? ""), preferredTag, region, profile),
        );
        if (repoWithMvpTag) {
          selectedRepo = repoWithMvpTag;
        }
      } else {
        const autoRepo = findRepository(repositories);
        if (autoRepo) {
          selectedRepo = autoRepo;
        }
      }
      const repositoryUri = String(selectedRepo.repositoryUri ?? "");
      if (!repositoryUri) {
        return DEFAULT_DEVCONTAINER_IMAGE;
      }
      return `${repositoryUri}:${preferredTag}`;
    } catch {
      return DEFAULT_DEVCONTAINER_IMAGE;
    }
  }

  function listInstalledHostExtensions(): Set<string> {
    const installed = new Set<string>();

    const result = spawnSync("code", ["--list-extensions"], {
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    });
    if (!result.error && (result.status ?? 0) === 0) {
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      for (const line of splitLines(stdout)) {
        const extensionId = line.trim().toLowerCase();
        if (extensionId) {
          installed.add(extensionId);
        }
      }
    }

    const extensionRoots = [
      path.join(os.homedir(), ".vscode", "extensions"),
      path.join(os.homedir(), ".vscode-server", "extensions"),
      path.join(os.homedir(), ".vscode-remote", "extensions"),
    ];
    for (const root of extensionRoots) {
      if (!isDir(root)) {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const pkgPath = path.join(root, entry.name, "package.json");
        if (!isFile(pkgPath)) {
          continue;
        }
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as AnyDict;
          const publisher = String(pkg.publisher ?? "").trim().toLowerCase();
          const name = String(pkg.name ?? "").trim().toLowerCase();
          if (publisher && name) {
            installed.add(`${publisher}.${name}`);
          }
        } catch {
          // Skip malformed extension directories.
        }
      }
    }

    return installed;
  }

  function resolveOptionalDevcontainerExtensions(): string[] {
    const installed = listInstalledHostExtensions();
    return OPTIONAL_HOST_EXTENSION_IDS.filter((id) => installed.has(id));
  }

  function generateDevcontainerJson(
    image: string,
    workspaceMount: string,
    workspaceFolder: string,
    remoteUser: string,
    sshMount: string,
  ): AnyDict {
    const extensions = [...new Set([...BASE_DEVCONTAINER_EXTENSIONS, ...resolveOptionalDevcontainerExtensions()])];
    const devtoolsPathSuffix = DEVTOOLS_CONTAINER_RELATIVE_PATHS.map((p: string) => `${workspaceFolder}/${p}`).join(
      ":",
    );
    return {
      name: "Embedded development environment",
      customizations: {
        vscode: {
          extensions,
          settings: {
            "terminal.integrated.defaultProfile.linux": "bash",
          },
        },
      },
      mounts: [
        `source=${workspaceMount},target=${workspaceFolder},type=bind`,
        `source=${sshMount},target=/home/${remoteUser}/.ssh,type=bind,readonly`,
      ],
      remoteEnv: {
        PATH: `\${containerEnv:PATH}:${devtoolsPathSuffix}`,
      },
      workspaceFolder,
      updateRemoteUserUID: false,
      remoteUser,
    };
  }

  function generateSingleContainerDevcontainerJson(
    image: string,
    workspaceMount: string,
    workspaceFolder: string,
    remoteUser: string,
    sshMount: string,
  ): AnyDict {
    return {
      ...generateDevcontainerJson(image, workspaceMount, workspaceFolder, remoteUser, sshMount),
      image,
      runArgs: ["-it"],
      overrideCommand: false,
    };
  }

  function generateComposeDevcontainerJson(
    image: string,
    workspaceMount: string,
    workspaceFolder: string,
    remoteUser: string,
    sshMount: string,
    enableCanbus: boolean,
    canbusPort: number,
    enableMqtt: boolean,
    mqttPort: number,
  ): AnyDict {
    const runServices: string[] = [];
    const containerEnv: AnyDict = {};

    if (enableCanbus) {
      runServices.push("canbus");
      containerEnv.CANBUS_HOST = "canbus";
      containerEnv.CANBUS_PORT = String(canbusPort);
      containerEnv.CANBUS_ENDPOINT = `canbus:${canbusPort}`;
    }

    if (enableMqtt) {
      runServices.push("mqtt");
      containerEnv.MQTT_HOST = "mqtt";
      containerEnv.MQTT_PORT = String(mqttPort);
      containerEnv.MQTT_BROKER_URL = `mqtt://mqtt:${mqttPort}`;
    }

    return {
      ...generateDevcontainerJson(image, workspaceMount, workspaceFolder, remoteUser, sshMount),
      dockerComposeFile: ["docker-compose.yml"],
      service: "dev",
      runServices,
      shutdownAction: "stopCompose",
      containerEnv,
      overrideCommand: false,
    };
  }

  function generateDevcontainerComposeYaml(
    image: string,
    enableCanbus: boolean,
    canbusPort: number,
    enableMqtt: boolean,
    mqttPort: number,
  ): string {
    const services: string[] = [];
    const dependsOn: string[] = [];
    const devEnvLines: string[] = [];

    if (enableCanbus) {
      dependsOn.push("canbus");
      devEnvLines.push("      CANBUS_HOST: canbus");
      devEnvLines.push(`      CANBUS_PORT: "${canbusPort}"`);
      devEnvLines.push(`      CANBUS_ENDPOINT: canbus:${canbusPort}`);
      services.push(
        [
          "  canbus:",
          `    image: ${image}`,
          `    command: ["vcan-server", "--port", "${canbusPort}"]`,
          "    restart: unless-stopped",
        ].join("\n"),
      );
    }

    if (enableMqtt) {
      dependsOn.push("mqtt");
      devEnvLines.push("      MQTT_HOST: mqtt");
      devEnvLines.push(`      MQTT_PORT: "${mqttPort}"`);
      devEnvLines.push(`      MQTT_BROKER_URL: mqtt://mqtt:${mqttPort}`);
      services.push(
        [
          "  mqtt:",
          `    image: ${image}`,
          '    command: ["mosquitto", "-c", "/tmp/mosquitto.conf"]',
          "    restart: unless-stopped",
          "    volumes:",
          "      - ./mosquitto.conf:/tmp/mosquitto.conf:ro",
        ].join("\n"),
      );
    }

    const devLines = [
      "  dev:",
      `    image: ${image}`,
      '    command: ["sleep", "infinity"]',
    ];
    if (dependsOn.length > 0) {
      devLines.push("    depends_on:");
      for (const serviceName of dependsOn) {
        devLines.push(`      - ${serviceName}`);
      }
    }
    if (devEnvLines.length > 0) {
      devLines.push("    environment:");
      devLines.push(...devEnvLines);
    }

    services.push(devLines.join("\n"));
    return `services:\n${services.join("\n\n")}\n`;
  }

  function generateMosquittoConfig(mqttPort: number): string {
    return [
      "persistence false",
      "log_dest stdout",
      `listener ${mqttPort}`,
      "allow_anonymous true",
      "",
    ].join("\n");
  }

  function generateCCppProperties(
    qnxBase: string,
    rtiBase: string,
    includeQnx: boolean,
    useMvpConfig: boolean,
  ): AnyDict {
    if (useMvpConfig) {
      return {
        version: 4,
        configurations: [
          {
            name: "SR-MVP-RTI",
            includePath: [`${rtiBase}/include`, `${rtiBase}/include/ndds/hpp`, `${rtiBase}/include/ndds`],
            browse: {
              path: [`${rtiBase}/include`, `${rtiBase}/include/ndds/hpp`],
              limitSymbolsToIncludedHeaders: true,
            },
            defines: [],
            compilerPath: "/usr/bin/g++",
            cStandard: "c17",
            cppStandard: "c++17",
            intelliSenseMode: "linux-gcc-x64",
          },
        ],
      };
    }

    const rtiIncludeRoot = `${rtiBase}/include`;
    const sharedIncludePath = [
      "${workspaceFolder}/app",
      "${workspaceFolder}/dev-can-linux",
      rtiIncludeRoot,
      `${rtiIncludeRoot}/**`,
    ];
    const sharedBrowsePath = ["${workspaceFolder}", `${rtiIncludeRoot}/**`];
    const configurations = [
      {
        name: "linux-fallback",
        includePath: sharedIncludePath,
        browse: {
          path: sharedBrowsePath,
          limitSymbolsToIncludedHeaders: true,
        },
        defines: [],
        compilerPath: "/usr/bin/gcc",
        cStandard: "c17",
        cppStandard: "c++17",
        intelliSenseMode: "linux-gcc-x64",
      },
    ];
    if (includeQnx) {
      configurations.push({
        name: "qnx",
        includePath: [
          ...sharedIncludePath,
          `${qnxBase}/target/qnx/usr/include`,
          `${qnxBase}/target/qnx/usr/local/include`,
        ],
        browse: {
          path: [...sharedBrowsePath, `${qnxBase}/target/qnx/usr/include`, `${qnxBase}/target/qnx/usr/local/include`],
          limitSymbolsToIncludedHeaders: true,
        },
        defines: ["__QNX__", "__QNXNTO__"],
        compilerPath: `${qnxBase}/host/linux/x86_64/usr/bin/qcc`,
        cStandard: "c17",
        cppStandard: "c++17",
        intelliSenseMode: "linux-gcc-x64",
      });
    }
    return {
      version: 4,
      configurations,
    };
  }

  function generateVscodeSettings(includeQnx: boolean, useMvpConfig: boolean): AnyDict {
    if (useMvpConfig) {
      return {
        "C_Cpp.intelliSenseEngine": "default",
        "C_Cpp.autocompleteAddParentheses": true,
        "C_Cpp.intelliSenseCacheSize": 5120,
        "C_Cpp.intelliSenseMemoryLimit": 4096,
        "C_Cpp.default.browse.limitSymbolsToIncludedHeaders": true,
        "C_Cpp.workspaceParsing.maxConcurrentBrowsingThreads": 4,
        "C_Cpp.workspaceParsingPriority": "low",
        "C_Cpp.codeAnalysis.runAutomatically": false,
        "C_Cpp.intelliSenseEngineFallback": "Disabled",
        "editor.formatOnSave": true,
        "editor.tabSize": 4,
        "editor.insertSpaces": true,
        "terminal.integrated.defaultProfile.linux": "bash",
      };
    }

    const settings: AnyDict = {
      "C_Cpp.intelliSenseEngine": "default",
      "C_Cpp.autocompleteAddParentheses": true,
      "C_Cpp.intelliSenseCacheSize": 5120,
      "C_Cpp.intelliSenseMemoryLimit": 4096,
      "C_Cpp.default.browse.limitSymbolsToIncludedHeaders": true,
      "C_Cpp.workspaceParsing.maxConcurrentBrowsingThreads": 4,
      "C_Cpp.codeAnalysis.runAutomatically": false,
      "files.watcherExclude": {
        "**/build-files/**": true,
        "**/deprecated/**": true,
        "**/.git/**": true,
        "**/node_modules/**": true,
        "**/__pycache__/**": true,
      },
      "search.exclude": {
        "**/build-files/**": true,
        "**/deprecated/**": true,
      },
      "editor.formatOnSave": true,
      "editor.tabSize": 4,
      "editor.insertSpaces": true,
      "terminal.integrated.defaultProfile.linux": "bash",
    };
    if (includeQnx) {
      settings["python.defaultInterpreterPath"] = "/usr/local/qnx/env/bin/python3";
    }
    return settings;
  }

  function generateTasksJson(qnxBase: string, includeQnx: boolean): AnyDict {
    if (!includeQnx) {
      return {
        version: "2.0.0",
        tasks: [],
      };
    }
    const qnxEnvScript = `${qnxBase}/qnxsdp-env.sh`;
    const sourceQnxCommand = `if [ -f "${qnxEnvScript}" ]; then . "${qnxEnvScript}"; else echo "QNX SDP not found at ${qnxEnvScript}" >&2; exit 1; fi`;
    return {
      version: "2.0.0",
      tasks: [
        {
          label: "Source QNX Environment",
          type: "shell",
          command: `${sourceQnxCommand} && echo 'QNX environment loaded'`,
          problemMatcher: [],
          group: "build",
        },
        {
          label: "Build with QCC",
          type: "shell",
          command: `${sourceQnxCommand} && qcc \${file} -o \${fileDirname}/\${fileBasenameNoExtension}`,
          problemMatcher: ["$gcc"],
          group: {
            kind: "build",
            isDefault: true,
          },
        },
        {
          label: "Check QCC License",
          type: "shell",
          command: `${sourceQnxCommand} && qcc --version`,
          problemMatcher: [],
          group: "build",
        },
      ],
    };
  }

  function generateLaunchJson(): AnyDict {
    return {
      version: "0.2.0",
      configurations: [
        {
          name: "Debug Current File",
          type: "cppdbg",
          request: "launch",
          program: "${fileDirname}/${fileBasenameNoExtension}",
          args: [],
          stopAtEntry: false,
          cwd: "${workspaceFolder}",
          environment: [],
          externalConsole: false,
          MIMode: "gdb",
          setupCommands: [
            {
              description: "Enable pretty-printing for gdb",
              text: "-enable-pretty-printing",
              ignoreFailures: true,
            },
          ],
        },
      ],
    };
  }

  function writeJsonFile(filePath: string, data: AnyDict): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  function writeTextFile(filePath: string, contents: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents.endsWith("\n") ? contents : `${contents}\n`);
  }

  function parsePort(value: unknown, fallback: number, optionName: string): number {
    if (value === undefined || value === null || String(value).trim() === "") {
      return fallback;
    }
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new RuntimeError(`Invalid ${optionName}: ${value}. Expected an integer port between 1 and 65535.`);
    }
    return parsed;
  }

  function generateDevcontainerFiles(
    projectDir: string,
    workspaceMount: string | undefined,
    remoteUser: string,
    region: string,
    profile: string | undefined,
    useMvpTag: boolean,
    includeQnx: boolean,
    enableCanbus: boolean,
    enableMqtt: boolean,
    canbusPort: number,
    mqttPort: number,
  ): void {
    const devcontainerDir = path.join(projectDir, ".devcontainer");
    const vscodeDir = path.join(projectDir, ".vscode");
    // Use a single host-path mount strategy for both local and cloud environments.
    const resolvedWorkspaceMount = resolveWorkspaceMount(workspaceMount, true, projectDir);
    const sshMount = resolveSshMount(true);
    const qnxBase = DEFAULT_QNX_BASE;
    const rtiBase = DEFAULT_RTI_BASE;
    const resolvedImage = resolveDevcontainerImage(region, profile, useMvpTag);
    const useComposeSidecars = enableCanbus || enableMqtt;

    let devcontainerConfig: AnyDict;
    if (useComposeSidecars) {
      devcontainerConfig = generateComposeDevcontainerJson(
        resolvedImage,
        resolvedWorkspaceMount,
        "/workspace",
        remoteUser,
        sshMount,
        enableCanbus,
        canbusPort,
        enableMqtt,
        mqttPort,
      );
      writeTextFile(
        path.join(devcontainerDir, "docker-compose.yml"),
        generateDevcontainerComposeYaml(resolvedImage, enableCanbus, canbusPort, enableMqtt, mqttPort),
      );
      if (enableMqtt) {
        writeTextFile(path.join(devcontainerDir, "mosquitto.conf"), generateMosquittoConfig(mqttPort));
      }
    } else {
      devcontainerConfig = generateSingleContainerDevcontainerJson(
        resolvedImage,
        resolvedWorkspaceMount,
        "/workspace",
        remoteUser,
        sshMount,
      );
    }

    writeJsonFile(path.join(devcontainerDir, "devcontainer.json"), devcontainerConfig);
    writeJsonFile(
      path.join(vscodeDir, "c_cpp_properties.json"),
      generateCCppProperties(qnxBase, rtiBase, includeQnx, useMvpTag),
    );
    writeJsonFile(path.join(vscodeDir, "settings.json"), generateVscodeSettings(includeQnx, useMvpTag));
    writeJsonFile(path.join(vscodeDir, "tasks.json"), generateTasksJson(qnxBase, includeQnx));
    writeJsonFile(path.join(vscodeDir, "launch.json"), generateLaunchJson());
  }

  function initDevcontainerConfigs(
    projectDir: string,
    workspaceMount: string | undefined,
    remoteUser: string,
    region: string,
    profile: string | undefined,
    useMvpTag: boolean,
    noCanbus: boolean,
    noMqtt: boolean,
    canbusPortValue: unknown,
    mqttPortValue: unknown,
  ): void {
    const includeQnx = !useMvpTag;
    const enableCanbus = !Boolean(noCanbus);
    const enableMqtt = !Boolean(noMqtt);
    const canbusPort = parsePort(canbusPortValue, 18881, "--canbus-port");
    const mqttPort = parsePort(mqttPortValue, 1883, "--mqtt-port");
    if (useMvpTag) {
      console.log("MVP mode enabled: preferring mvp-latest image tag and RTI-first VS Code config.");
    }
    if (enableCanbus) {
      console.log(`Compose mode enabled with virtual CAN sidecar on canbus:${canbusPort}.`);
    }
    if (enableMqtt) {
      console.log(`MQTT broker sidecar enabled on mqtt:${mqttPort}.`);
    }
    if (!enableCanbus && !enableMqtt) {
      console.log("Both sidecars disabled; generating single-container devcontainer config.");
    }
    generateDevcontainerFiles(
      projectDir,
      workspaceMount,
      remoteUser,
      region,
      profile,
      useMvpTag,
      includeQnx,
      enableCanbus,
      enableMqtt,
      canbusPort,
      mqttPort,
    );
  }

  async function cmdDevcontainerGenerate(args: AnyDict): Promise<void> {
    const projectDir = expandUser(args.project_dir);
    console.log(`TODO: devcontainer generation is not implemented yet for project directory: ${projectDir}`);
  }

  async function cmdArtifactsUpload(args: AnyDict): Promise<void> {
    requireCommand("aws");

    const filePath = expandUser(args.file);
    if (!isFile(filePath)) {
      throw new RuntimeError(`File not found: ${filePath}`);
    }

    const userId = args.user_id || getUserId(args.profile);
    const bucket = getArtifactsBucket(args.profile, args.region, args.stack_name);
    const dest = `s3://${bucket}/${userId}/${path.basename(filePath)}`;

    console.log(`Uploading ${filePath} to ${dest}...`);
    awsCmd(["s3", "cp", filePath, dest], args.profile, args.region);
    console.log(`Uploaded to ${dest}`);
  }

  async function cmdArtifactsDownload(args: AnyDict): Promise<void> {
    requireCommand("aws");

    const userId = args.user_id || getUserId(args.profile);
    const bucket = getArtifactsBucket(args.profile, args.region, args.stack_name);

    awsCmd(
      ["s3", "ls", `s3://${bucket}/${userId}/`, "--human-readable"],
      args.profile,
      args.region,
      false,
      true,
    );

    if (!args.filename) {
      console.log(`To download: ${CLI_NAME} artifacts download <filename>`);
      return;
    }

    const dest = path.basename(args.filename);
    console.log(`Downloading ${args.filename}...`);
    awsCmd(
      ["s3", "cp", `s3://${bucket}/${userId}/${args.filename}`, `./${dest}`],
      args.profile,
      args.region,
    );
    console.log(`Downloaded to ./${dest}`);
  }

  async function cmdArtifactsList(args: AnyDict): Promise<void> {
    requireCommand("aws");
    const userId = args.user_id || getUserId(args.profile);
    const bucket = getArtifactsBucket(args.profile, args.region, args.stack_name);
    awsCmd(
      ["s3", "ls", `s3://${bucket}/${userId}/`, "--human-readable", "--recursive"],
      args.profile,
      args.region,
      false,
      true,
    );
  }

  return {
    cmdDockerPull,
    cmdDockerUpdate,
    cmdDevcontainerGenerate,
    cmdArtifactsUpload,
    cmdArtifactsDownload,
    cmdArtifactsList,
  };
}
