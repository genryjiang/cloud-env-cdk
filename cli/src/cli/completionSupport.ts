// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DOCKER_IMAGE_COMMAND_COMPLETION_OPTIONS } from "../commands/nonCloudParsers.js";

export function createCompletionSupport(deps: Record<string, any>) {
  const {
    CLI_NAME,
    CACHE_NAMESPACE,
    INTERNAL_COMPLETION_INSTALL_ENV,
    RuntimeError,
    splitLines,
    getShellRcPath,
    upsertShellBlock,
  } = deps;

  interface OptionSpec {
    type: "string" | "boolean";
    default?: any;
  }
  
  interface CompletionOptionSpec {
    name: string;
    takesValue: boolean;
    valueChoices?: string[];
  }
  
  interface CompletionNode {
    options?: CompletionOptionSpec[];
    subcommands?: Record<string, CompletionNode>;
    positionalChoices?: string[];
  }
  
  const GLOBAL_COMPLETION_OPTIONS: CompletionOptionSpec[] = [
    { name: "--profile", takesValue: true },
    { name: "--region", takesValue: true },
    { name: "--stack-name", takesValue: true },
    { name: "--help", takesValue: false },
  ];
  
  const COMPLETION_TREE: CompletionNode = {
    subcommands: {
      cloud: {
        subcommands: {
          provision: {
            options: [
              { name: "--user-id", takesValue: true },
              { name: "--wait", takesValue: false },
              { name: "--security-group-id", takesValue: true },
              { name: "--security-group-ids", takesValue: true },
              { name: "--subnet-id", takesValue: true },
            ],
          },
          status: { options: [{ name: "--user-id", takesValue: true }] },
          start: { options: [{ name: "--user-id", takesValue: true }] },
          stop: { options: [{ name: "--user-id", takesValue: true }] },
          terminate: { options: [{ name: "--user-id", takesValue: true }] },
          connect: {
            options: [
              { name: "--user-id", takesValue: true },
              { name: "--ssh-user", takesValue: true },
            ],
          },
          init: {
            options: [
              { name: "--user-id", takesValue: true },
              { name: "--ssh-user", takesValue: true },
              { name: "--config-path", takesValue: true },
              { name: "--wsl", takesValue: false },
              { name: "--wsl-distro", takesValue: true },
              { name: "--windows-user", takesValue: true },
              { name: "--dry-run", takesValue: false },
            ],
          },
          "unsafe-copy-git-key": {
            options: [
              { name: "--user-id", takesValue: true },
              { name: "--ssh-user", takesValue: true },
              { name: "--key-path", takesValue: true },
              { name: "--remote-path", takesValue: true },
            ],
          },
        },
      },
      debug: {
        options: [
          { name: "--user-id", takesValue: true },
          { name: "--cloud-logs", takesValue: false },
          { name: "--docker-check", takesValue: false },
          { name: "--ssm", takesValue: false },
          { name: "--save", takesValue: false },
          { name: "--log-dir", takesValue: true },
          { name: "--full", takesValue: false },
        ],
      },
      docker: {
        subcommands: {
          pull: {
            options: DOCKER_IMAGE_COMMAND_COMPLETION_OPTIONS,
          },
          update: {
            options: DOCKER_IMAGE_COMMAND_COMPLETION_OPTIONS,
          },
        },
      },
      devcontainer: {
        subcommands: {
          generate: {
            options: [
              { name: "--project-dir", takesValue: true },
            ],
          },
        },
      },
      artifacts: {
        subcommands: {
          upload: { options: [{ name: "--user-id", takesValue: true }] },
          download: { options: [{ name: "--user-id", takesValue: true }] },
          list: { options: [{ name: "--user-id", takesValue: true }] },
        },
      },
    },
  };
  
  function optionLookup(options: CompletionOptionSpec[] | undefined): Record<string, CompletionOptionSpec> {
    const lookup: Record<string, CompletionOptionSpec> = {};
    for (const option of options ?? []) {
      lookup[option.name] = option;
    }
    return lookup;
  }
  
  function completeArgs(tokens: string[]): string[] {
    const current = tokens.length > 0 ? tokens[tokens.length - 1] : "";
    const committed = tokens.length > 0 ? tokens.slice(0, -1) : [];
  
    let node: CompletionNode = COMPLETION_TREE;
    let atRoot = true;
    let expectValue: CompletionOptionSpec | undefined;
  
    for (let i = 0; i < committed.length; i += 1) {
      const token = committed[i];
  
      if (expectValue) {
        expectValue = undefined;
        continue;
      }
  
      if (token.startsWith("--")) {
        const rawName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
        const lookup = atRoot
          ? optionLookup(GLOBAL_COMPLETION_OPTIONS)
          : optionLookup(node.options);
        const option = lookup[rawName];
        if (!option) {
          return [];
        }
        if (option.takesValue && !token.includes("=")) {
          expectValue = option;
        }
        continue;
      }
  
      const subcommands = node.subcommands ?? {};
      const nextNode = subcommands[token];
      if (nextNode) {
        node = nextNode;
        atRoot = false;
        continue;
      }
  
      // Positional argument consumed; keep current node.
    }
  
    if (expectValue) {
      const choices = expectValue.valueChoices ?? [];
      return choices.filter((choice) => choice.startsWith(current));
    }
  
    const candidates = new Set<string>();
    if (atRoot) {
      for (const option of GLOBAL_COMPLETION_OPTIONS) {
        candidates.add(option.name);
      }
    } else {
      for (const option of node.options ?? []) {
        candidates.add(option.name);
      }
    }
  
    for (const subcommand of Object.keys(node.subcommands ?? {})) {
      candidates.add(subcommand);
    }
    for (const choice of node.positionalChoices ?? []) {
      candidates.add(choice);
    }
  
    const prefix = current ?? "";
    const filtered = [...candidates].filter((candidate) => candidate.startsWith(prefix));
    filtered.sort();
    return filtered;
  }
  
  function normalizeCompletionShell(shell: string | undefined): string | undefined {
    if (!shell) {
      return undefined;
    }
    const normalized = shell.trim().toLowerCase();
    if (normalized === "bash" || normalized === "zsh" || normalized === "fish") {
      return normalized;
    }
    return undefined;
  }

  function detectCompletionShell(): string | undefined {
    const envShell = normalizeCompletionShell(path.basename(String(process.env.SHELL ?? "")));
    if (envShell) {
      return envShell;
    }
    return undefined;
  }

  function getCompletionRcPath(shell: string): string {
    const home = os.homedir();
    if (shell === "bash") {
      return path.join(home, ".bashrc");
    }
    if (shell === "zsh") {
      return path.join(home, ".zshrc");
    }
    if (shell === "fish") {
      return path.join(home, ".config", "fish", "config.fish");
    }
    throw new RuntimeError(`Unsupported shell: ${shell}`);
  }

  function getCompletionScript(shell: string): string {
    if (shell === "bash") {
      return [
        "_devbox_completion() {",
        "  local words=()",
        "  local i",
        "  for ((i=1; i<${#COMP_WORDS[@]}; i++)); do",
        '    words+=("${COMP_WORDS[i]}")',
        "  done",
        "  if [[ ${COMP_CWORD} -ge ${#COMP_WORDS[@]} ]]; then",
        '    words+=("")',
        "  fi",
        "  local IFS=$'\\n'",
        '  COMPREPLY=($(devbox __complete "${words[@]}"))',
        "}",
        "complete -o nosort -o default -F _devbox_completion devbox",
      ].join("\n");
    }

    if (shell === "zsh") {
      return [
        "#compdef devbox",
        "_devbox_completion() {",
        "  local -a args completions",
        '  args=("${words[@]:2}")',
        '  completions=("${(@f)$(devbox __complete "${args[@]}")}")',
        "  _describe 'values' completions",
        "}",
        "compdef _devbox_completion devbox",
      ].join("\n");
    }

    if (shell === "fish") {
      return "complete -c devbox -f -a '(devbox __complete (commandline -opc)[2..-1] (commandline -ct))'";
    }

    throw new RuntimeError(`Unsupported shell: ${shell}`);
  }

  function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function upsertManagedBlock(filePath: string, startMarker: string, endMarker: string, body: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const block = `${startMarker}\n${body}\n${endMarker}`;
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    let next: string;

    if (existing.includes(startMarker) && existing.includes(endMarker)) {
      const pattern = new RegExp(`${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}`, "m");
      next = existing.replace(pattern, block);
    } else if (existing.trim().length === 0) {
      next = `${block}\n`;
    } else {
      next = `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
    }

    fs.writeFileSync(filePath, next);
  }

  async function cmdCompleteInternal(args: AnyDict): Promise<void> {
    const tokens = Array.isArray(args.complete_tokens) ? (args.complete_tokens as string[]) : [];
    const suggestions = completeArgs(tokens);
    if (suggestions.length > 0) {
      console.log(suggestions.join("\n"));
    }
  }
  
  async function cmdCompletionInstall(args: AnyDict): Promise<void> {
    const shell = normalizeCompletionShell(args.shell) ?? detectCompletionShell();
    if (!shell) {
      throw new RuntimeError("Unable to detect shell. Use --shell bash|zsh|fish.");
    }

    const rcPath = getCompletionRcPath(shell);
    const script = getCompletionScript(shell);
    upsertManagedBlock(rcPath, "# >>> devbox completion >>>", "# <<< devbox completion <<<", script);

    if (!args.quiet) {
      console.log(`Installed ${shell} completion in ${rcPath}`);
      console.log("Open a new shell or source your rc file.");
    }
  }
  
  function parseOptions(
    tokens: string[],
    specs: Record<string, OptionSpec>,
    positionalNames: string[] = [],
    allowExtraPositionals = false,
  ): { values: AnyDict; positionals: string[] } {
    const values: AnyDict = {};
  
    for (const [key, spec] of Object.entries(specs)) {
      if (spec.default !== undefined) {
        values[key] = spec.default;
      }
    }
  
    const positionals: string[] = [];
  
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") {
        positionals.push(...tokens.slice(i + 1));
        break;
      }
  
      if (token.startsWith("--")) {
        const equalsIdx = token.indexOf("=");
        const rawName = equalsIdx >= 0 ? token.slice(2, equalsIdx) : token.slice(2);
        const normalized = rawName.replace(/-/g, "_");
        const spec = specs[normalized];
  
        if (!spec) {
          throw new RuntimeError(`Unknown option: --${rawName}`);
        }
  
        if (spec.type === "boolean") {
          values[normalized] = true;
          i += 1;
          continue;
        }
  
        let value: string | undefined;
        if (equalsIdx >= 0) {
          value = token.slice(equalsIdx + 1);
        } else {
          if (i + 1 >= tokens.length) {
            throw new RuntimeError(`Option requires value: --${rawName}`);
          }
          if (tokens[i + 1].startsWith("--")) {
            throw new RuntimeError(`Option requires value: --${rawName}`);
          }
          value = tokens[i + 1];
          i += 1;
        }
  
        values[normalized] = value;
        i += 1;
        continue;
      }
  
      positionals.push(token);
      i += 1;
    }
  
    for (let j = 0; j < positionalNames.length; j += 1) {
      values[positionalNames[j]] = positionals[j];
    }
  
    if (!allowExtraPositionals && positionals.length > positionalNames.length) {
      throw new RuntimeError(`Unexpected argument: ${positionals[positionalNames.length]}`);
    }
  
    return { values, positionals };
  }

  function parseInternalCompletionInstall(tokens: string[], args: AnyDict): void {
    if (process.env[INTERNAL_COMPLETION_INSTALL_ENV] !== "1") {
      throw new RuntimeError("Unknown command: __completion-install");
    }
    const { values } = parseOptions(tokens, {
      shell: { type: "string" },
      quiet: { type: "boolean", default: false },
    });
    Object.assign(args, values);
    args.func = cmdCompletionInstall as CommandFunc;
  }

  return {
    parseOptions,
    cmdCompleteInternal,
    cmdCompletionInstall,
    parseInternalCompletionInstall,
  };
}
