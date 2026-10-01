#!/usr/bin/env bash
# release.sh — cut a Canvas Desktop release: bump, commit, push main.
#
#   pnpm run release patch|minor|major      bump, commit, push
#   pnpm run release patch --dry-run        print the plan, change nothing
#
# The version lives in four files that must agree (verify-desktop-version.mjs
# fails the build otherwise): package.json, src-tauri/tauri.conf.json,
# src-tauri/Cargo.toml and src-tauri/Cargo.lock — this keeps them in step.
# Pushing is the whole release: release.yml creates v<version> and builds the
# installers on every OS. Needs cargo on PATH (Cargo.lock).
set -euo pipefail

say() { echo "[release $(date '+%H:%M:%S')] $1"; }
die() { echo "[release] ERROR: $1" >&2; exit 1; }

BUMP="${1:-}"; DRY_RUN=false
[[ "$BUMP" =~ ^(patch|minor|major)$ ]] || die "usage: release.sh patch|minor|major [--dry-run]"
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

cd "$(git rev-parse --show-toplevel)"
[[ "$(git branch --show-current)" == "main" ]] || die "releases publish from main only"
git update-index -q --refresh >/dev/null 2>&1 || true
git diff-index --quiet HEAD -- || die "working tree has uncommitted changes"
git fetch origin main --quiet || die "git fetch failed"
git merge-base --is-ancestor origin/main main || die "main is behind/diverged from origin/main — pull first"
command -v cargo >/dev/null || die "cargo not on PATH — the bump has to refresh Cargo.lock"

cur=$(node -p "require('./package.json').version")
if $DRY_RUN; then say "--dry-run: would bump $BUMP from $cur, commit and push main"; exit 0; fi
npm version "$BUMP" --no-git-tag-version >/dev/null
ver=$(node -p "require('./package.json').version")
# Rewrite the version string in place — a JSON round-trip would reformat.
VER=$ver node -e '
const fs = require("fs"), p = "src-tauri/tauri.conf.json", v = process.env.VER;
const src = fs.readFileSync(p, "utf8"), out = src.replace(/("version"\s*:\s*")[^"]+(")/, `$1${v}$2`);
if (JSON.parse(out).version !== v) { console.error("version rewrite failed in " + p); process.exit(1); }
fs.writeFileSync(p, out);'
# Cargo.toml [package] version, first match only.
sed -i "0,/^version = \".*\"/{s/^version = \".*\"/version = \"$ver\"/}" src-tauri/Cargo.toml
( cd src-tauri && cargo update -p canvas-desktop --precise "$ver" ) || die "cargo update failed — Cargo.lock would not match $ver"
node scripts/verify-desktop-version.mjs
git commit --quiet -am "canvas-desktop $ver"
git push --quiet origin main
say "Pushed canvas-desktop $ver — release.yml builds the installers. Watch: gh run list --workflow=release.yml --limit 1"
