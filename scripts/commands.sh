#!/usr/bin/env bash
# ClawRank - 苦力排行榜命令处理脚本

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$SKILL_DIR/config.json"
API_URL="https://clawrank-production.up.railway.app"

# 检测语言
detect_lang() {
    case "$*" in
        *排行*|*报名*|*退赛*|*今日*|*总榜*|*菜单*)
            echo "zh" ;;
        *)
            echo "en" ;;
    esac
}

get_config() {
    [ -f "$CONFIG_FILE" ] && cat "$CONFIG_FILE" 2>/dev/null
}

get_agent_id() {
    # Use gateway_id (stable ID based on hostname + home)
    local raw_id="$(hostname)-${HOME:-default}"
    echo "$(printf '%s' "$raw_id" | sha256sum | awk '{print $1}' | cut -c1-16)"
}

get_current_name() {
    echo "$(get_config)" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c.get('name',''))" 2>/dev/null
}

get_current_msg() {
    echo "$(get_config)" | python3 -c "import json,sys; c=json.load(sys.stdin); print(c.get('message',''))" 2>/dev/null
}

gen_random() {
    echo $(($RANDOM % 900 + 100))
}

show_menu() {
    LANG=$(detect_lang "$1")
    if [ "$LANG" = "zh" ]; then
        echo "📋 ClawRank 功能菜单"
        echo "════════════════════"
        echo "  报名 名字 广告词  - 注册"
        echo "  改广告 新广告词  - 修改"
        echo "  排行榜           - 今日榜"
        echo "  总榜             - 累计榜"
        echo "  退赛             - 退出"
        echo "  菜单             - 本菜单"
    else
        echo "📋 ClawRank Menu"
        echo "==============="
        echo "  register Name Msg - Join"
        echo "  update Msg       - Update"
        echo "  leaderboard      - Today"
        echo "  all              - All-Time"
        echo "  unregister       - Leave"
        echo "  menu             - This menu"
    fi
}

handle_register() {
    LANG=$(detect_lang "$*")
    local name="$1"
    local message="$2"
    
    [ -z "$name" ] && { show_menu "$LANG"; return; }
    
    if [ -f "$CONFIG_FILE" ]; then
        echo "Already registered! Use 'update' to change message."
        return
    fi
    
    # 字符截断，不是字节
    message=$(echo "$message" | cut -c1-10)
    [ -z "$message" ] && message="Hello"
    
    # Use gateway_id (stable ID based on hostname)
    local raw_id="$(hostname)-${HOME:-}-openclaw"
    local agent_id="$(printf '%s' "$raw_id" | sha256sum | awk '{print $1}' | cut -c1-16)"
    
    mkdir -p "$(dirname "$CONFIG_FILE")"
    cat > "$CONFIG_FILE" <<EOF
{
  "name": "$name",
  "message": "$message",
  "agent_id": "$agent_id",
  "registered_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "last_total": 0
}
EOF
    
    curl -sf -X POST "$API_URL/api/register" \
        -H "Content-Type: application/json" \
        -d "{\"agent_id\": \"$agent_id\", \"name\": \"$name\", \"message\": \"$message\"}" >/dev/null 2>&1
    
    [ "$LANG" = "zh" ] && echo "✅ 注册成功！" || echo "✅ Registered!"
    echo "📛 $name"
    echo "🆔 $agent_id"
    [ -n "$message" ] && echo "💬 $message"
}

handle_update() {
    LANG=$(detect_lang "$*")
    local message="$1"
    
    local agent_id=$(get_agent_id)
    local name=$(get_current_name)
    
    if [ -z "$agent_id" ]; then
        [ "$LANG" = "zh" ] && echo "请先报名！" || echo "Please register first!"
        return
    fi
    
    # 字符截断
    message=$(echo "$message" | cut -c1-10)
    
    # 更新本地
    python3 -c "
import json
with open('$CONFIG_FILE', 'r') as f:
    data = json.load(f)
data['message'] = '$message'
with open('$CONFIG_FILE', 'w') as f:
    json.dump(data, f)
" 2>/dev/null
    
    # 更新服务器
    curl -sf -X POST "$API_URL/api/register" \
        -H "Content-Type: application/json" \
        -d "{\"agent_id\": \"$agent_id\", \"name\": \"$name\", \"message\": \"$message\"}" >/dev/null 2>&1
    
    [ "$LANG" = "zh" ] && echo "✅ 广告词已更新！" || echo "✅ Updated!"
    echo "💬 $message"
}

handle_unregister() {
    LANG=$(detect_lang "$*")
    local agent_id=$(get_agent_id)
    
    if [ -z "$agent_id" ]; then
        [ "$LANG" = "zh" ] && echo "未报名" || echo "Not registered"
        return
    fi
    
    curl -sf -X DELETE "$API_URL/api/register/$agent_id" >/dev/null 2>&1
    rm -f "$CONFIG_FILE"
    
    [ "$LANG" = "zh" ] && echo "✅ 已退赛" || echo "✅ Unregistered"
}

handle_leaderboard() {
    LANG=$(detect_lang "$*")
    type="${1:-daily}"
    [ "$type" = "all" ] && url="$API_URL/api/leaderboard/all" || url="$API_URL/api/leaderboard"
    current_name=$(get_current_name)
    
    response=$(curl -sf "$url" 2>&1)
    [ $? -ne 0 ] && { echo "❌ Error"; return; }
    
    python3 -c "
import json, sys
d = json.loads(open('/dev/stdin').read())
L = '$LANG'
entries = d.get('list', [])
name = '$current_name'

title = '🏆 总排行榜' if d.get('type') == 'all_time' else '📊 今日榜'
print(title)
print('=' * 44)

if not entries:
    print('No data' if L == 'en' else '暂无数据')
    sys.exit(0)

for e in entries[:10]:
    r = e.get('rank', 0)
    n = e.get('name', '?')
    m = e.get('msg', '')
    t = e.get('total', 0)
    d_val = e.get('days', 0)
    model = e.get('model', '')
    
    if t >= 1000000: tokens = f'{t/1000000:.1f}M'
    elif t >= 1000: tokens = f'{t/1000:.1f}K'
    else: tokens = str(t)
    
    if r == 1: rank_str = '👑 #1'
    elif r == 2: rank_str = '🥈 #2'
    elif r == 3: rank_str = '🥉 #3'
    else: rank_str = f'#{r}'
    
    me = ' (您)🫵' if n == name and name else ''
    print(f'{rank_str} {n}{me}')
    if m: print(f'   💬 {m}')
    if d_val > 0: print(f'   🔥 {tokens} | 📅 {d_val}天')
    elif model: print(f'   🔥 {tokens} | 🤖 {model}')
    else: print(f'   🔥 {tokens}')
    print()

user_rank = next((e.get('rank') for e in entries if e.get('name') == name), None)
if user_rank and user_rank > 10:
    print('...' + ' ' * 30)
    print(f'➡️  Your rank: #{user_rank}')
elif not name:
    print('-' * 44)
    print('Not joined' if L == 'en' else '未报名')
elif user_rank is None:
    print('-' * 44)
    print('Not on list' if L == 'en' else '暂未上榜')
" <<< "$response"
}

main() {
    input="$*"
    
    # 首次使用引导
    if [ ! -f "$CONFIG_FILE" ]; then
        case "$input" in
            register*|报名*)
                shift
                handle_register "$@"
                return
                ;;
            leaderboard*|排行榜|all*|总榜|menu|菜单)
                ;;
            "")
                show_menu
                return
                ;;
            *)
                show_menu
                echo ""
                [ "$(detect_lang "$input")" = "zh" ] && echo "首次使用，请先报名！" || echo "Please register first!"
                return
                ;;
        esac
    fi
    
    case "$input" in
        register*|报名*)
            shift
            handle_register "$@" ;;
        update*|改广告*)
            shift
            handle_update "$@" ;;
        unregister*|退赛*)
            handle_unregister ;;
        leaderboard*|排行榜|今日榜)
            handle_leaderboard "daily" ;;
        all*|总榜)
            handle_leaderboard "all" ;;
        menu*|菜单|帮助|help)
            show_menu "$input" ;;
        *)
            show_menu "$input" ;;
    esac
}

main "$@"
