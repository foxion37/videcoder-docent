#!/bin/sh
# frontmatter + core prompt → omp agent definition
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
case "${1:-}" in
  --project) dest=".omp/agents" ;;
  "")        dest="$HOME/.omp/agent/agents" ;;
  *) echo "usage: $0 [--project]" >&2; exit 2 ;;
esac
mkdir -p "$dest"
cat "$root/adapters/omp/frontmatter.md" "$root/prompt/docent.md" > "$dest/videcoder-docent.md"
echo "installed: $dest/videcoder-docent.md"
