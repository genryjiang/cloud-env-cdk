# Devbox CLI

Generic CLI for cloud devbox lifecycle, SSH access helpers, artifact transfer, and Docker image pull/update.

## Install

```sh
npm install -g .
```

## Requirements

- Node.js 18+
- AWS CLI
- Docker (for `docker` subcommands)
- SSH + Session Manager plugin (for `cloud connect`)

## Quick Start

```sh
devbox cloud status
devbox cloud init
devbox cloud connect
```

## Commands

### Cloud lifecycle

```sh
devbox cloud provision [--user-id <id>] [--wait]
devbox cloud status [--user-id <id>]
devbox cloud start [--user-id <id>]
devbox cloud stop [--user-id <id>]
devbox cloud terminate [--user-id <id>]
devbox cloud connect [--user-id <id>] [--ssh-user <name>]
devbox cloud init [--user-id <id>] [--wsl]
```

### Debug

```sh
devbox debug --cloud-logs [--save] [--full]
devbox debug --docker-check
devbox debug --ssm
```

### Docker image helper

```sh
devbox docker pull [--repository <name>] --tag <tag> [--prune] [--start] [--gui]
devbox docker pull --list-repos
devbox docker update [--repository <name>] --tag <tag> [--prune] [--start] [--gui]
```

### Devcontainer

```sh
devbox devcontainer generate --project-dir /path/to/repo
```

`devcontainer generate` is currently a TODO stub and does not create `.devcontainer/` or `.vscode/` files.

### Artifacts

```sh
devbox artifacts upload <file>
devbox artifacts download <filename>
devbox artifacts list
```

## Environment Variables

- `DEVBOX_ALLOW_CLOUD_CONTROL_ON_CLOUD` (`1` to allow `devbox cloud ...` when running on a cloud instance)
- `DEVBOX_ASSUME_CLOUD_INSTANCE` (`1` or `0` override for cloud instance detection)
- `AWS_PROFILE`
- `AWS_REGION` / `AWS_DEFAULT_REGION`
