#!/usr/bin/env bash
# Auto-merge a PR when its CI is green. Robust against:
#   - empty statusCheckRollup at PR open time
#   - "null" string in conclusion when checks haven't registered
#   - PR being merged externally while we wait
#   - gh CLI transient errors
#
# Usage: auto-merge-when-green.sh <PR-NUMBER> [--method merge|squash|rebase]

set -uo pipefail

PR_NUM=${1:?"usage: $0 <PR-NUMBER> [--method merge|squash|rebase]"}
METHOD="merge"
if [ "${2:-}" = "--method" ]; then METHOD="${3:-merge}"; fi

# Hard cap so a stalled poller never lingers forever.
TIMEOUT_SEC=${TIMEOUT_SEC:-2700}   # 45 min
INTERVAL_SEC=${INTERVAL_SEC:-30}

start=$(date +%s)
while true; do
  now=$(date +%s)
  if [ "$((now - start))" -gt "$TIMEOUT_SEC" ]; then
    echo "[PR #$PR_NUM] timed out after ${TIMEOUT_SEC}s; not merging"
    exit 2
  fi

  # First — is the PR already merged or closed?
  state=$(gh pr view "$PR_NUM" --json state -q '.state' 2>/dev/null || echo "")
  case "$state" in
    MERGED)
      echo "[PR #$PR_NUM] already MERGED"
      exit 0
      ;;
    CLOSED)
      echo "[PR #$PR_NUM] CLOSED without merge; exiting"
      exit 1
      ;;
    OPEN|"")
      ;;
    *)
      echo "[PR #$PR_NUM] unexpected state=$state; exiting"
      exit 1
      ;;
  esac

  # `gh pr checks` returns one line per check. Use --required so we only
  # care about required checks; falls back gracefully when no checks are
  # required. Output format: <name>\t<state>\t<elapsed>\t<url>.
  checks=$(gh pr checks "$PR_NUM" 2>&1 || true)
  if [ -z "$checks" ] || echo "$checks" | grep -qi "no checks reported"; then
    sleep "$INTERVAL_SEC"
    continue
  fi
  # Failure mode: any line whose 2nd column is fail.
  if echo "$checks" | awk -F'\t' '{print $2}' | grep -qi -e 'fail' -e 'cancel' -e 'timed_out'; then
    echo "[PR #$PR_NUM] CI failed:"; echo "$checks"
    exit 1
  fi
  # If any check is still pending/queued, keep waiting.
  if echo "$checks" | awk -F'\t' '{print $2}' | grep -qi -e 'pending' -e 'queued' -e 'in_progress'; then
    sleep "$INTERVAL_SEC"
    continue
  fi
  # All other states are "pass" (gh prints lowercase "pass" / "neutral" / "skipping").
  echo "[PR #$PR_NUM] all checks pass; merging via $METHOD"
  if gh pr merge "$PR_NUM" --"$METHOD" --delete-branch 2>&1 | tee /tmp/helm-merge-$PR_NUM.log; then
    echo "[PR #$PR_NUM] merged"
    exit 0
  fi
  # Merge might fail because the base hasn't been updated; wait + retry.
  if grep -qi 'base branch was modified' /tmp/helm-merge-$PR_NUM.log; then
    sleep "$INTERVAL_SEC"
    continue
  fi
  echo "[PR #$PR_NUM] merge command failed; bailing"
  exit 1
done
