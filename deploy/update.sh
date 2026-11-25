#!/usr/bin/env bash
set -euo pipefail
cd /opt/whatix
umask 077
exec 9>.update.lock
flock -n 9 || { echo "An update is already running."; exit 1; }

if [[ -z ${1:-} ]]; then
  git -C repo fetch --quiet origin main
  target=$(git -C repo rev-parse 'FETCH_HEAD^{commit}')
else
  target=$(git -C repo rev-parse --verify --end-of-options "$1^{commit}")
fi

status_file=.update-status
set_status() {
  printf '%s %s\n' "$1" "$target" > "$status_file.tmp"
  mv "$status_file.tmp" "$status_file"
}
current=$(cat "$status_file" 2>/dev/null || true)
if [[ $current == "live $target" ]]; then
  exit 0
fi
if [[ $current == "attempt $target" && -z ${1:-} ]]; then
  echo "Revision $target needs review; retry explicitly or push a fix."
  exit 1
fi
if [[ -n $(git -C repo status --porcelain) ]]; then
  echo "Deployment checkout has local changes; inspect git -C repo status."
  exit 1
fi
compose=(docker compose -p whatix -f compose.yaml -f compose.override.yaml)
"${compose[@]}" config --quiet
set_status attempt
echo "Deploying $target"
git -C repo checkout --quiet --detach "$target"
"${compose[@]}" build api web
"${compose[@]}" up -d --no-build --no-deps api web

for attempt in {1..30}; do
  if curl -fsS --max-time 4 http://127.0.0.1:8081/api/health 2>/dev/null |
      python3 -c 'import json,sys; sys.exit(json.load(sys.stdin).get("ok") is not True)' 2>/dev/null &&
      curl -fsS --max-time 4 -o /dev/null http://127.0.0.1:8081/; then
    set_status live
    echo "Healthy revision $target"
    exit 0
  fi
  sleep 2
done
echo "Health check failed. Inspect docker compose logs api web."
exit 1
