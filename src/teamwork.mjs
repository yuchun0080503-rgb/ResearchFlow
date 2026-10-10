// 分工功能的純邏輯（不碰畫面、不碰 Firebase，方便測試）。
//
// 設計原則：系統只做它真的看得到的事，兩種訊號分開、不合併成一個分數。
//   訊號一「畫布活動統計」：客觀、自動。只代表「誰在畫布上建立了什麼」，不叫貢獻度或完成度。
//   訊號二「分工清單」：涵蓋所有類型的工作（含上台報告、海報這種不會在畫布留下痕跡的）。
//                      完成與否由負責人自己勾選，系統不判斷，只記錄是誰在什麼時候標記的。

// 任務類型。onCanvas：這類工作會在畫布上留下痕跡，可以對照畫布活動統計；其餘系統無法驗證。
export const TASK_TYPES = [
  { id: 'research', name: '研究內容', onCanvas: true },
  { id: 'data', name: '資料整理', onCanvas: false },
  { id: 'present', name: '上台報告', onCanvas: false },
  { id: 'poster', name: '海報／簡報製作', onCanvas: false },
  { id: 'other', name: '其他', onCanvas: false },
];
export const typeOf = (id) => TASK_TYPES.find((t) => t.id === id) || TASK_TYPES[TASK_TYPES.length - 1];

// 畫布上算一「項」的東西，以及它歸在哪一類。手寫是一筆一筆存的，同一段字的後續筆畫（hwSub）不重複計算。
const KINDS = ['claim', 'counter', 'evidence', 'question', 'text', 'hand', 'link'];
export const KIND_NAMES = { claim: '論點', counter: '反向觀點', evidence: '證據', question: '待驗證問題', text: '其他文字', hand: '手寫／圖示', link: '關係連線' };
function kindOf(o) {
  if (!o) return null;
  if (o.type === 'link') return 'link';
  if (o.type === 'stroke') return o.hwSub ? null : 'hand';
  if (o.type === 'text') return ['claim', 'counter', 'evidence', 'question'].includes(o.tag) ? o.tag : 'text';
  return null;
}

/**
 * 畫布活動統計：目前畫布上的每一項內容是誰建立的。
 * @param {object[]} objs 畫布物件（by = 建立者）
 * @param {string[]} memberIds 要列出的成員（學生；老師不列）
 * @returns {{total:number, rows:{u:string|null,total:number,share:number,kinds:object}[]}}
 *   rows 依 memberIds 的順序；建立者已經不在小組裡的內容合併成最後一列（u 為 null），有才會出現。
 *   share 是 0–1 的比例（佔畫布上全部項目）。
 */
export function canvasActivity(objs, memberIds) {
  const ids = Array.isArray(memberIds) ? memberIds : [];
  const blank = () => Object.fromEntries(KINDS.map((k) => [k, 0]));
  const map = new Map(ids.map((u) => [u, { u, total: 0, share: 0, kinds: blank() }]));
  const gone = { u: null, total: 0, share: 0, kinds: blank() };
  let total = 0;
  for (const o of Array.isArray(objs) ? objs : []) {
    const k = kindOf(o);
    if (!k) continue;
    const row = map.get(o.by) || gone;
    row.kinds[k]++; row.total++; total++;
  }
  const rows = [...map.values(), ...(gone.total ? [gone] : [])];
  rows.forEach((r) => { r.share = total ? r.total / total : 0; });
  return { total, rows };
}

// 內容太少時比例沒有意義（3 項裡 1 個人做 3 項不代表分工不均），所以要累積到這個數量才提示
export const MIN_ITEMS_FOR_ALERT = 8;
export const SHARE_ALERT = 0.7;

/**
 * 畫布活動的規則式提示。只針對畫布型工作，不代表整組的分工。
 * @returns {{level:'warn'|'info', u:string|null, text:string}[]}（text 裡的 {name} 由畫面換成姓名）
 */
export function canvasAlerts(activity) {
  const rows = (activity?.rows || []).filter((r) => r.u !== null);
  if (rows.length < 2 || (activity?.total || 0) < MIN_ITEMS_FOR_ALERT) return [];
  const out = [];
  for (const r of rows) if (r.share > SHARE_ALERT) out.push({ level: 'warn', u: r.u, text: `畫布上有 ${Math.round(r.share * 100)}% 的內容是 {name} 建立的，畫布型工作比較集中。` });
  for (const r of rows) if (!r.total) out.push({ level: 'info', u: r.u, text: '{name} 目前沒有在畫布上建立內容（可能負責畫布以外的工作）。' });
  return out;
}

/**
 * 每位成員的任務數與已標記完成數，以及沒有人負責的任務數。
 * @param {object[]} tasks {assignee, done}
 */
export function taskSummary(tasks, memberIds) {
  const list = Array.isArray(tasks) ? tasks : [], ids = Array.isArray(memberIds) ? memberIds : [];
  const rows = ids.map((u) => { const mine = list.filter((t) => t.assignee === u); return { u, total: mine.length, done: mine.filter((t) => t.done).length }; });
  return { rows, unassigned: list.filter((t) => !ids.includes(t.assignee)).length, total: list.length };
}

// 分工清單的規則式提示
export function taskAlerts(tasks, memberIds) {
  const s = taskSummary(tasks, memberIds), out = [];
  if (!s.total) return out;
  for (const r of s.rows) if (!r.total) out.push({ level: 'info', u: r.u, text: '{name} 在分工清單上還沒有任務。' });
  if (s.unassigned) out.push({ level: 'info', u: null, text: `有 ${s.unassigned} 項任務還沒有人負責。` });
  return out;
}
