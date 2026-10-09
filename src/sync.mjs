// sync.mjs — 畫布物件的事件式同步：純資料轉換／diff 邏輯（不含任何 Firestore 呼叫）。
// 這裡的邏輯會「手動鏡像」進 researchflow.html 的 inline <script>（因為那段是 classic script，
// 不能直接 import 這個 ES module）。改這份檔案時，記得同步修改 researchflow.html 裡對應的函式，
// 跟 permissions.mjs ↔ firestore.rules 的關係一樣：這裡是可測試的「單一真相來源」。
//
// 設計原則（對應文件第 7、8、9 章「事件式同步」）：
//  - 畫布上的互動（畫完一筆、放開拖曳、編輯完文字…）已經由既有的 op() 統一收斂成「一次完成的操作」，
//    所以同步也在同一個收斂點做：比較目前 p.objs 跟「上次已經送出去的版本」，只送有變化的物件，
//    而不是每個 pointermove 都送。
//  - Firestore 不支援「陣列中的陣列」，所以 pts/orig（[[x,y,t],...]）要轉成 [{x,y,t},...] 才能寫入，
//    讀回來要轉回去，畫布其他程式碼才不用全部改寫。
//  - 本地物件 id 用來當 Firestore 文件 id（字串化），同一個物件無論建立/更新都是同一個文件，
//    不會因為 addDoc 另外產生一個新 id 而跟本地狀態對不起來。

export function toRemoteObj(o) {
  const c = { ...o };
  delete c.id;
  if (Array.isArray(c.pts)) c.pts = c.pts.map(([x, y, t]) => ({ x, y, t: t || 0 }));
  if (Array.isArray(c.orig)) c.orig = c.orig.map(([x, y, t]) => ({ x, y, t: t || 0 }));
  // JSON round-trip：丟掉 undefined 欄位（Firestore 不接受 undefined），其餘原樣保留。
  return JSON.parse(JSON.stringify(c));
}

export function fromRemoteObj(id, d) {
  const o = { ...d, id };
  if (Array.isArray(o.pts)) o.pts = o.pts.map((pt) => [pt.x, pt.y, pt.t || 0]);
  if (Array.isArray(o.orig)) o.orig = o.orig.map((pt) => [pt.x, pt.y, pt.t || 0]);
  // 這些是 db.mjs 的 setCanvasObject 額外寫入的伺服器端中繼資料欄位，不屬於畫布物件本身的欄位。
  delete o.lastEditedBy;
  delete o.updatedAt;
  delete o.createdAt;
  delete o.createdBy;
  delete o.version;
  return o;
}

// docs: [{id, ...fields}, ...]（Firestore 文件快照）→ 還原成畫布用的 objs 陣列。
// 用 ts（建立時的 client timestamp，見 researchflow.html 的 mkO）排序，避免多個使用者同時寫入時
// Firestore 回來的文件順序不固定，導致畫布疊放順序（z-order）每次重新整理都不一樣。
// 這是 MVP 的簡化排序：用 client 時間排序在時鐘誤差很大時可能跟真正建立順序不完全一致，
// 但比完全不排序（讓順序隨機跳動）好，且不需要額外的 Firestore 複合索引。
export function mergeRemoteDocs(docs) {
  const objs = docs.map((d) => fromRemoteObj(d.id, d));
  objs.sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)));
  return objs;
}

// 比較「目前本地畫布狀態」跟「上次已經推送到 Firestore 的狀態」，算出這次要送出的變更。
// localObjs: 目前的 p.objs；pushedMap: Map(id -> 上次推送時的 JSON.stringify(o))。
// 回傳 upserts（要新增/更新的物件）、deletes（要刪除的 id）、nextPushed（更新後的 pushedMap 內容，
// 呼叫端自己決定要不要真的覆蓋成這個新 Map——通常是要的，這樣下次才知道哪些已經同步過）。
function canonical(o) {
  // JSON.stringify(value, keyArray) 會依照 keyArray 給的順序輸出，所以用排序過的 key 當 replacer，
  // 得到跟物件原本屬性插入順序無關的字串——用來判斷「內容是不是一樣」，不是「物件是不是同一個 reference」。
  return JSON.stringify(o, Object.keys(o).sort());
}

// 判斷兩份畫布物件陣列的內容是否完全相同（不看陣列順序，只看每個 id 對應的內容）。
// 用在：收到 Firestore 的 onSnapshot 更新時，先確認這不是「我們自己剛寫入、現在原樣回彈」的 echo，
// 避免把一次使用者操作，在復原歷史（p.H）裡記成兩筆幾乎一樣的紀錄，導致按一次「返回上一個操作」
// 畫面卻好像沒有變化（要按兩次才看到效果）。
export function sameObjList(a, b) {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((o) => [o.id, o]));
  for (const oa of a) {
    const ob = byId.get(oa.id);
    if (!ob || canonical(oa) !== canonical(ob)) return false;
  }
  return true;
}

export function diffForPush(localObjs, pushedMap) {
  const nextPushed = new Map();
  const upserts = [];
  for (const o of localObjs) {
    const j = JSON.stringify(o);
    nextPushed.set(o.id, j);
    if (pushedMap.get(o.id) !== j) upserts.push(o);
  }
  const deletes = [];
  for (const id of pushedMap.keys()) {
    if (!nextPushed.has(id)) deletes.push(id);
  }
  return { upserts, deletes, nextPushed };
}
