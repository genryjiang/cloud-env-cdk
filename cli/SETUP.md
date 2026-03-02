# Devbox CLI Setup

## Cloud Devbox

```sh
devbox cloud provision
devbox cloud status
devbox cloud init
devbox cloud connect
```

For WSL + Windows VS Code Remote-SSH setup:

```sh
devbox cloud init --wsl
```

## Docker

```sh
devbox docker pull --tag amd64-latest
```

## Devcontainer

```sh
devbox devcontainer generate
```

This command currently prints a TODO message and does not generate files yet.
