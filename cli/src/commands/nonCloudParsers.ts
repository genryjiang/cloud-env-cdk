// @ts-nocheck

export const DOCKER_IMAGE_TAG_CHOICES = ["amd64-latest", "mvp-latest"];

export const DOCKER_IMAGE_COMMAND_COMPLETION_OPTIONS = [
  { name: "--repository", takesValue: true },
  { name: "--tag", takesValue: true, valueChoices: DOCKER_IMAGE_TAG_CHOICES },
  { name: "--prune", takesValue: false },
  { name: "--start", takesValue: false },
  { name: "--gui", takesValue: false },
  { name: "--container-name", takesValue: true },
  { name: "--list-repos", takesValue: false },
];

const DOCKER_IMAGE_COMMAND_OPTION_SPECS = {
  repository: { type: "string" },
  tag: { type: "string" },
  prune: { type: "boolean", default: false },
  start: { type: "boolean", default: false },
  gui: { type: "boolean", default: false },
  container_name: { type: "string" },
  list_repos: { type: "boolean", default: false },
};

export function createNonCloudParsers(deps: Record<string, any>) {
  const {
    parseOptions,
    RuntimeError,
    cmdDockerPull,
    cmdDockerUpdate,
    cmdDevcontainerGenerate,
    cmdArtifactsUpload,
    cmdArtifactsDownload,
    cmdArtifactsList,
  } = deps;

  function hasHelpFlag(tokens: string[]): boolean {
    return tokens.includes("--help") || tokens.includes("-h");
  }

  function hasLongOption(tokens: string[], optionName: string): boolean {
    const prefix = `--${optionName}`;
    for (const token of tokens) {
      if (token === "--") {
        break;
      }
      if (token === prefix || token.startsWith(`${prefix}=`)) {
        return true;
      }
    }
    return false;
  }

  function parseDockerImageCommandOptions(tokens: string[], subcommand: "pull" | "update"): AnyDict {
    const { values } = parseOptions(tokens, DOCKER_IMAGE_COMMAND_OPTION_SPECS);
    const tagProvided = hasLongOption(tokens, "tag");
    const tag = typeof values.tag === "string" ? values.tag.trim() : "";

    if (tagProvided && !tag) {
      throw new RuntimeError("Option requires a non-empty value: --tag");
    }

    if (values.list_repos) {
      if (tag) {
        values.tag = tag;
      }
      return values;
    }

    if (subcommand === "update" && !tagProvided) {
      throw new RuntimeError(
        "devbox docker update now requires --tag (for example: --tag amd64-latest or --tag mvp-latest)",
      );
    }

    values.tag = tag || "amd64-latest";
    return values;
  }

  function parseDocker(tokens: string[], args: AnyDict): void {
    if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h") {
      args.help_topic = "docker";
      return;
    }

    const sub = tokens[0];
    args.docker_command = sub;
    const rest = tokens.slice(1);

    if (sub === "pull" || sub === "update") {
      if (hasHelpFlag(rest)) {
        args.help_topic = sub === "pull" ? "docker.pull" : "docker.update";
        return;
      }
      const values = parseDockerImageCommandOptions(rest, sub);
      Object.assign(args, values);
      args.func = (sub === "pull" ? cmdDockerPull : cmdDockerUpdate) as CommandFunc;
      return;
    }

    throw new RuntimeError(`Unknown docker command: ${sub}`);
  }

  function parseDevcontainer(tokens: string[], args: AnyDict): void {
    if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h") {
      args.help_topic = "devcontainer";
      return;
    }

    const sub = tokens[0];
    args.devcontainer_command = sub;
    const rest = tokens.slice(1);

    if (sub === "generate") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "devcontainer.generate";
        return;
      }
      const { values } = parseOptions(rest, {
        project_dir: { type: "string", default: "." },
      });
      Object.assign(args, values);
      args.func = cmdDevcontainerGenerate as CommandFunc;
      return;
    }

    throw new RuntimeError(`Unknown devcontainer command: ${sub}`);
  }

  function parseArtifacts(tokens: string[], args: AnyDict): void {
    if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h") {
      args.help_topic = "artifacts";
      return;
    }

    const sub = tokens[0];
    args.artifacts_command = sub;
    const rest = tokens.slice(1);

    if (sub === "upload") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "artifacts.upload";
        return;
      }
      const { values } = parseOptions(rest, { user_id: { type: "string" } }, ["file"], false);
      Object.assign(args, values);
      if (!args.file) {
        throw new RuntimeError("Missing required argument: file");
      }
      args.func = cmdArtifactsUpload as CommandFunc;
      return;
    }

    if (sub === "download") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "artifacts.download";
        return;
      }
      const { values } = parseOptions(rest, { user_id: { type: "string" } }, ["filename"], false);
      Object.assign(args, values);
      args.func = cmdArtifactsDownload as CommandFunc;
      return;
    }

    if (sub === "list") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "artifacts.list";
        return;
      }
      const { values } = parseOptions(rest, { user_id: { type: "string" } });
      Object.assign(args, values);
      args.func = cmdArtifactsList as CommandFunc;
      return;
    }

    throw new RuntimeError(`Unknown artifacts command: ${sub}`);
  }

  return {
    parseDocker,
    parseDevcontainer,
    parseArtifacts,
  };
}
