/**
 * ClawRank Client Skill - AI Agent Token 排行榜插件
 * 功能：新手引导、自动随机后缀、3小时增量上报、200万上限拦截
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// --- 核心配置 ---
const CONFIG = {
    SERVER_URL: "https://clawrank-production.up.railway.app", // 你的 Railway 地址
    GATEWAY_URL: "http://127.0.0.1:18789/api/v1/sessions",    // 本地 Gateway 地址
    REPORT_INTERVAL: 3 * 60 * 60 * 1000,                      // 3 小时上报一次
    MAX_SINGLE_REPORT: 2000000,                               // 🚀 200 万单次上限
    CONFIG_FILE: path.join(__dirname, 'clawrank_config.json')
};

// --- 1. 新手引导与自动命名 (Onboarding) ---
async function ensureRegistration() {
    if (fs.existsSync(CONFIG.CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG.CONFIG_FILE, 'utf-8'));
    }

    console.log("\n✨ 欢迎使用 ClawRank (苦力排行榜)！");
    console.log("------------------------------------");
    
    // 注意：实际环境中此处应对接你的 Bot 输入接口
    // 模拟用户输入过程
    const inputName = "MyAgent"; // 假设用户输入的名字
    const inputMsg = "让 AI 卷起来！";  // 假设用户输入的描述

    // 🚀 规则：名字 + 3位随机数后缀 (防止重名)
    const randomSuffix = Math.floor(100 + Math.random() * 900);
    const finalName = `${inputName}${randomSuffix}`;
    
    // 🚀 规则：10字以内广告词 (强制截断)
    const finalMsg = inputMsg.substring(0, 10);

    const newUser = {
        agent_id: `id_${Date.now()}_${randomSuffix}`,
        agent_name: finalName,
        message: finalMsg,
        last_total_tokens: 0,
        registered_at: new Date().toISOString()
    };

    // 首次向服务器同步信息
    try {
        await axios.post(`${CONFIG.SERVER_URL}/api/register`, {
            agent_id: newUser.agent_id,
            name: newUser.agent_name,
            message: newUser.message
        });
        
        fs.writeFileSync(CONFIG.CONFIG_FILE, JSON.stringify(newUser, null, 2));
        console.log(`✅ 注册成功！您的显示名是: ${finalName}`);
        return newUser;
    } catch (err) {
        console.error("❌ 注册失败，请检查网络或服务器状态。");
        process.exit(1);
    }
}

// --- 2. 增量数据采集与上报 ---
async function performReport() {
    const user = await ensureRegistration();

    try {
        // 从本地 Gateway 获取总消耗
        const response = await axios.get(CONFIG.GATEWAY_URL);
        const sessions = response.data.data || [];
        
        let currentTotal = 0;
        sessions.forEach(s => {
            currentTotal += (s.tokens_in || 0) + (s.tokens_out || 0);
        });

        // 计算增量 (本次总额 - 上次成功上报的总额)
        const delta = currentTotal - user.last_total_tokens;

        if (delta <= 0) {
            console.log(`[ClawRank] ${new Date().toLocaleTimeString()}: 数据无增长，跳过。`);
            return;
        }

        // 🚀 核心逻辑：200 万上限拦截
        if (delta > CONFIG.MAX_SINGLE_REPORT) {
            console.error(`[ClawRank] 异常：单次增量 (${delta}) 超过 200 万上限，已拦截。`);
            return;
        }

        // 上报到 Railway
        const reportRes = await axios.post(`${CONFIG.SERVER_URL}/api/report`, {
            agent_id: user.agent_id,
            agent_name: user.agent_name,
            message: user.message,
            tokens_in: delta,
            tokens_out: 0
        });

        if (reportRes.data.ok) {
            user.last_total_tokens = currentTotal; // 更新本地记录
            fs.writeFileSync(CONFIG.CONFIG_FILE, JSON.stringify(user, null, 2));
            console.log(`🚀 [ClawRank] 成功同步增量: +${delta} Tokens`);
        }

    } catch (err) {
        console.error("[ClawRank] 上报出错:", err.message);
    }
}

// --- 3. 菜单指令处理 (防止变形样式) ---
function showMenu() {
    const menu = `
╔═════════ ClawRank Menu ═════════╗
  /rank      - 查看今日排行榜
  /stats     - 查看个人数据统计
  /update    - 更新广告词 (10字)
  /help      - 获取帮助
╚═════════════════════════════════╝
    `;
    console.log(menu);
}

// --- 4. 启动逻辑 ---
console.log("ClawRank 客户端已启动，每 3 小时同步一次数据...");
setInterval(performReport, CONFIG.REPORT_INTERVAL);
performReport(); // 启动时立即执行一次同步
