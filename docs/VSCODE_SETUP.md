# VS Code Remote-SSH Setup via SSM

This guide shows how to connect VS Code to your devbox using Remote-SSH over AWS SSM Session Manager (no inbound port 22 required).

## Prerequisites

1. **AWS CLI** configured with credentials
2. **Session Manager Plugin** installed:
   ```bash
   # macOS
   brew install --cask session-manager-plugin
   
   # Linux
   curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
   sudo dpkg -i session-manager-plugin.deb
   ```

3. **VS Code** with **Remote - SSH** extension installed

## Setup Steps

### 1. Add SSH Config

Run the CLI command to automatically add your devbox to `~/.ssh/config`:

```bash
./scripts/devbox-cli.sh ssh-config
```

Or manually add this to `~/.ssh/config`:

```
Host devbox-<your-user-id>
    HostName <instance-id>
    User ec2-user
    ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p' --region ap-southeast-2"
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
```

### 2. Add Your SSH Key to the Instance

Since the instance is in a private subnet, use SSM to inject your SSH key:

```bash
./scripts/devbox-cli.sh ssh
```

This will automatically:
- Find your SSH public key (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`)
- Inject it into the instance via SSM
- Connect via SSH over SSM

### 3. Connect from VS Code

1. Open VS Code
2. Press `F1` or `Cmd+Shift+P`
3. Type: **Remote-SSH: Connect to Host**
4. Select `devbox-<your-user-id>`
5. VS Code will connect via SSM tunnel (no inbound port 22 needed!)

### 4. Open Dev Container

Once connected to the devbox:

1. Open the workspace folder: `/home/ec2-user/workspace`
2. Clone your repo or open existing code
3. Press `F1` → **Dev Containers: Reopen in Container**
4. VS Code will use the Docker image pulled from ECR

## How It Works

```
VS Code → SSH Client → AWS CLI → SSM Service → SSM Agent → SSH Daemon (port 22 localhost only)
```

- **No inbound security group rules** needed
- **No public IP** needed
- **No bastion host** needed
- SSH traffic is tunneled through AWS SSM over HTTPS (port 443 outbound)

## Troubleshooting

### "Could not establish connection"

Check SSM connectivity:
```bash
aws ssm start-session --target <instance-id> --region ap-southeast-2
```

### "Permission denied (publickey)"

Add your SSH key:
```bash
./scripts/devbox-cli.sh ssh
```

### "Session Manager plugin not found"

Install the plugin (see Prerequisites above), then restart your terminal.

### Docker not working in Dev Container

Check Docker is running:
```bash
./scripts/devbox-cli.sh check
```

## Git Authentication

**Do NOT use `git config --global credential.helper store`** (stores plaintext credentials).

Instead, use one of these secure methods:

### Option 1: SSH Agent Forwarding (Recommended)

Add to your `~/.ssh/config`:
```
Host devbox-*
    ForwardAgent yes
```

Then use SSH URLs for git:
```bash
git clone git@github.com:your-org/your-repo.git
```

### Option 2: GitHub CLI

On the devbox:
```bash
# Install GitHub CLI
sudo yum install -y gh

# Authenticate via device flow
gh auth login
```

### Option 3: Personal Access Token (Temporary)

```bash
# Set for current session only
export GH_TOKEN=<your-token>
git clone https://$GH_TOKEN@github.com/your-org/your-repo.git
```

## IntelliSense and Dev Containers

VS Code IntelliSense works normally:
- Language servers run inside the dev container
- Extensions are installed in the container
- Full debugging support available

The dev container image from ECR should include all necessary tools and SDKs.
