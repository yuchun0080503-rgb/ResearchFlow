// harness.mjs — AI Harness 的硬限制（第五步）：純邏輯，不含 Firestore／網路呼叫，可直接用 node:test 驗證。
//
// 這份檔案是「誰可以叫 Agent 做什麼」在伺服器端的單一真相來源：
//   - 角色：只有 owner／editor 可以執行 Agent（對應 src/permissions.mjs 的 agent.execute）
//   - 老師設定的 AI 權限 Level（0–3）：每個 Agent 動作有最低 Level
//   - Token 預算：每個專案累計用量超過上限就拒絕（第28章成本控制）
//   - generateReport：任何 Level 都不開放——ResearchFlow 不代替學生完成整份報告
// 前端（researchflow.html 的 NEED 表）只是為了 UX 提早把按鈕擋下來，真正的判斷以這裡為準。

export const AGENT_ROLES = ['owner', 'editor'];
export const DEFAULT_LEVEL = 2;
export const TOKEN_BUDGET = 60000;

// Level 0 No AI／1 Research Assistant／2 Thinking Assistant／3 Writing Assistant
export const MIN_LEVEL = {
  readHandwriting: 1,
  analyzeScope: 1,
  searchEvidence: 1,
  proposeKeywords: 1, // 學生自己寫 Research Question，Agent 只產生搜尋關鍵字
  proposeQuestion: 2, // Agent 草擬 Research Question
  summarizeEvidence: 3,
  generateReport: Infinity,
};

export function normalizeLevel(v) {
  return Number.isInteger(v) && v >= 0 && v <= 3 ? v : DEFAULT_LEVEL;
}

/**
 * @returns {{ok:true}|{ok:false, code:string, message:string}} code 對應 Cloud Functions 的 HttpsError code
 */
export function checkAgentCall({ role, aiLevel, action, tokensUsed = 0 }) {
  if (!(action in MIN_LEVEL)) {
    return { ok: false, code: 'invalid-argument', message: `未知的 Agent 動作：${action}` };
  }
  if (!AGENT_ROLES.includes(role)) {
    return { ok: false, code: 'permission-denied', message: `拒絕 ${action}：你的角色為唯讀，無法執行 Agent。` };
  }
  if (action === 'generateReport') {
    return { ok: false, code: 'permission-denied', message: '拒絕 generate_report：此能力未開放，研究結論與報告由學生完成。' };
  }
  const level = normalizeLevel(aiLevel);
  if (level < MIN_LEVEL[action]) {
    return { ok: false, code: 'permission-denied', message: `拒絕 ${action}：目前權限 Level ${level} 不允許此操作。` };
  }
  if (tokensUsed >= TOKEN_BUDGET) {
    return { ok: false, code: 'resource-exhausted', message: `拒絕 ${action}：此專案的 Token 預算（${TOKEN_BUDGET.toLocaleString('en-US')}）已用完。` };
  }
  return { ok: true };
}

// 只有老師可以調整 AI 權限；Level 必須是 0–3 的整數（不能用 normalizeLevel 幫忙修正，亂填就直接拒絕）。
export function checkSetLevel({ role, level }) {
  if (role !== 'teacher') {
    return { ok: false, code: 'permission-denied', message: '只有老師可以設定 AI 權限。' };
  }
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    return { ok: false, code: 'invalid-argument', message: 'AI 權限必須是 0–3 的整數。' };
  }
  return { ok: true };
}
