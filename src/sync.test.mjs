import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRemoteObj, fromRemoteObj, mergeRemoteDocs, diffForPush, sameObjList } from './sync.mjs';

test('toRemoteObj：pts（陣列中的陣列）轉成 Firestore 可接受的 [{x,y,t}] 格式', () => {
  const o = { id: 1, type: 'stroke', by: 'A', w: 3, pts: [[1, 2, 100], [3, 4, 200]] };
  const r = toRemoteObj(o);
  assert.equal(r.id, undefined, 'id 不應該寫進文件內容（id 本身就是文件路徑）');
  assert.deepEqual(r.pts, [{ x: 1, y: 2, t: 100 }, { x: 3, y: 4, t: 200 }]);
});

test('toRemoteObj：缺少 t（例如文字物件沒有 pts）時不會爛掉，且會丟掉 undefined 欄位', () => {
  const o = { id: 2, type: 'text', by: 'A', x: 5, y: 6, text: 'hi', group: undefined };
  const r = toRemoteObj(o);
  assert.equal('group' in r, false, 'undefined 欄位應該被丟掉，否則 Firestore 會拒絕寫入');
  assert.equal(r.text, 'hi');
});

test('fromRemoteObj：還原 pts 為陣列的陣列，並補回 id，且丟掉伺服器中繼資料欄位', () => {
  const d = { type: 'stroke', by: 'A', w: 3, pts: [{ x: 1, y: 2, t: 100 }], lastEditedBy: 'A', updatedAt: 'SERVER_TS', createdAt: 'SERVER_TS', version: 4 };
  const o = fromRemoteObj('doc123', d);
  assert.equal(o.id, 'doc123');
  assert.deepEqual(o.pts, [[1, 2, 100]]);
  assert.equal('lastEditedBy' in o, false);
  assert.equal('updatedAt' in o, false);
  assert.equal('createdAt' in o, false);
  assert.equal('version' in o, false);
});

test('toRemoteObj → fromRemoteObj 來回轉換：內容要能還原（round-trip）', () => {
  const o = { id: 99, type: 'stroke', by: 'B', mod: 'B', ver: 2, w: 3, tag: 'claim', ts: 1000, pts: [[10, 20, 1], [30, 40, 2], [50, 60, 3]] };
  const remote = toRemoteObj(o);
  const back = fromRemoteObj(String(o.id), remote);
  assert.deepEqual(back.pts, o.pts);
  assert.equal(back.type, o.type);
  assert.equal(back.tag, o.tag);
  assert.equal(back.ts, o.ts);
});

test('mergeRemoteDocs：依 ts 排序，確保多人同時寫入時疊放順序穩定', () => {
  const docs = [
    { id: 'c', type: 'text', ts: 300 },
    { id: 'a', type: 'text', ts: 100 },
    { id: 'b', type: 'text', ts: 200 },
  ];
  const objs = mergeRemoteDocs(docs);
  assert.deepEqual(objs.map((o) => o.id), ['a', 'b', 'c']);
});

test('mergeRemoteDocs：ts 相同時用 id 字串排序，結果穩定不隨機', () => {
  const docs = [
    { id: 'z', type: 'text', ts: 100 },
    { id: 'a', type: 'text', ts: 100 },
  ];
  const objs = mergeRemoteDocs(docs);
  assert.deepEqual(objs.map((o) => o.id), ['a', 'z']);
});

test('diffForPush：全新物件（pushedMap 裡沒有）要被列為 upsert', () => {
  const local = [{ id: 1, type: 'text', text: 'a' }];
  const { upserts, deletes } = diffForPush(local, new Map());
  assert.equal(upserts.length, 1);
  assert.equal(deletes.length, 0);
});

test('diffForPush：內容沒變的物件不會重複送出（避免事件式同步變成每次都整包送）', () => {
  const local = [{ id: 1, type: 'text', text: 'a' }];
  const pushed = new Map([[1, JSON.stringify(local[0])]]);
  const { upserts, nextPushed } = diffForPush(local, pushed);
  assert.equal(upserts.length, 0, '未變更的物件不應該出現在 upserts');
  assert.equal(nextPushed.get(1), JSON.stringify(local[0]));
});

test('diffForPush：物件內容變更後要被列為 upsert', () => {
  const before = { id: 1, type: 'text', text: 'a' };
  const pushed = new Map([[1, JSON.stringify(before)]]);
  const after = { id: 1, type: 'text', text: 'a（已編輯）' };
  const { upserts } = diffForPush([after], pushed);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].text, 'a（已編輯）');
});

test('diffForPush：本地刪除的物件（曾經推送過，現在 local 已經沒有）要被列為 delete', () => {
  const pushed = new Map([[1, '{}'], [2, '{}']]);
  const { deletes, upserts } = diffForPush([{ id: 2, type: 'text', text: 'still here' }], pushed);
  assert.deepEqual(deletes, [1]);
  assert.equal(upserts.length, 1, '物件 2 的 JSON 跟 pushed 裡存的不一樣（pushed 存的是假資料 "{}"），所以仍算變更');
});

test('diffForPush：全部物件都刪除時，deletes 包含所有先前推送過的 id', () => {
  const pushed = new Map([[1, '{}'], [2, '{}'], [3, '{}']]);
  const { deletes, upserts } = diffForPush([], pushed);
  assert.deepEqual(deletes.sort(), [1, 2, 3]);
  assert.equal(upserts.length, 0);
});

test('sameObjList：內容相同但屬性插入順序不同（本地新建 vs 從 Firestore 還原）仍判定為相同', () => {
  // 模擬 mkO() 建立的本地物件（id 在中間）跟 fromRemoteObj() 還原的物件（id 補在最後）
  const local = { mod: 'A', ver: 1, tag: '', id: 'A_1', type: 'text', by: 'A', x: 1, y: 2, text: 'hi' };
  const fromRemote = { type: 'text', by: 'A', x: 1, y: 2, text: 'hi', mod: 'A', ver: 1, tag: '', id: 'A_1' };
  assert.equal(sameObjList([local], [fromRemote]), true);
});

test('sameObjList：陣列順序不同但內容相同（依 id 比對，不管位置）仍判定為相同', () => {
  const a = [{ id: 1, text: 'x' }, { id: 2, text: 'y' }];
  const b = [{ id: 2, text: 'y' }, { id: 1, text: 'x' }];
  assert.equal(sameObjList(a, b), true);
});

test('sameObjList：這就是修復「復原要按兩次」那個 bug 的關鍵——自己剛寫入又echo回來的內容要能判定為相同', () => {
  // 重現原本的 bug 情境：op() 先把新物件 push 進 p.H（本地 mkO 形狀），
  // 接著 Firestore 的 onSnapshot echo 回來（fromRemoteObj 形狀，屬性順序不同）。
  // 如果 sameObjList 誤判為「不同」，attachLiveObjects 就會多推一筆幾乎一樣的歷史紀錄，
  // 使用者按一次 Ctrl+Z 只會復原到那筆重複紀錄，畫面不會有變化。
  const justAdded = { mod: 'A_1', ver: 1, tag: '', stage: '', group: '', aiRead: '', conf: false, inRQ: false, inKW: false, ans: false, read: false, id: 'A_1_105', ts: 1000, type: 'text', by: 'A_1', x: -10, y: -20, text: 'echo 測試' };
  const echoed = fromRemoteObj('A_1_105', toRemoteObj(justAdded));
  assert.equal(sameObjList([justAdded], [echoed]), true, 'echo 回來的內容應該判定為跟剛寫入的內容相同，不應該產生多一筆復原紀錄');
});

test('sameObjList：內容真的不同（例如文字被改了）要判定為不同，確保別人的修改仍然會進入復原歷史', () => {
  const a = [{ id: 1, text: 'before' }];
  const b = [{ id: 1, text: 'after' }];
  assert.equal(sameObjList(a, b), false);
});

test('sameObjList：數量不同要判定為不同', () => {
  assert.equal(sameObjList([{ id: 1 }], [{ id: 1 }, { id: 2 }]), false);
});
