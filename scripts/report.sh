#!/usr/bin/env bash
# ClawRank Token Reporter - Simplified to total only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$SKILL_DIR/config.json"
STATE_FILE="${HOME}/.openclaw/labor-leaderboard-state.json"
API_URL="${LEADERBOARD_URL:-https://clawrank-production.up.railway.app}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ClawRank: python3 is required."
  exit 1
fi

# Generate payload
PAYLOADS="$(
python3 - "$CONFIG_FILE" "$STATE_FILE" <<'PY'
import json
import os
import sys
from pathlib import Path
from datetime import datetime

config_file = Path(sys.argv[1])
state_file = Path(sys.argv[2])
home = Path(os.environ.get("HOME", ""))

def safe_num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

def usage_total(usage):
    if not isinstance(usage, dict):
        return 0
    input_t = safe_num(usage.get("input", usage.get("inputTokens", usage.get("promptTokens", 0))))
    output_t = safe_num(usage.get("output", usage.get("outputTokens", usage.get("completionTokens", 0))))
    total_t = safe_num(usage.get("totalTokens", usage.get("total", usage.get("tokens", 0))))
    if total_t <= 0 and (input_t > 0 or output_t > 0):
        total_t = input_t + output_t
    return total_t

def load_config():
    if not config_file.exists():
        return {}
    try:
        return json.loads(config_file.read_text(encoding="utf-8"))
    except:
        return {}

def get_gateway_id():
    raw = f"{os.uname().nodename}-{os.environ.get('HOME','')}"
    import hashlib
    return hashlib.sha256(raw.encode()).hexdigest()[:16]

cfg = load_config()
gateway_id = cfg.get("agent_id") or get_gateway_id()
agent_name = cfg.get("name") or cfg.get("agent_name", os.uname().nodename)
message = cfg.get("message", "")

# Get registered_at timestamp
registered_at = cfg.get("registered_at")
registered_ts = 0
if registered_at:
    try:
        registered_ts = int(datetime.fromisoformat(registered_at.replace("Z", "+00:00")).timestamp() * 1000)
    except:
        registered_ts = 0

# Load previous total
prev_total = 0
prev_time = 0
if state_file.exists():
    try:
        data = json.loads(state_file.read_text(encoding="utf-8"))
        prev_total = safe_num(data.get("total", 0))
        prev_time = safe_num(data.get("time", 0))
    except:
        pass

# Scan JSONL files after registered_at
agents_dir = home / ".openclaw" / "agents"
current_total = 0

if agents_dir.exists():
    for agent in agents_dir.iterdir():
        sessions = agent / "sessions"
        if not sessions.exists():
            continue
        for file in sessions.glob("*.jsonl"):
            try:
                # Skip files modified before registration
                if registered_ts > 0:
                    mtime = file.stat().st_mtime * 1000
                    if mtime < registered_ts:
                        continue
                        
                with file.open("r", encoding="utf-8") as f:
                    for line in f:
                        if not line.strip():
                            continue
                        try:
                            obj = json.loads(line)
                        except:
                            continue
                        
                        # Extract message
                        msg = None
                        if isinstance(obj, dict):
                            msg = obj.get("message")
                            if not isinstance(msg, dict):
                                data = obj.get("data", {})
                                if isinstance(data, dict):
                                    msg = data.get("message")
                        
                        if not isinstance(msg, dict):
                            continue
                        if msg.get("role") != "assistant":
                            continue
                        
                        usage = usage_total(msg.get("usage"))
                        if usage > 0:
                            current_total += usage
            except:
                continue

# Calculate delta
delta = max(0, current_total - prev_total)

if delta <= 0:
    print("[]")
    sys.exit(0)

# Save new state
state_file.parent.mkdir(parents=True, exist_ok=True)
state_file.write_text(json.dumps({"total": current_total, "time": int(datetime.now().timestamp() * 1000)}, separators=(",", ":")), encoding="utf-8")

# Single payload with total
payload = [{
    "agent_id": gateway_id,
    "agent_name": agent_name,
    "message": message,
    "tokens_in": delta,
    "tokens_out": 0,
    "model": ""
}]

print(json.dumps(payload))
PY
)"

if [ "$PAYLOADS" = "[]" ] || [ -z "$PAYLOADS" ]; then
  echo "ClawRank: no new tokens."
  exit 0
fi

# Send report
python3 - "$PAYLOADS" "$API_URL" <<'PY'
import json
import subprocess
import sys

payloads = json.loads(sys.stdin.read())
api_url = sys.argv[2]

for body in payloads:
    total = body.get("tokens_in", 0)
    p = subprocess.run(
        ["curl", "-sf", "-X", "POST", f"{api_url}/api/report",
         "-H", "Content-Type: application/json",
         "-d", json.dumps(body, separators=(",", ":"))],
        capture_output=True, text=True
    )
    if p.returncode == 0:
        print(f"Reported: {total} tokens")
    else:
        print(f"Failed: {p.stderr.strip()[:100]}")
PY
