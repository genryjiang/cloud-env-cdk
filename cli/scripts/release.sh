#!/usr/bin/env bash
set -euo pipefail

REMOTE="${1:-origin}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required."
  exit 1
fi

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Error: run this script inside the repository."
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [[ ! -f package.json ]]; then
  echo "Error: package.json not found at repo root."
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"

echo "Current version: ${CURRENT_VERSION}"
read -r -p "Enter release version [${CURRENT_VERSION}]: " INPUT_VERSION
TARGET_VERSION="${INPUT_VERSION:-$CURRENT_VERSION}"

if [[ ! "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.+-]+)?$ ]]; then
  echo "Error: invalid version format '${TARGET_VERSION}'. Use format like 0.1.1 or 0.1.1-rc1."
  exit 1
fi

TAG="v${TARGET_VERSION}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "HEAD" ]]; then
  echo "Error: detached HEAD is not supported for releases."
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Error: local tag ${TAG} already exists."
  exit 1
fi

if git ls-remote --tags "${REMOTE}" "refs/tags/${TAG}" | grep -q .; then
  echo "Error: remote tag ${TAG} already exists on ${REMOTE}."
  exit 1
fi

echo
echo "Release plan:"
echo "  remote:  ${REMOTE}"
echo "  branch:  ${BRANCH}"
echo "  version: ${CURRENT_VERSION} -> ${TARGET_VERSION}"
echo "  tag:     ${TAG}"
echo
read -r -p "Continue with release? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

if [[ "$TARGET_VERSION" != "$CURRENT_VERSION" ]]; then
  npm version "$TARGET_VERSION" --no-git-tag-version
  git add package.json
  git commit -m "chore(release): ${TAG}"
else
  echo "Version unchanged. Releasing from existing version."
fi

git tag -a "${TAG}" -m "Release ${TAG}"
git push "${REMOTE}" "${BRANCH}"
git push "${REMOTE}" "${TAG}"

echo "Release complete: ${TAG}"
