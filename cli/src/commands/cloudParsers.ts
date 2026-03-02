// @ts-nocheck

export function createCloudParsers(deps: Record<string, any>) {
  const {
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
  } = deps;

  function hasHelpFlag(tokens: string[]): boolean {
    return tokens.includes("--help") || tokens.includes("-h");
  }

  function parseCloud(tokens: string[], args: AnyDict): void {
    if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h") {
      args.help_topic = "cloud";
      return;
    }

    const sub = tokens[0];
    args.cloud_command = sub;
    const rest = tokens.slice(1);

    if (sub === "provision") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "cloud.provision";
        return;
      }
      const { values } = parseOptions(rest, {
        user_id: { type: "string" },
        wait: { type: "boolean", default: false },
        security_group_id: { type: "string" },
        security_group_ids: { type: "string" },
        subnet_id: { type: "string" },
      });
      Object.assign(args, values);
      args.func = cmdDevboxProvision as CommandFunc;
      return;
    }

    if (sub === "status") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "cloud.status";
        return;
      }
      const { values } = parseOptions(rest, { user_id: { type: "string" } });
      Object.assign(args, values);
      args.func = cmdDevboxStatus as CommandFunc;
      return;
    }

    if (sub === "start") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "cloud.start";
        return;
      }
      const { values } = parseOptions(rest, { user_id: { type: "string" } });
      Object.assign(args, values);
      args.func = cmdDevboxStart as CommandFunc;
      return;
    }

    if (sub === "stop") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "cloud.stop";
        return;
      }
      const { values } = parseOptions(rest, { user_id: { type: "string" } });
      Object.assign(args, values);
      args.func = cmdDevboxStop as CommandFunc;
      return;
    }

    if (sub === "terminate") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "cloud.terminate";
        return;
      }
      const { values } = parseOptions(rest, { user_id: { type: "string" } });
      Object.assign(args, values);
      args.func = cmdDevboxTerminate as CommandFunc;
      return;
    }

    if (sub === "connect") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "cloud.connect";
        return;
      }
      const { values } = parseOptions(rest, {
        user_id: { type: "string" },
        ssh_user: { type: "string", default: "ec2-user" },
      });
      Object.assign(args, values);
      args.func = cmdDevboxSsh as CommandFunc;
      return;
    }

    if (sub === "init") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "cloud.init";
        return;
      }
      const { values } = parseOptions(rest, {
        user_id: { type: "string" },
        ssh_user: { type: "string", default: "ec2-user" },
        config_path: { type: "string" },
        wsl: { type: "boolean", default: false },
        wsl_distro: { type: "string" },
        windows_user: { type: "string" },
        dry_run: { type: "boolean", default: false },
      });
      Object.assign(args, values);
      args.func = cmdDevboxSshConfig as CommandFunc;
      return;
    }

    if (sub === "unsafe-copy-git-key") {
      if (hasHelpFlag(rest)) {
        args.help_topic = "cloud.unsafe-copy-git-key";
        return;
      }
      const { values } = parseOptions(rest, {
        user_id: { type: "string" },
        ssh_user: { type: "string", default: "ec2-user" },
        key_path: { type: "string", default: "~/.ssh/id_ed25519" },
        remote_path: { type: "string" },
      });
      Object.assign(args, values);
      args.func = cmdDevboxUnsafeCopyGitKey as CommandFunc;
      return;
    }

    throw new RuntimeError(`Unknown cloud command: ${sub}`);
  }

  function parseDebug(tokens: string[], args: AnyDict): void {
    if (hasHelpFlag(tokens)) {
      args.help_topic = "debug";
      return;
    }
    const { values } = parseOptions(tokens, {
      user_id: { type: "string" },
      cloud_logs: { type: "boolean", default: false },
      docker_check: { type: "boolean", default: false },
      ssm: { type: "boolean", default: false },
      save: { type: "boolean", default: false },
      log_dir: { type: "string" },
      full: { type: "boolean", default: false },
    });
    Object.assign(args, values);
    args.func = cmdDebug as CommandFunc;
  }

  return { parseCloud, parseDebug };
}
