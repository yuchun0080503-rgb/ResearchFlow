// db.mjs — ResearchFlow 的 Firebase 資料層（瀏覽器端用，ES module）
// 用 Google 官方 CDN（gstatic）的 ESM build 載入 Firebase，不需要 npm install；三個模組必須是同一個版本號。researchflow.html 會用動態 import 載入這個檔案。
//
// 這份檔案做「讀寫 Firestore／登入狀態」，以及在執行 Agent（agent-local.mjs）之前做 AI Harness 檢查。
// 整個系統只用 Firebase 免費方案（Auth／Firestore／Hosting），沒有 Cloud Functions、沒有任何 API 金鑰。
// 所有函式都回傳 Promise 或 unsubscribe function，呼叫端（researchflow.html）自己決定何時更新畫面。

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, sendPasswordResetEmail, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, limit, onSnapshot, serverTimestamp, arrayUnion, arrayRemove, increment,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';
import { checkAgentCall } from './harness.mjs';
import * as agent from './agent-local.mjs';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ---------------- Agent（在瀏覽器裡執行，不需要金鑰、不需要後端）----------------
// Agent 的邏輯在 agent-local.mjs（規則式＋OpenAlex 公開資料庫）。這裡負責每次執行前的 AI Harness 檢查：
// 從 Firestore 讀「老師設定的 AI Level」跟「我在這個專案的角色」（不是相信畫面上的值），
// 交給 harness.mjs 判斷；被拒絕時寫一筆「權限」歷程再丟出錯誤，err.message 就是給使用者看的說明。
// AI Level 本身由 firestore.rules 保護：只有老師改得動。

async function guard(projectId, action) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('請先登入後再使用 Agent。');
  const [project, member] = await Promise.all([
    getDoc(doc(db, 'projects', projectId)),
    getDoc(doc(db, 'projects', projectId, 'members', uid)),
  ]);
  const verdict = checkAgentCall({ role: member.data()?.role, aiLevel: project.data()?.aiLevel, action });
  if (!verdict.ok) {
    await addTrace(projectId, { w: 'Harness', x: verdict.message, k: 'sys' }, uid).catch(() => {});
    throw new Error(verdict.message);
  }
  return uid;
}
const agentLog = (projectId, uid, x) => addTrace(projectId, { w: 'Agent', x, k: 'ai' }, uid).catch(() => {});

// items: [{type:'text'|'stroke', text, tag}] → {tooBroad, reasons, clarifyingQuestions:[{key,question,options}], topic, draftQuestion}
export async function analyzeScope(projectId, items) {
  const uid = await guard(projectId, 'analyzeScope');
  const out = agent.analyzeScope(items);
  await agentLog(projectId, uid, out.tooBroad ? `判斷研究範圍需要先聚焦，提出 ${out.clarifyingQuestions.length} 個引導式問題。` : '判斷研究範圍已足夠聚焦。');
  return out;
}

// answers: [{key, question, answer}]；ownQuestion 有值代表學生自己寫研究問題 → {researchQuestion, keywords, strategy}
export async function proposeQuestion(projectId, { items, answers, ownQuestion }) {
  const uid = await guard(projectId, ownQuestion ? 'proposeKeywords' : 'proposeQuestion');
  const out = agent.proposeQuestion({ items, answers, ownQuestion });
  await agentLog(projectId, uid, ownQuestion ? '依學生自行撰寫的 Research Question 產生關鍵字草案。' : '產生 Research Question 與關鍵字草案。');
  return out;
}

// round：第幾輪（從 0 開始；主張論證模式傳 'counter' 代表學生要求的反面例證）；keywords：小組目前確認的關鍵字；
// mode：'procon' 正反例證／'claim' 主張論證 → {evidence, held, queries, scanned}
// 主張論證模式的一般搜尋不提供反面例證：初步分類為「反向／限制」的文獻放在 held（先保留、不顯示），不放進 evidence。
// keywords 是英文關鍵字（搜尋國際文獻），keywordsZh 是中文關鍵字（直接搜尋中文文獻）；兩者至少要有一個。
export async function searchEvidence(projectId, { keywords, keywordsZh, round, excludeIds, mode }) {
  const uid = await guard(projectId, 'searchEvidence');
  const { kind, queries } = agent.buildQueries(keywords, round, mode);
  const zhQueries = agent.buildQueriesZh(keywordsZh, round, mode);
  const out = await agent.searchEvidence({ queries, kind, keywords, excludeIds, zhQueries, keywordsZh });
  const sup = out.evidence.filter((e) => e.k === 's').length;
  if (mode === 'claim' && round !== 'counter') {
    const held = out.evidence.filter((e) => e.k !== 's');
    await agentLog(projectId, uid, `主張論證模式第 ${round + 1} 輪搜尋 OpenAlex：找到 ${sup} 篇支持主張的文獻（待小組確認）；另有 ${held.length} 篇看法可能不同，先保留不顯示。`);
    return { ...out, evidence: out.evidence.filter((e) => e.k === 's'), held };
  }
  await agentLog(projectId, uid, mode === 'claim'
    ? `應學生要求搜尋反面例證（參考用）：找到 ${out.scanned} 篇，其中 ${out.scanned - sup} 篇初步分類為反向／限制。`
    : `正反例證模式第 ${round + 1} 輪搜尋 OpenAlex：找到 ${out.scanned} 篇，初步分類為支持 ${sup} 篇、反向／限制 ${out.scanned - sup} 篇（待小組確認）。`);
  return { ...out, held: [] };
}

export async function summarizeEvidence(projectId, { evidence }) {
  const uid = await guard(projectId, 'summarizeEvidence');
  const summary = agent.summarizeEvidence(evidence);
  await agentLog(projectId, uid, '產生證據摘要（Level 3）。');
  return { summary };
}

// 一定會被拒絕（guard 會留下歷程紀錄）：ResearchFlow 不代替學生完成整份報告。
export async function generateReport(projectId) {
  await guard(projectId, 'generateReport');
}

// 老師設定 AI 權限。規則只允許老師改 aiLevel 這一個欄位，其他人呼叫會被 Firestore 拒絕。
export async function setAiLevel(projectId, level, who) {
  await updateDoc(doc(db, 'projects', projectId), { aiLevel: level });
  await addTrace(projectId, { w: who || '老師', x: `將 AI 權限設定為 Level ${level}。`, k: 'sys' }, auth.currentUser.uid).catch(() => {});
  return { level };
}

// ---------------- Auth ----------------

// 電子郵件＋密碼登入。密碼由 Firebase Authentication 保管（雜湊後儲存在 Google 的伺服器），
// 不會經過也不會存進 ResearchFlow 自己的資料庫或程式碼。
export function signInEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

// 註冊新帳號，並把顯示名稱寫進 Firebase 的使用者資料（沒填就用信箱 @ 前面的部分）。
export async function registerEmail(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName: displayName || email.split('@')[0] });
  return cred;
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

// Firebase 的錯誤代碼 → 給使用者看的中文說明
export function authErrorText(err) {
  const map = {
    'auth/invalid-email': '電子郵件格式不正確。',
    'auth/missing-email': '請輸入電子郵件。',
    'auth/missing-password': '請輸入密碼。',
    'auth/weak-password': '密碼至少需要 6 個字元。',
    'auth/email-already-in-use': '這個電子郵件已經註冊過了，請直接登入。',
    'auth/invalid-credential': '電子郵件或密碼不正確；如果還沒有帳號，請按「註冊新帳號」。',
    'auth/user-not-found': '找不到這個帳號，請先註冊。',
    'auth/wrong-password': '密碼不正確。',
    'auth/too-many-requests': '嘗試次數過多，請稍後再試。',
    'auth/network-request-failed': '網路連線失敗，請檢查網路後再試。',
    'auth/operation-not-allowed': 'Firebase 專案尚未啟用「電子郵件／密碼」登入方式。',
  };
  return map[err?.code] || err?.message || String(err);
}

export function signOutUser() {
  return signOut(auth);
}

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

// 第一次登入時，把帳號資訊寫成 ResearchFlow 自己的 user profile（對應文件第三章）。
// 回傳目前的 profile；displayName／color 如果使用者在「個人檔案設定」改過，就以改過的為準。
export async function ensureUserProfile(firebaseUser) {
  const ref = doc(db, 'users', firebaseUser.uid);
  const snap = await getDoc(ref);
  const prev = snap.exists() ? snap.data() : {};
  const profile = {
    displayName: prev.displayName || firebaseUser.displayName || firebaseUser.email || '使用者',
    color: prev.color || '',
    photoURL: firebaseUser.photoURL || '',
    email: firebaseUser.email || '',
  };
  await setDoc(ref, { ...profile, updatedAt: serverTimestamp(), ...(snap.exists() ? {} : { createdAt: serverTimestamp() }) }, { merge: true });
  return profile;
}

// 個人檔案設定：更新 users/{uid}，並把新的名稱／顏色同步到自己在各專案的 member 文件（組員看到的是 member 文件）。
export async function updateMyProfile(uid, { displayName, color }, projectIds = []) {
  await setDoc(doc(db, 'users', uid), { displayName, color, updatedAt: serverTimestamp() }, { merge: true });
  await Promise.all(projectIds.map((pid) => updateDoc(doc(db, 'projects', pid, 'members', uid), { displayName, color })));
}

// ---------------- Projects ----------------

// profile: {displayName, email, color}——寫進 member 文件，組員列表才看得到名字
export async function createProject({ name, course, teacherReq, dueDate, field }, uid, profile = {}) {
  const ref = await addDoc(collection(db, 'projects'), {
    name: name || '未命名研究',
    course: course || '',
    teacherReq: teacherReq || '',
    dueDate: dueDate || null,
    field: field || '',
    ownerUid: uid,
    memberUids: [uid],
    aiLevel: 2, // 預設 Thinking Assistant；之後只有老師改得動（firestore.rules）
    searchMode: '', // 預設查證模式：建立後由 Owner 在小視窗選擇（'procon' 正反例證／'claim' 主張論證）
    createdAt: serverTimestamp(),
  });
  // Owner 的 member 文件跟 project 分兩次寫入（非 batch）：規則要先看到 project.ownerUid 才允許建立 owner 的 member 文件。
  await setDoc(doc(db, 'projects', ref.id, 'members', uid), {
    role: 'owner',
    task: '統整研究問題',
    displayName: profile.displayName || '',
    email: profile.email || '',
    color: profile.color || '',
    joinedAt: serverTimestamp(),
  });
  return ref.id;
}

// 即時訂閱「我的研究」列表。回傳 unsubscribe function。
export function subscribeMyProjects(uid, onChange, onError) {
  const q = query(collection(db, 'projects'), where('memberUids', 'array-contains', uid));
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  );
}

export function subscribeProject(projectId, onChange, onError) {
  return onSnapshot(doc(db, 'projects', projectId), (snap) => {
    onChange(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  }, onError);
}

// 一次性讀取（不訂閱）：給「我的研究」列表畫每張卡片的成員頭像用，避免為每個 project 開一條常駐監聽。
export async function getMembers(projectId) {
  const snap = await getDocs(collection(db, 'projects', projectId, 'members'));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

export function subscribeMembers(projectId, onChange, onError) {
  return onSnapshot(collection(db, 'projects', projectId, 'members'), (snap) => {
    onChange(snap.docs.map((d) => ({ uid: d.id, ...d.data() })));
  }, onError);
}

// 刪除整份研究（只有 Owner 做得到，規則會檢查）。Firestore 刪掉 project 文件不會連帶刪掉底下的子集合，所以要自己逐一刪：
//   1. 先把 project 標成 deleting——規則只有在這個狀態下才允許刪除研究歷程與老師的成員文件，組員的列表也會立刻隱藏它
//   2. 刪畫布物件、研究狀態、邀請、研究歷程、其他成員
//   3. 刪 project 文件（此時我還是 Owner）；最後才刪自己的成員文件（規則允許「專案已不存在時刪掉自己」）
// 中途失敗的話 project 會停在 deleting，Owner 下次登入時前端會自動再呼叫一次把它刪完。
export async function deleteProject(projectId, uid) {
  const ref = doc(db, 'projects', projectId);
  await updateDoc(ref, { deleting: true });
  const wipe = async (name, keep = () => false) => {
    const snap = await getDocs(collection(db, 'projects', projectId, name));
    const targets = snap.docs.filter((d) => !keep(d));
    for (let i = 0; i < targets.length; i += 50) await Promise.all(targets.slice(i, i + 50).map((d) => deleteDoc(d.ref)));
  };
  await wipe('objects');
  await wipe('researchState');
  await wipe('invites');
  await wipe('agentTrace');
  await wipe('members', (d) => d.id === uid);
  await deleteDoc(ref);
  await deleteDoc(doc(db, 'projects', projectId, 'members', uid));
}

export async function updateProjectSettings(projectId, fields) {
  await updateDoc(doc(db, 'projects', projectId), fields);
}

// ---------------- Members / Invites ----------------

// Owner 產生邀請：token 當文件 id，前端把連結組成 https://你的網域/?join=projectId:token。
// role: 'editor' | 'viewer' | 'teacher'；email／task 只是備註，兌換時 task 會帶進 member 文件。
export async function createInvite(projectId, role = 'editor', { email = '', task = '' } = {}) {
  const token = cryptoRandomToken();
  await setDoc(doc(db, 'projects', projectId, 'invites', token), {
    role,
    email,
    task,
    status: 'pending',
    createdAt: serverTimestamp(),
  });
  return token;
}

// 被邀請者點連結、登入後呼叫：先把自己加進 members（規則會檢查 invite 是否有效），
// 再把 invite 標記為已兌換，最後把自己加進 project.memberUids。
// 回傳 'joined'；如果本來就是成員（重複點同一個連結）回傳 'already'，不會重複寫入。
export async function redeemInvite(projectId, token, uid, profile = {}) {
  const memberRef = doc(db, 'projects', projectId, 'members', uid);
  // 非成員讀自己的 member 文件會被規則擋下（permission-denied），那就代表「還不是成員」，繼續往下兌換。
  const already = await getDoc(memberRef).then((s) => s.exists(), () => false);
  if (already) return 'already';

  const inviteRef = doc(db, 'projects', projectId, 'invites', token);
  const inviteSnap = await getDoc(inviteRef);
  if (!inviteSnap.exists() || inviteSnap.data().status !== 'pending') {
    throw new Error('邀請連結無效或已被使用過。');
  }
  const invite = inviteSnap.data();

  await setDoc(memberRef, {
    role: invite.role,
    task: invite.task || '',
    displayName: profile.displayName || '',
    email: profile.email || '',
    color: profile.color || '',
    inviteToken: token, // 規則用這個欄位去比對 invite 是否存在、角色是否相符
    joinedAt: serverTimestamp(),
  });
  await updateDoc(inviteRef, { status: 'redeemed', redeemedBy: uid });
  await updateDoc(doc(db, 'projects', projectId), { memberUids: arrayUnion(uid) });
  return 'joined';
}

// Owner 修改組員的角色與負責內容（role: 'owner'|'editor'|'viewer'；老師的文件規則不允許 Owner 修改）
export async function updateMember(projectId, targetUid, { role, task }) {
  await updateDoc(doc(db, 'projects', projectId, 'members', targetUid), { role, task: task || '' });
}

export async function removeMember(projectId, targetUid) {
  await deleteDoc(doc(db, 'projects', projectId, 'members', targetUid));
  // 同步從 memberUids 移除，這個專案才會從對方的「我的研究」列表消失。
  await updateDoc(doc(db, 'projects', projectId), { memberUids: arrayRemove(targetUid) });
}

// ---------------- Canvas Objects ----------------

// 事件式同步用：本地畫布物件的 id 直接當 Firestore 文件 id，同一個物件無論建立或更新都是同一份文件。
// merge:false 代表整份覆蓋，因為呼叫端（researchflow.html）每次都會送出該物件完整的目前狀態，不是部分欄位的 patch。
export async function setCanvasObject(projectId, objectId, data, uid) {
  await setDoc(doc(db, 'projects', projectId, 'objects', String(objectId)), {
    ...data,
    lastEditedBy: uid,
    updatedAt: serverTimestamp(),
  }, { merge: false });
}

export async function deleteCanvasObject(projectId, objectId) {
  await deleteDoc(doc(db, 'projects', projectId, 'objects', String(objectId)));
}

export function subscribeCanvasObjects(projectId, onChange, onError) {
  return onSnapshot(collection(db, 'projects', projectId, 'objects'), (snap) => {
    onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, onError);
}

// ---------------- Research State（小組共用的 Agent 流程狀態）----------------
// researchState/current：{json}——整份流程狀態（步驟、研究問題、Evidence Map…）序列化成字串存放，
//   因為裡面有「陣列中的陣列」（每一輪的查詢），Firestore 不能直接存。
// researchState/canvas：{ver}——共用的 Canvas 版本號，Agent 用它判斷「上次分析之後畫布有沒有新修改」。


// onChange({current, canvas, usage})：三份文件一次給，哪一份不存在就是 undefined。
export function subscribeResearchState(projectId, onChange, onError) {
  return onSnapshot(collection(db, 'projects', projectId, 'researchState'), (snap) => {
    const out = {};
    snap.docs.forEach((d) => { out[d.id] = d.data(); });
    onChange(out);
  }, onError);
}

export async function saveResearchState(projectId, json, uid) {
  await setDoc(doc(db, 'projects', projectId, 'researchState', 'current'), { json, updatedBy: uid, updatedAt: serverTimestamp() });
}

export async function bumpCanvasVersion(projectId) {
  await setDoc(doc(db, 'projects', projectId, 'researchState', 'canvas'), { ver: increment(1) }, { merge: true });
}

// ---------------- Agent Trace（研究歷程）----------------

// k：'user' 學生操作／'sync' 畫布同步／'ai' Agent 產生的內容／'sys' 權限相關。規則要求 uid 必須是自己，且紀錄寫入後不能修改或刪除。
export async function addTrace(projectId, { w, x, k }, uid) {
  await addDoc(collection(db, 'projects', projectId, 'agentTrace'), { w, x, k, uid, at: serverTimestamp() });
}

// 最近 200 筆，新的在前。at 會被轉成毫秒數（本地剛寫入、伺服器時間還沒回來時用估計值）。
export function subscribeTrace(projectId, onChange, onError) {
  const q = query(collection(db, 'projects', projectId, 'agentTrace'), orderBy('at', 'desc'), limit(200));
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => {
      const data = d.data({ serverTimestamps: 'estimate' });
      return { w: data.w, x: data.x, k: data.k, at: data.at?.toMillis ? data.at.toMillis() : Date.now() };
    }));
  }, onError);
}

// ---------------- util ----------------

function cryptoRandomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
