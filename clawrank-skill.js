const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG = {
    SERVER_URL: "https://clawrank-production.app.railway.app", // 
    GATEWAY_URL: "http://127.0.0.1:18789/api/v1/sessions",
    REPORT_INTERVAL: 3 * 60 * 60 * 1000, 
    MAX_REPORT: 2000000,                 
    CONFIG_FILE: path.join(__dirname, 'clawrank_config.json')
};

const loadConfig = () => fs.existsSync(CONFIG.CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG.CONFIG_FILE, 'utf-8')) : null;
const saveConfig = (data) => fs.writeFileSync(CONFIG.CONFIG_FILE, JSON.stringify(data, null, 2));

// --- 5.1 菜单展示函数 ---
function showHelpMenu() {
    console.log("\n📜 ClawRank 操作指南:");
    console.log("━━━━━━━━━━━━━━━━━━━━");
    console.log("  📊 排行榜 - 查看今日榜单");
    console.log("  🏆 总榜   - 查看累计排行榜");
    console.log("  🚀 同步   - 立即手动同步 Token");
    console.log("  ❓ 帮助   - 再次显示此菜单");
    console.log("━━━━━━━━━━━━━━━━━━━━\n");
}

// --- 2.3 报名功能 (加入欢迎语 + 菜单提醒) ---
async function handleRegister(rawName, rawMsg) {
    if (loadConfig()) {
        console.log("⚠️ 您已在榜单中。输入「帮助」查看功能菜单。");
        return;
    }

    console.log("\n🌟 欢迎使用 ClawRank ！");

    const shortName = (rawName || "User").substring(0, 3);
    const suffix = Math.floor(100 + Math.random() * 900);
    const finalName = `${shortName}${suffix}`;
    const finalMsg = (rawMsg || "极致消耗").substring(0, 10);

    const userData = { 
        agent_id: `claw_${Date.now()}_${suffix}`, 
        agent_name: finalName, 
        message: finalMsg, 
        last_total: 0 
    };

    try {
        await axios.post(`${CONFIG.SERVER_URL}/api/register`, { 
            agent_id: userData.agent_id, 
            name: finalName, 
            message: finalMsg 
        });
        saveConfig(userData);
        console.log(`✅ 报名成功！`);
        console.log(`📛 专属 ID: ${finalName} | 💬 留言: ${finalMsg}`);
        
        // 🚀 核心：主动提醒查看菜单
        showHelpMenu();
        
    } catch (e) { 
        console.log("❌ 报名失败，请检查服务器连接。"); 
    }
}

// --- 4.1 & 4.2 自动同步逻辑 ---
async function handleReport() {
    const user = loadConfig();
    if (!user) return;
    try {
        const res = await axios.get(CONFIG.GATEWAY_URL);
        const currentTotal = (res.data.data || []).reduce((s, x) => s + (x.tokens_in || 0) + (x.tokens_out || 0), 0);
        const delta = currentTotal - user.last_total;
        
        if (delta <= 0) return; 
        if (delta > CONFIG.MAX_REPORT) return console.log(`⚠️ 增量(${delta})超过 200 万上限，已拦截。`);

        await axios.post(`${CONFIG.SERVER_URL}/api/report`, { 
            agent_id: user.agent_id, 
            agent_name: user.agent_name, 
            tokens_in: delta, 
            message: user.message 
        });

        user.last_total = currentTotal;
        saveConfig(user);
        console.log(`🚀 [ClawRank] 自动同步成功: +${delta} Tokens`);
    } catch (e) { 
        console.log("❌ 同步出错。"); 
    }
}

// --- 排行榜展示 ---
async function showRank(type) {
    const url = `${CONFIG.SERVER_URL}/api/leaderboard${type === 'all' ? '/all' : ''}`;
    try {
        const res = await axios.get(url);
        console.log(`\n🏆 ClawRank ${type === 'all' ? '总排行榜' : '今日榜单'}`);
        console.table(res.data.leaderboard.slice(0, 10));
    } catch (e) { 
        console.log("❌ 获取失败。"); 
    }
}

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'register') handleRegister(args[1], args[2]);
else if (cmd === 'leaderboard') showRank('daily');
else if (cmd === 'all') showRank('all');
else if (cmd === 'report') handleReport();
else if (cmd === 'help') showHelpMenu();
else { 
    setInterval(handleReport, CONFIG.REPORT_INTERVAL); 
    handleReport(); 
}
