# devbox

Generic CLI for devbox lifecycle and helpers.

## Install

Recommended (pipx):

```sh
pipx install .
```

Or from a git repo:

```sh
pipx install git+ssh://git@github.com/ORG/REPO.git
```

Run without install:

```sh
python3 -m apsis_sr --help
```

## Requirements

- Python 3.9+
- AWS CLI
- jq
- docker (for docker update)
- ssh (for devbox ssh)

## Quick Start

```sh
devbox status
devbox ssh-config
devbox connect
```

## Commands

### Devbox lifecycle

```sh
devbox provision [--user-id <id>] [--wait]
devbox status [--user-id <id>]
devbox start [--user-id <id>]
devbox stop [--user-id <id>]
devbox terminate [--user-id <id>]
devbox logs [--user-id <id>] [--save] [--full]
devbox check [--user-id <id>]
devbox connect [--user-id <id>]
```

### SSH helpers

SSH over SSM (automatically pushes public key):

```sh
devbox ssh
```

Add SSH config entry for VS Code Remote-SSH (automatically uses `devbox-{user_id}` as hostname):

```sh
devbox ssh-config
```

This writes a block like:

```
Host devbox-<your-id>
    HostName i-xxxxxxxxxxxxxxxxx
    User ec2-user
    ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region ap-southeast-2"
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
```

### Devcontainer stubs

Create stub files with TODO notes for `.devcontainer/` and `.vscode/`:

```sh
devbox devcontainer generate --project-dir /path/to/repo
```

### Docker image update

```sh
devbox docker update [--repository <name>] [--tag <tag>] [--prune]
devbox docker update --list-repos
```

### Artifacts

```sh
devbox artifacts upload <file>
devbox artifacts download <filename>
devbox artifacts list
```

## Notes

- Use `--profile` to target a named AWS CLI profile.
- If Git auth fails inside the devbox, you can temporarily copy a key for testing, but this is bad practice and not recommended.

## Environment Variables

- AWS_PROFILE (default profile if --profile not set)
- AWS_REGION / AWS_DEFAULT_REGION (default region)
- SSH_PUBKEY_PATH (custom public key for devbox ssh)
- SSH_KEY_PATH (private key path; uses <path>.pub)

## Exit Codes

- 0 success
- non-zero for AWS/SSM errors, missing dependencies, or bad input
