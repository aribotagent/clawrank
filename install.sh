#!/usr/bin/env bash
# ClawRank Skill 安装脚本 - 只设置 cron，不自动注册

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$SKILL_DIR/config.json"

echo "📦 ClawRank 安装..."

# 检查是否已注册
if [ -f "$CONFIG_FILE" ]; then
    echo "✅ 已注册: $(cat $CONFIG_FILE | python3 -c 'import json,sys; c=json.load(sys.stdin); print(c.get(\"name\",\"\"))')"
    echo "如需重新报名，请先删除 $CONFIG_FILE"
else
    echo "⚠️ 尚未报名！"
    echo "使用以下命令报名："
    echo "  报名 你的名字 广告词"
    echo "例如：报名 MyBot 你好"
fi

# 设置 cron
bash "$SCRIPT_DIR/setup-cron.sh"

echo "✅ 安装完成！"
