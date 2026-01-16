#!/usr/bin/env python3
"""Devbox CLI for cloud development workflows."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional


DEFAULT_REGION = "ap-southeast-2"
DEFAULT_STACK_NAME = "CloudDevEnvStack"


def run(cmd: list[str], capture_output: bool = True, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=capture_output, text=True, check=check)


def require_command(command: str) -> None:
    if shutil_which(command) is None:
        print(f"Error: required command not found: {command}")
        sys.exit(1)


def shutil_which(command: str) -> Optional[str]:
    try:
        import shutil

        return shutil.which(command)
    except Exception:
        return None


def aws_cmd(
    args: list[str],
    profile: Optional[str] = None,
    region: Optional[str] = None,
    capture_output: bool = True,
    check: bool = True,
) -> subprocess.CompletedProcess:
    cmd = ["aws"]
    if profile:
        cmd.extend(["--profile", profile])
    cmd.extend(args)
    if region and "--region" not in args:
        cmd.extend(["--region", region])
    return run(cmd, capture_output=capture_output, check=check)


def aws_json(
    args: list[str],
    profile: Optional[str] = None,
    region: Optional[str] = None,
) -> dict:
    if "--output" not in args:
        args = args + ["--output", "json"]
    result = aws_cmd(args, profile=profile, region=region)
    if not result.stdout:
        return {}
    return json.loads(result.stdout)


def resolve_region(arg_region: Optional[str], profile: Optional[str]) -> str:
    if arg_region:
        return arg_region
    env_region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if env_region:
        return env_region
    try:
        result = aws_cmd(["configure", "get", "region"], profile=profile, region=None)
        region = result.stdout.strip()
        if region:
            return region
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return DEFAULT_REGION


def get_user_id(profile: Optional[str]) -> str:
    try:
        data = aws_json(["sts", "get-caller-identity"], profile=profile, region=None)
        arn = data.get("Arn", "")
        if arn:
            return arn.split("/")[-1]
    except subprocess.CalledProcessError:
        pass
    return os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"


def get_stack_outputs(profile: Optional[str], region: str, stack_name: str) -> list[dict]:
    data = aws_json(
        ["cloudformation", "describe-stacks", "--stack-name", stack_name],
        profile=profile,
        region=region,
    )
    stacks = data.get("Stacks", [])
    if not stacks:
        raise RuntimeError(f"Stack not found: {stack_name}")
    return stacks[0].get("Outputs", [])


def get_output_value(outputs: Iterable[dict], key: Optional[str] = None, contains: Optional[str] = None) -> str:
    for output in outputs:
        output_key = output.get("OutputKey", "")
        if key and output_key == key:
            return output.get("OutputValue", "")
        if contains and contains in output_key:
            return output.get("OutputValue", "")
    return ""


def get_api_url(profile: Optional[str], region: str, stack_name: str) -> str:
    outputs = get_stack_outputs(profile, region, stack_name)
    api_url = get_output_value(outputs, contains="DevboxApiUrl")
    if not api_url:
        raise RuntimeError("Devbox API URL not found in stack outputs")
    return api_url


def call_devbox_api(api_url: str, action: str, user_id: str) -> dict:
    url = api_url.rstrip("/") + "/devbox"
    payload = json.dumps({"action": action, "userId": user_id}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        raise RuntimeError(f"Devbox API error ({exc.code}): {raw}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Devbox API request failed: {exc.reason}") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}


def get_devbox_status(profile: Optional[str], region: str, stack_name: str, user_id: str) -> dict:
    api_url = get_api_url(profile, region, stack_name)
    return call_devbox_api(api_url, "status", user_id)


def ensure_instance_running(status: dict, user_id: str) -> str:
    instance_id = status.get("instanceId")
    state = status.get("status")
    if not instance_id or instance_id == "null":
        print("No devbox found. Provision one first:")
        print("  devbox provision")
        sys.exit(1)
    if state != "running":
        print(f"Devbox is {state}, not running")
        sys.exit(1)
    return instance_id


def find_ssh_public_key() -> Optional[Path]:
    path = os.environ.get("SSH_PUBKEY_PATH")
    if path and Path(path).is_file():
        return Path(path)

    key_path = os.environ.get("SSH_KEY_PATH")
    if key_path and Path(f"{key_path}.pub").is_file():
        return Path(f"{key_path}.pub")

    ed25519 = Path.home() / ".ssh" / "id_ed25519.pub"
    if ed25519.is_file():
        return ed25519

    rsa = Path.home() / ".ssh" / "id_rsa.pub"
    if rsa.is_file():
        return rsa

    return None


def send_ssm_commands(
    instance_id: str,
    commands: list[str],
    profile: Optional[str],
    region: str,
) -> str:
    params = "commands=" + json.dumps(commands)
    result = aws_cmd(
        [
            "ssm",
            "send-command",
            "--instance-ids",
            instance_id,
            "--document-name",
            "AWS-RunShellScript",
            "--parameters",
            params,
            "--query",
            "Command.CommandId",
            "--output",
            "text",
        ],
        profile=profile,
        region=region,
    )
    return result.stdout.strip()


def get_ssm_output(command_id: str, instance_id: str, profile: Optional[str], region: str) -> str:
    result = aws_cmd(
        [
            "ssm",
            "get-command-invocation",
            "--command-id",
            command_id,
            "--instance-id",
            instance_id,
            "--query",
            "StandardOutputContent",
            "--output",
            "text",
        ],
        profile=profile,
        region=region,
    )
    return result.stdout


def format_proxy_command(region: str, profile: Optional[str]) -> str:
    base = ["aws"]
    if profile:
        base.extend(["--profile", profile])
    base.extend(
        [
            "ssm",
            "start-session",
            "--target",
            "%h",
            "--document-name",
            "AWS-StartSSHSession",
            "--parameters",
            "'portNumber=%p'",
            "--region",
            region,
        ]
    )
    return " ".join(base)


def build_ssh_config_entry(host: str, instance_id: str, ssh_user: str, region: str, profile: Optional[str]) -> str:
    proxy_command = format_proxy_command(region, profile)
    entry = [
        f"Host {host}",
        f"    HostName {instance_id}",
        f"    User {ssh_user}",
        f"    ProxyCommand sh -c \"{proxy_command}\"",
        "    StrictHostKeyChecking no",
        "    UserKnownHostsFile /dev/null",
        "",
    ]
    return "\n".join(entry)


def find_host_block(lines: list[str], host: str) -> Optional[tuple[int, int]]:
    start = None
    for idx, line in enumerate(lines):
        if line.strip().startswith("Host "):
            if line.strip() == f"Host {host}":
                start = idx
                continue
            if start is not None:
                return start, idx
    if start is not None:
        return start, len(lines)
    return None


def update_ssh_config(
    host: str,
    entry: str,
    config_path: Path,
    overwrite: bool,
    dry_run: bool,
) -> None:
    if dry_run:
        print(entry)
        return

    config_path.parent.mkdir(parents=True, exist_ok=True)
    if config_path.exists():
        lines = config_path.read_text().splitlines()
    else:
        lines = []

    block = find_host_block(lines, host)
    if block and not overwrite:
        print(f"SSH config entry already exists for {host}")
        confirm = input("Overwrite existing entry? (yes/no): ").strip().lower()
        if confirm != "yes":
            print("Cancelled.")
            return
    if block:
        start, end = block
        new_lines = lines[:start] + entry.splitlines() + lines[end:]
    else:
        new_lines = lines + entry.splitlines()

    config_path.write_text("\n".join(new_lines) + "\n")
    try:
        os.chmod(config_path, 0o600)
    except PermissionError:
        pass

    print(f"Updated SSH config: {config_path}")


def confirm_prompt(prompt: str) -> bool:
    response = input(prompt).strip().lower()
    return response == "yes"


def get_artifacts_bucket(profile: Optional[str], region: str, stack_name: str) -> str:
    outputs = get_stack_outputs(profile, region, stack_name)
    bucket = get_output_value(outputs, key="ArtifactsBucket")
    if not bucket:
        raise RuntimeError("Artifacts bucket not found in stack outputs")
    return bucket


def get_user_table(profile: Optional[str], region: str, stack_name: str) -> str:
    outputs = get_stack_outputs(profile, region, stack_name)
    table = get_output_value(outputs, key="UserTable")
    if not table:
        raise RuntimeError("User table not found in stack outputs")
    return table


def get_instance_id_from_table(profile: Optional[str], region: str, stack_name: str, user_id: str) -> str:
    table = get_user_table(profile, region, stack_name)
    result = aws_cmd(
        [
            "dynamodb",
            "get-item",
            "--table-name",
            table,
            "--key",
            json.dumps({"userId": {"S": user_id}}),
            "--query",
            "Item.instanceId.S",
            "--output",
            "text",
        ],
        profile=profile,
        region=region,
    )
    instance_id = result.stdout.strip()
    if not instance_id or instance_id == "None":
        raise RuntimeError(f"No devbox found for {user_id}")
    return instance_id


def get_instance_state(profile: Optional[str], region: str, instance_id: str) -> str:
    result = aws_cmd(
        [
            "ec2",
            "describe-instances",
            "--instance-ids",
            instance_id,
            "--query",
            "Reservations[0].Instances[0].State.Name",
            "--output",
            "text",
        ],
        profile=profile,
        region=region,
    )
    return result.stdout.strip()


def cmd_devbox_provision(args: argparse.Namespace) -> None:
    user_id = args.user_id or get_user_id(args.profile)
    api_url = get_api_url(args.profile, args.region, args.stack_name)
    response = call_devbox_api(api_url, "provision", user_id)
    print(json.dumps(response, indent=2))
    status = response.get("status")
    if args.wait and status == "pending":
        print("Waiting for instance to be ready (about 2 minutes)...")
        try:
            time_sleep(120)
        except KeyboardInterrupt:
            print("Cancelled.")
            return
        print("Devbox should be ready. Check status with: devbox status")


def cmd_devbox_status(args: argparse.Namespace) -> None:
    user_id = args.user_id or get_user_id(args.profile)
    status = get_devbox_status(args.profile, args.region, args.stack_name, user_id)
    print(json.dumps(status, indent=2))


def cmd_devbox_stop(args: argparse.Namespace) -> None:
    user_id = args.user_id or get_user_id(args.profile)
    api_url = get_api_url(args.profile, args.region, args.stack_name)
    response = call_devbox_api(api_url, "stop", user_id)
    print(json.dumps(response, indent=2))


def cmd_devbox_start(args: argparse.Namespace) -> None:
    user_id = args.user_id or get_user_id(args.profile)
    status = get_devbox_status(args.profile, args.region, args.stack_name, user_id)
    instance_id = status.get("instanceId")
    if not instance_id or instance_id == "null":
        raise RuntimeError(f"No devbox found for {user_id}")
    state = status.get("status")
    if state == "running":
        print("Devbox is already running")
        return
    print(f"Starting devbox {instance_id}...")
    aws_cmd(["ec2", "start-instances", "--instance-ids", instance_id], profile=args.profile, region=args.region)
    print("Devbox starting. Wait 1-2 minutes before connecting.")


def cmd_devbox_terminate(args: argparse.Namespace) -> None:
    if not confirm_prompt("This will DELETE the devbox and all data. Continue? (yes/no): "):
        print("Cancelled.")
        return
    user_id = args.user_id or get_user_id(args.profile)
    api_url = get_api_url(args.profile, args.region, args.stack_name)
    response = call_devbox_api(api_url, "terminate", user_id)
    print(json.dumps(response, indent=2))


def cmd_devbox_logs(args: argparse.Namespace) -> None:
    user_id = args.user_id or get_user_id(args.profile)
    instance_id = get_instance_id_from_table(args.profile, args.region, args.stack_name, user_id)
    state = get_instance_state(args.profile, args.region, instance_id)

    log_lines = []
    log_lines.append("=== Devbox Log Check ===")
    log_lines.append(f"User: {user_id}")
    log_lines.append(f"Time: {datetime.now().isoformat(timespec='seconds')}")
    log_lines.append("")
    log_lines.append(f"Instance: {instance_id}")
    log_lines.append(f"Status: {state}")
    log_lines.append("")
    log_lines.append("=== Console Output (last 100 lines) ===")

    console_result = aws_cmd(
        ["ec2", "get-console-output", "--instance-id", instance_id, "--output", "text"],
        profile=args.profile,
        region=args.region,
    )
    console_lines = console_result.stdout.splitlines()[-100:]
    log_lines.extend(console_lines)
    log_lines.append("")

    if state == "running" and args.full:
        log_lines.append("=== Docker Images ===")
        cmd_id = send_ssm_commands(
            instance_id,
            ["docker images"],
            profile=args.profile,
            region=args.region,
        )
        time_sleep(3)
        log_lines.append(get_ssm_output(cmd_id, instance_id, args.profile, args.region).strip())
        log_lines.append("")

        log_lines.append("=== Cloud-Init Output Log ===")
        cmd_id = send_ssm_commands(
            instance_id,
            ["cat /var/log/cloud-init-output.log | tail -100"],
            profile=args.profile,
            region=args.region,
        )
        time_sleep(3)
        log_lines.append(get_ssm_output(cmd_id, instance_id, args.profile, args.region).strip())
        log_lines.append("")

        log_lines.append("=== User Data Log ===")
        cmd_id = send_ssm_commands(
            instance_id,
            ["cat /var/log/user-data.log 2>/dev/null || echo No user-data.log found"],
            profile=args.profile,
            region=args.region,
        )
        time_sleep(3)
        log_lines.append(get_ssm_output(cmd_id, instance_id, args.profile, args.region).strip())
        log_lines.append("")

    output = "\n".join(log_lines)
    print(output)

    if args.save:
        log_dir = Path(args.log_dir) if args.log_dir else None
        if log_dir is None:
            if Path("scripts/logs").is_dir():
                log_dir = Path("scripts/logs")
            else:
                log_dir = Path("logs")
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"devbox-{user_id}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
        log_file.write_text(output + "\n")
        print(f"Log saved to: {log_file}")


def cmd_devbox_check(args: argparse.Namespace) -> None:
    user_id = args.user_id or get_user_id(args.profile)
    status = get_devbox_status(args.profile, args.region, args.stack_name, user_id)
    instance_id = ensure_instance_running(status, user_id)

    commands = [
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
    ]
    cmd_id = send_ssm_commands(instance_id, commands, profile=args.profile, region=args.region)
    print("Waiting for command to complete...")
    time_sleep(3)
    output = get_ssm_output(cmd_id, instance_id, args.profile, args.region)
    print(output)


def cmd_devbox_connect(args: argparse.Namespace) -> None:
    user_id = args.user_id or get_user_id(args.profile)
    print(f"Looking up devbox for {user_id}...")
    status = get_devbox_status(args.profile, args.region, args.stack_name, user_id)
    instance_id = ensure_instance_running(status, user_id)
    print(f"Found instance: {instance_id}")
    print("Connecting via SSM...")
    print("")
    aws_cmd(["ssm", "start-session", "--target", instance_id], profile=args.profile, region=args.region, capture_output=False)


def cmd_devbox_ssh(args: argparse.Namespace) -> None:
    require_command("ssh")
    user_id = args.user_id or get_user_id(args.profile)
    print(f"Looking up devbox for {user_id}...")
    status = get_devbox_status(args.profile, args.region, args.stack_name, user_id)
    instance_id = ensure_instance_running(status, user_id)

    pubkey_path = find_ssh_public_key()
    if not pubkey_path:
        print("No SSH public key found. Generate one with:")
        print("  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519")
        sys.exit(1)

    private_key = Path(str(pubkey_path).replace(".pub", ""))
    if not private_key.is_file():
        print(f"Private key not found for {pubkey_path}")
        sys.exit(1)

    print(f"Found instance: {instance_id}")
    print("Adding SSH key via SSM (EC2 Instance Connect not available in private subnet)...")
    
    pub_key = pubkey_path.read_text().strip()
    commands = [
        f"mkdir -p /home/{args.ssh_user}/.ssh",
        f"echo '{pub_key}' >> /home/{args.ssh_user}/.ssh/authorized_keys",
        f"chmod 700 /home/{args.ssh_user}/.ssh",
        f"chmod 600 /home/{args.ssh_user}/.ssh/authorized_keys",
        f"chown -R {args.ssh_user}:{args.ssh_user} /home/{args.ssh_user}/.ssh",
        f"sort -u /home/{args.ssh_user}/.ssh/authorized_keys -o /home/{args.ssh_user}/.ssh/authorized_keys",
    ]
    send_ssm_commands(instance_id, commands, profile=args.profile, region=args.region)
    print("Waiting for key to be added...")
    time_sleep(2)

    print("Connecting via SSH over SSM...")
    proxy_command = format_proxy_command(args.region, args.profile)
    ssh_cmd = [
        "ssh",
        "-i",
        str(private_key),
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        f"ProxyCommand={proxy_command}",
        f"{args.ssh_user}@{instance_id}",
    ]
    subprocess.run(ssh_cmd, check=True)


def cmd_devbox_ssh_config(args: argparse.Namespace) -> None:
    user_id = args.user_id or get_user_id(args.profile)
    status = get_devbox_status(args.profile, args.region, args.stack_name, user_id)
    instance_id = status.get("instanceId")
    if not instance_id or instance_id == "null":
        raise RuntimeError(f"No devbox found for {user_id}")

    # Only one devbox per user: always use a stable host name and overwrite it.
    host = f"devbox-{user_id}"
    entry = build_ssh_config_entry(host, instance_id, args.ssh_user, args.region, args.profile)
    update_ssh_config(host, entry, Path(args.config_path).expanduser(), overwrite=True, dry_run=args.dry_run)


def list_ecr_repositories(region: str, profile: Optional[str]) -> list[dict]:
    data = aws_json(["ecr", "describe-repositories"], profile=profile, region=region)
    return data.get("repositories", [])


def get_latest_image_tag(repository_name: str, region: str, profile: Optional[str]) -> Optional[str]:
    try:
        result = aws_cmd(
            [
                "ecr",
                "describe-images",
                "--repository-name",
                repository_name,
                "--query",
                "sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]",
                "--output",
                "text",
            ],
            profile=profile,
            region=region,
        )
    except subprocess.CalledProcessError:
        return None
    tag = result.stdout.strip()
    if not tag or tag == "None":
        return None
    return tag


def find_repository(repositories: list[dict]) -> Optional[dict]:
    patterns = ["embd", "qnx", "embedded", "dev"]
    for repo in repositories:
        name = repo.get("repositoryName", "").lower()
        if any(pattern in name for pattern in patterns):
            return repo
    return repositories[0] if repositories else None


def ecr_login(registry: str, region: str, profile: Optional[str]) -> None:
    result = aws_cmd(
        ["ecr", "get-login-password"],
        profile=profile,
        region=region,
    )
    login = subprocess.run(
        ["docker", "login", "--username", "AWS", "--password-stdin", registry],
        input=result.stdout,
        text=True,
    )
    if login.returncode != 0:
        raise RuntimeError("Docker login failed")


def cmd_docker_update(args: argparse.Namespace) -> None:
    require_command("docker")
    require_command("aws")

    region = resolve_region(args.region, args.profile)
    repositories = list_ecr_repositories(region, args.profile)
    if not repositories:
        raise RuntimeError("No ECR repositories found in this account/region")

    if args.list_repos:
        print("Available ECR repositories:")
        for repo in repositories:
            name = repo.get("repositoryName", "")
            uri = repo.get("repositoryUri", "")
            latest_tag = get_latest_image_tag(name, region, args.profile)
            print(f"  - {name}")
            print(f"    URI: {uri}")
            print(f"    Latest tag: {latest_tag or 'N/A'}")
            print("")
        return

    if args.repository:
        target_repo = next((r for r in repositories if r.get("repositoryName") == args.repository), None)
        if not target_repo:
            raise RuntimeError(f"Repository not found: {args.repository}")
    else:
        target_repo = find_repository(repositories)
        if not target_repo:
            raise RuntimeError("Could not auto-detect repository")

    repo_uri = target_repo.get("repositoryUri", "")
    repo_name = target_repo.get("repositoryName", "")
    print(f"Using repository: {repo_name}")

    tag = args.tag
    if tag == "linux-amd64-latest":
        detected_tag = get_latest_image_tag(repo_name, region, args.profile)
        if detected_tag:
            print(f"Detected latest tag: {detected_tag}")

    image_uri = f"{repo_uri}:{tag}"
    print(f"Target image: {image_uri}")

    registry = repo_uri.split("/")[0]
    print(f"Logging into ECR: {registry}")
    ecr_login(registry, region, args.profile)

    print(f"Pulling image: {image_uri}")
    subprocess.run(["docker", "pull", image_uri], check=True)
    print("Image pulled successfully")

    if args.prune:
        print("Pruning stopped containers...")
        subprocess.run(["docker", "container", "prune", "-f"], check=True)
        print("Pruning dangling images...")
        subprocess.run(["docker", "image", "prune", "-f"], check=True)

    print("Docker image update complete")


DEVCONTAINER_STUB = """# TODO: Add your devcontainer config

This CLI does not generate devcontainer.json or VS Code settings.

If you want to use Dev Containers, create:
- .devcontainer/devcontainer.json
- .vscode/settings.json (optional)
- .vscode/tasks.json (optional)
- .vscode/launch.json (optional)
"""

VSCODE_STUB = """# TODO: Add VS Code config

Add settings.json, tasks.json, and launch.json as needed.
"""


def write_stub_file(path: Path, content: str, skip_if_parent_exists: bool = True) -> bool:
    if skip_if_parent_exists and path.parent.exists():
        return False
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return True


def cmd_devcontainer_generate(args: argparse.Namespace) -> None:
    project_dir = Path(args.project_dir).expanduser()
    if not project_dir.exists():
        raise RuntimeError(f"Project directory not found: {project_dir}")

    created = []
    devcontainer_stub = project_dir / ".devcontainer" / "README.md"
    vscode_stub = project_dir / ".vscode" / "README.md"

    if write_stub_file(devcontainer_stub, DEVCONTAINER_STUB, skip_if_parent_exists=True):
        created.append(devcontainer_stub)
    if write_stub_file(vscode_stub, VSCODE_STUB, skip_if_parent_exists=True):
        created.append(vscode_stub)

    if created:
        print("Stub files created:")
        for path in created:
            print(f"  - {path}")
    else:
        print("Stub files already exist or directories are present; no changes made.")


def cmd_artifacts_upload(args: argparse.Namespace) -> None:
    require_command("aws")
    file_path = Path(args.file).expanduser()
    if not file_path.is_file():
        raise RuntimeError(f"File not found: {file_path}")
    user_id = args.user_id or get_user_id(args.profile)
    bucket = get_artifacts_bucket(args.profile, args.region, args.stack_name)
    dest = f"s3://{bucket}/{user_id}/{file_path.name}"
    print(f"Uploading {file_path} to {dest}...")
    aws_cmd(["s3", "cp", str(file_path), dest], profile=args.profile, region=args.region)
    print(f"Uploaded to {dest}")


def cmd_artifacts_download(args: argparse.Namespace) -> None:
    require_command("aws")
    user_id = args.user_id or get_user_id(args.profile)
    bucket = get_artifacts_bucket(args.profile, args.region, args.stack_name)
    aws_cmd(["s3", "ls", f"s3://{bucket}/{user_id}/", "--human-readable"], profile=args.profile, region=args.region, capture_output=False)
    if not args.filename:
        print("To download: devbox artifacts download <filename>")
        return
    dest = Path(args.filename).name
    print(f"Downloading {args.filename}...")
    aws_cmd(["s3", "cp", f"s3://{bucket}/{user_id}/{args.filename}", f"./{dest}"], profile=args.profile, region=args.region)
    print(f"Downloaded to ./{dest}")


def cmd_artifacts_list(args: argparse.Namespace) -> None:
    require_command("aws")
    user_id = args.user_id or get_user_id(args.profile)
    bucket = get_artifacts_bucket(args.profile, args.region, args.stack_name)
    aws_cmd(
        ["s3", "ls", f"s3://{bucket}/{user_id}/", "--human-readable", "--recursive"],
        profile=args.profile,
        region=args.region,
        capture_output=False,
    )


def time_sleep(seconds: int) -> None:
    try:
        import time

        time.sleep(seconds)
    except KeyboardInterrupt:
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="devbox",
        description="CLI for devbox lifecycle and helpers",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """
            Examples:
              devbox status
              devbox ssh-config
              devbox docker update --prune
              devbox devcontainer generate --project-dir /path/to/repo
            """
        ),
    )
    parser.add_argument(
        "--profile",
        default=os.environ.get("AWS_PROFILE"),
        help="AWS profile to use",
    )
    parser.add_argument("--region", help=f"AWS region (default: {DEFAULT_REGION})")
    parser.add_argument("--stack-name", default=DEFAULT_STACK_NAME, help="CloudFormation stack name")

    subparsers = parser.add_subparsers(dest="command")

    def add_user_id_arg(p: argparse.ArgumentParser) -> None:
        p.add_argument("--user-id", help="Override the devbox user id")

    provision = subparsers.add_parser("provision", help="Provision a devbox")
    add_user_id_arg(provision)
    provision.add_argument("--wait", action="store_true", help="Wait briefly for provisioning")
    provision.set_defaults(func=cmd_devbox_provision)

    status = subparsers.add_parser("status", help="Show devbox status")
    add_user_id_arg(status)
    status.set_defaults(func=cmd_devbox_status)

    start = subparsers.add_parser("start", help="Start a stopped devbox")
    add_user_id_arg(start)
    start.set_defaults(func=cmd_devbox_start)

    stop = subparsers.add_parser("stop", help="Stop a devbox")
    add_user_id_arg(stop)
    stop.set_defaults(func=cmd_devbox_stop)

    terminate = subparsers.add_parser("terminate", help="Terminate a devbox")
    add_user_id_arg(terminate)
    terminate.set_defaults(func=cmd_devbox_terminate)

    logs = subparsers.add_parser("logs", help="Fetch devbox logs")
    add_user_id_arg(logs)
    logs.add_argument("--save", action="store_true", help="Save logs to a file")
    logs.add_argument("--log-dir", help="Directory to save logs")
    logs.add_argument("--full", action="store_true", help="Include SSM logs when running")
    logs.set_defaults(func=cmd_devbox_logs)

    check = subparsers.add_parser("check", help="Check docker status via SSM")
    add_user_id_arg(check)
    check.set_defaults(func=cmd_devbox_check)

    connect = subparsers.add_parser("connect", help="Connect to devbox via SSM")
    add_user_id_arg(connect)
    connect.set_defaults(func=cmd_devbox_connect)

    ssh = subparsers.add_parser("ssh", help="SSH over SSM (pushes public key)")
    add_user_id_arg(ssh)
    ssh.add_argument("--ssh-user", default="ec2-user", help="OS user for SSH")
    ssh.set_defaults(func=cmd_devbox_ssh)

    ssh_config = subparsers.add_parser("ssh-config", help="Add/update devbox SSH config entry")
    add_user_id_arg(ssh_config)
    ssh_config.add_argument("--ssh-user", default="ec2-user", help="OS user for SSH")
    ssh_config.add_argument("--config-path", default="~/.ssh/config", help="SSH config path")
    ssh_config.add_argument("--dry-run", action="store_true", help="Print entry without writing")
    ssh_config.set_defaults(func=cmd_devbox_ssh_config)

    docker = subparsers.add_parser("docker", help="Docker image helper")
    docker_sub = docker.add_subparsers(dest="docker_command")
    docker_update = docker_sub.add_parser("update", help="Pull latest ECR image")
    docker_update.add_argument("--repository", help="ECR repository name")
    docker_update.add_argument("--tag", default="linux-amd64-latest", help="Image tag")
    docker_update.add_argument("--prune", action="store_true", help="Prune old containers and images")
    docker_update.add_argument("--list-repos", action="store_true", help="List repositories and exit")
    docker_update.set_defaults(func=cmd_docker_update)

    devcontainer = subparsers.add_parser("devcontainer", help="Devcontainer stubs")
    devcontainer_sub = devcontainer.add_subparsers(dest="devcontainer_command")
    devcontainer_generate = devcontainer_sub.add_parser("generate", help="Create stub files for devcontainer/VS Code")
    devcontainer_generate.add_argument("--project-dir", default=".", help="Project directory")
    devcontainer_generate.set_defaults(func=cmd_devcontainer_generate)

    artifacts = subparsers.add_parser("artifacts", help="Artifact management")
    artifacts_sub = artifacts.add_subparsers(dest="artifacts_command")
    artifacts_upload = artifacts_sub.add_parser("upload", help="Upload artifact to S3")
    artifacts_upload.add_argument("file", help="File to upload")
    add_user_id_arg(artifacts_upload)
    artifacts_upload.set_defaults(func=cmd_artifacts_upload)

    artifacts_download = artifacts_sub.add_parser("download", help="Download artifact from S3")
    artifacts_download.add_argument("filename", nargs="?", help="File name to download")
    add_user_id_arg(artifacts_download)
    artifacts_download.set_defaults(func=cmd_artifacts_download)

    artifacts_list = artifacts_sub.add_parser("list", help="List artifacts")
    add_user_id_arg(artifacts_list)
    artifacts_list.set_defaults(func=cmd_artifacts_list)

    return parser


def main(argv: Optional[list[str]] = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return

    if args.region is None:
        args.region = resolve_region(args.region, args.profile)

    try:
        if hasattr(args, "func"):
            args.func(args)
        else:
            parser.print_help()
    except RuntimeError as exc:
        print(f"Error: {exc}")
        sys.exit(1)
    except FileNotFoundError as exc:
        print(f"Error: command not found: {exc.filename}")
        sys.exit(1)
    except subprocess.CalledProcessError as exc:
        print(f"Command failed: {exc.cmd}")
        if exc.stdout:
            print(exc.stdout)
        if exc.stderr:
            print(exc.stderr)
        sys.exit(exc.returncode)


if __name__ == "__main__":
    main()
