#!/usr/bin/env bash
# Deploy (or update) Tavern on a single-node Kubernetes cluster, e.g. a Hetzner box running k3s.
#
#   curl -fsSL https://raw.githubusercontent.com/brokenyus-hash/Test/claude/ai-roleplay-app-characters-w0a4bb/deploy/hetzner-k8s.sh \
#     | XAI_API_KEY=xai-... APP_PASSWORD=choose-a-password bash
#
# Env vars:  APP_PASSWORD (required)  XAI_API_KEY / ANTHROPIC_API_KEY (at least one)
#            HOST (default tavern.<public-ip>.nip.io)  NODEPORT (default 30080)  BRANCH (default: this branch)
# Re-run the same command to pull the latest code; chats live in /var/lib/tavern/data and survive updates.
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/brokenyus-hash/Test/${BRANCH:-claude/ai-roleplay-app-characters-w0a4bb}/deploy/k8s"
: "${APP_PASSWORD:?Set APP_PASSWORD=... (protects the app on the internet)}"
if [ -z "${XAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Set XAI_API_KEY=... and/or ANTHROPIC_API_KEY=..." >&2; exit 1
fi

# --- find kubectl (plain, k3s, or microk8s) ---
if command -v kubectl >/dev/null 2>&1; then K="kubectl"
elif command -v k3s >/dev/null 2>&1; then K="k3s kubectl"
elif command -v microk8s >/dev/null 2>&1; then K="microk8s kubectl"
else echo "kubectl not found: is Kubernetes installed on this machine?" >&2; exit 1; fi
echo "Using: $K"
$K get nodes -o wide

# --- manifests (from the repo, or local checkout if run from it) ---
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
fetch() { if [ -n "$HERE" ] && [ -f "$HERE/k8s/$1" ]; then cat "$HERE/k8s/$1"; else curl -fsSL "$REPO_RAW/$1"; fi; }

fetch tavern.yaml | $K apply -f -
fetch autodeploy.yaml | $K apply -f -      # redeploys automatically whenever the branch moves
[ -n "${BRANCH:-}" ] && $K -n tavern patch configmap tavern-config -p "{\"data\":{\"REPO_BRANCH\":\"$BRANCH\"}}" >/dev/null

$K -n tavern create secret generic tavern-secrets \
  --from-literal=APP_PASSWORD="$APP_PASSWORD" \
  --from-literal=XAI_API_KEY="${XAI_API_KEY:-}" \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --dry-run=client -o yaml | $K apply -f -

# --- expose: Ingress if the cluster has an ingress class, otherwise a NodePort ---
PUBLIC_IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
HOST="${HOST:-tavern.${PUBLIC_IP}.nip.io}"
NODEPORT="${NODEPORT:-30080}"
if $K get ingressclass -o name 2>/dev/null | grep -q .; then
  fetch ingress.yaml | HOST="$HOST" envsubst '${HOST}' | $K apply -f -
  URL="http://$HOST"
else
  echo "No ingress controller found; exposing on NodePort $NODEPORT"
  $K -n tavern patch service tavern -p "{\"spec\":{\"type\":\"NodePort\",\"ports\":[{\"name\":\"http\",\"port\":80,\"targetPort\":\"http\",\"nodePort\":$NODEPORT}]}}"
  URL="http://$PUBLIC_IP:$NODEPORT"
fi

# --- roll out (restart so a re-run pulls fresh code) ---
$K -n tavern rollout restart deployment/tavern >/dev/null 2>&1 || true
echo "Waiting for the app to start (first run clones the repo and installs packages)…"
$K -n tavern rollout status deployment/tavern --timeout=600s
$K -n tavern get pods -o wide

cat <<MSG

✅ Tavern is up:  $URL
   Login: user "tavern", password = APP_PASSWORD
   Then open Settings → provider "xAI — Grok" (or Anthropic) — the key from the environment is already picked up.

Useful:
   $K -n tavern logs deploy/tavern -f            # server logs
   $K -n tavern logs deploy/tavern -c fetch      # clone/install log
   (updates are automatic: every 2 min the cluster checks GitHub and rolls out new commits)
   $K -n tavern get cronjob,jobs               # auto-deploy activity
   /var/lib/tavern/data/tavern.sqlite            # your chats (back this up)
MSG
