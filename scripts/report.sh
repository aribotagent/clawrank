#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$SKILL_DIR/config.json"
STATE_FILE="${HOME}/.openclaw/labor-leaderboard-state.json"
API_URL="${LEADERBOARD_URL:-https://clawrank-production.up.railway.app}"

AGENT_NAME_OVERRIDE="${1:-}"
COUNTRY_OVERRIDE="${2:-}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "labor-leaderboard: python3 is required for JSONL parsing."
  exit 1
fi

PAYLOADS="$(
python3 - "$CONFIG_FILE" "$STATE_FILE" "$AGENT_NAME_OVERRIDE" "$COUNTRY_OVERRIDE" <<'PY'
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path

config_file = Path(sys.argv[1])
state_file = Path(sys.argv[2])
agent_override = sys.argv[3].strip()
country_override = sys.argv[4].strip()
home = Path(os.environ.get("HOME", ""))

def safe_num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

def usage_totals(usage):
    if not isinstance(usage, dict):
        return None
    input_t = safe_num(usage.get("input", usage.get("inputTokens", usage.get("promptTokens", 0))))
    output_t = safe_num(usage.get("output", usage.get("outputTokens", usage.get("completionTokens", 0))))
    total_t = safe_num(usage.get("totalTokens", usage.get("total", usage.get("tokens", 0))))
    if total_t <= 0 and (input_t > 0 or output_t > 0):
        total_t = input_t + output_t
    if total_t <= 0 and input_t <= 0 and output_t <= 0:
        return None
    return {
        "tokens": int(total_t),
        "input": int(input_t),
        "output": int(output_t),
    }

def load_config():
    cfg = {}
    if config_file.exists():
        try:
            cfg = json.loads(config_file.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
    return cfg

cfg = load_config()

# 生成 gateway_id
def get_gateway_id():
    raw = f"{os.uname().nodename}-{os.environ.get('HOME','')}-openclaw"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]

gateway_id = cfg.get("gateway_id") or get_gateway_id()
agent_name = agent_override or cfg.get("name") or cfg.get("agent_name") or os.environ.get("LAB_AGENT_NAME") or os.uname().nodename
country = (country_override or cfg.get("country") or os.environ.get("LAB_COUNTRY") or "SG").upper()
message = cfg.get("message", "")

# 读取上次的 total（用于计算增量）
prev_total = {}
if state_file.exists():
    try:
        prev_data = json.loads(state_file.read_text(encoding="utf-8"))
        prev_total = prev_data.get("totals", {})
    except Exception:
        prev_total = {}

# 扫描所有 JSONL 文件
agents_dir = home / ".openclaw" / "agents"
totals = {}

if agents_dir.exists():
    for agent in agents_dir.iterdir():
        sessions = agent / "sessions"
        if not sessions.exists():
            continue
        for file in sessions.glob("*.jsonl"):
            try:
                with file.open("r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except Exception:
                            continue
                        
                        # 提取 message
                        msg = obj.get("message") if isinstance(obj, dict) else None
                        if not isinstance(msg, dict) and isinstance(obj, dict):
                            data = obj.get("data")
                            if isinstance(data, dict):
                                msg = data.get("message")
                        if not isinstance(msg, dict):
                            continue
                        if msg.get("role") != "assistant":
                            continue
                        
                        usage = usage_totals(msg.get("usage"))
                        if not usage:
                            continue
                        
                        model = msg.get("model") or msg.get("modelId") or "unknown"
                        rec = totals.setdefault(model, {"tokens": 0, "input": 0, "output": 0})
                        rec["tokens"] += usage["tokens"]
                        rec["input"] += usage["input"]
                        rec["output"] += usage["output"]
            except Exception:
                continue

# 计算增量
payloads = []
for model, cur in totals.items():
    prev = prev_total.get(model, {})
    dt = int(cur.get("tokens", 0)) - int(prev.get("tokens", 0))
    di = int(cur.get("input", 0)) - int(prev.get("input", 0))
    do = int(cur.get("output", 0)) - int(prev.get("output", 0))
    
    if dt > 0 or di > 0 or do > 0:
        payloads.append({
            "agent_id": gateway_id,
            "agent_name": agent_name,
            "message": message,
            "country": country,
            "tokens_delta": dt if dt > 0 else max(0, di + do),
            "tokens_in": max(0, di),
            "tokens_out": max(0, do),
            "model": model,
            "request_id": str(uuid.uuid4())[:16]
        })

# 保存当前状态
state_file.parent.mkdir(parents=True, exist_ok=True)
state_file.write_text(json.dumps({"totals": totals}, separators=(",", ":")), encoding="utf-8")

print(json.dumps(payloads))
PY
)"

if [ "$PAYLOADS" = "[]" ] || [ -z "$PAYLOADS" ]; then
  echo "labor-leaderboard: no new token deltas."
  exit 0
fi

python3 - "$PAYLOADS" "$API_URL" <<'PY'
import json
import subprocess
import sys

payloads = json.loads(sys.argv[1])
api_url = sys.argv[2]

for body in payloads:
    p = subprocess.run(
        [
            "curl", "-sf", "-X", "POST", f"{api_url}/api/report",
            "-H", "Content-Type: application/json",
            "-d", json.dumps(body, separators=(",", ":")),
        ],
        capture_output=True,
        text=True,
    )
    if p.returncode == 0:
        print(f"reported {body['tokens_delta']} tokens model={body['model']}")
    else:
        print(f"failed model={body['model']} code={p.returncode}: {p.stderr}", file=sys.stderr)
PY
