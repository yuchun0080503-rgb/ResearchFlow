// permissions.mjs
// 單一事實來源（Single Source of Truth）：角色 → 允許的動作。
// firestore.rules 的邏輯必須與這份表一致；兩邊不一致是最容易出現「前端擋得住、後端擋不住」漏洞的地方，
// 所以這份檔案同時也拿來產生 firestore.rules 測試情境，並在前端用來決定要不要顯示某個按鈕（僅供 UX，不當作安全邊界）。
// Agent 相關的硬限制（AI Level、Token 預算）在 functions/harness.mjs，那邊才是伺服器端真正執行的地方。

// Owner 可以指派給組員的角色。老師（teacher）刻意不在這裡：Owner 不能把組員「改成」老師，
// 老師只能透過老師邀請連結加入。
export const ROLES = ['owner', 'editor', 'viewer'];

// 動作命名對應文件第四章「Owner / Editor / Viewer」權限表
const MATRIX = {
  owner: new Set([
    'project.manageSettings',
    'project.inviteMember',
    'project.removeMember',
    'project.updateMemberRole',
    'canvas.read',
    'canvas.write',
    'agent.execute',
    'evidence.read',
    'researchState.read',
    'agentTrace.read',
  ]),
  editor: new Set([
    'canvas.read',
    'canvas.write',
    'agent.execute',
    'evidence.read',
    'researchState.read',
    'agentTrace.read',
  ]),
  viewer: new Set([
    'canvas.read',
    'evidence.read',
    'researchState.read',
    'agentTrace.read',
  ]),
  // 老師：唯讀檢視進度與 AI 使用歷程，並且是唯一能設定 AI 權限 Level 的角色。
  teacher: new Set([
    'canvas.read',
    'evidence.read',
    'researchState.read',
    'agentTrace.read',
    'project.setAiLevel',
  ]),
};

/**
 * @param {string} role - 'owner' | 'editor' | 'viewer' | 'teacher' | undefined（undefined 代表非該 project 成員）
 * @param {string} action
 * @returns {boolean}
 */
export function can(role, action) {
  if (!role || !MATRIX[role]) return false;
  return MATRIX[role].has(action);
}

export function isValidRole(role) {
  return ROLES.includes(role);
}

// Owner 不可被降級成唯一一位 owner 以外的角色（避免專案變成沒有人能管理）
export function canChangeRole(currentRole, targetUid, ownerUid, newRole, targetRole) {
  if (currentRole !== 'owner') return false;
  if (!isValidRole(newRole)) return false;
  if (targetRole === 'teacher') return false; // 老師的角色不歸 Owner 管
  if (targetUid === ownerUid && newRole !== 'owner') return false; // 不能把自己降級（先轉移 Owner 再降級，MVP 不做轉移流程）
  return true;
}
