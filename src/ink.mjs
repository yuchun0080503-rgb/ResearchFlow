// ink.mjs — 自動偵測畫布上的手寫內容：圖示（圓圈、方框、箭頭、直線、底線）與手寫文字。
//
// 圖示：純幾何判斷，在瀏覽器裡完成，不連網。判斷出形狀之後，再看它跟畫布上其他內容的位置關係，
//       轉成 Agent 讀得懂的一句話（圈選了什麼、箭頭從哪裡指到哪裡、底線強調了哪一句）。
// 手寫文字：把筆畫座標送到 Google Input Tools 的手寫辨識服務（免費、不需要金鑰、支援繁體中文與英文）。
//       這是 Google 輸入法網頁版使用的公開端點，但不是有服務保證的正式 API；連不上時會安靜地退回手動輸入。
// 所有偵測結果都只是「AI 讀取：…（待確認）」，要經過小組確認才會被 Agent 當成研究內容。

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLen = (pts, from = 0, to = pts.length - 1) => {
  let n = 0;
  for (let i = from + 1; i <= to; i++) n += dist(pts[i - 1], pts[i]);
  return n;
};
export function boxOf(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Ramer–Douglas–Peucker：把筆畫簡化成幾個轉折點，用來數「有幾個角」
function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1], len = dist(a, b) || 1;
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / len;
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= eps) return [a, b];
  return [...simplify(pts.slice(0, at + 1), eps).slice(0, -1), ...simplify(pts.slice(at), eps)];
}

// 太小的筆畫一律當成文字的一部分（「口」「一」「O」這些字長得跟圖示一樣，只能靠大小區分）
const MIN_CLOSED = 70, MIN_LINE = 90;

/**
 * 單一筆畫的形狀判斷。
 * @param {number[][]} pts [[x,y,t?],...]
 * @returns {null | {kind:'circle'|'rect'|'triangle'|'enclosure'|'line'|'underline'|'arrow', from?:number[], to?:number[], box:{x,y,w,h}}}
 */
export function classifyStroke(pts) {
  if (!Array.isArray(pts) || pts.length < 4) return null;
  const box = boxOf(pts), diag = Math.hypot(box.w, box.h), len = pathLen(pts);
  if (diag < 8) return null;
  const first = pts[0], last = pts[pts.length - 1];

  if (dist(first, last) < Math.max(0.25 * diag, 14) && len > 1.9 * diag) { // 封閉圖形的周長至少是外框對角線的 2 倍（再扁也一樣）
    if (diag < MIN_CLOSED) return null;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    // 把外框拉成正方形再量每個點到中心的距離：圓／橢圓的距離幾乎固定，方框與三角形的角會突出
    const radii = pts.map((p) => Math.hypot((p[0] - cx) / (box.w / 2 || 1), (p[1] - cy) / (box.h / 2 || 1)));
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
    const dev = Math.sqrt(radii.reduce((s, r) => s + (r - mean) ** 2, 0) / radii.length) / mean;
    const corners = simplify(pts, 0.07 * diag).length - 1;
    const kind = dev < 0.09 ? 'circle' : corners === 3 ? 'triangle' : corners === 4 || corners === 5 ? 'rect' : dev < 0.16 ? 'circle' : 'enclosure';
    return { kind, box };
  }

  if (len < MIN_LINE) return null;
  if (dist(first, last) / len > 0.93) {
    const flat = Math.abs(last[1] - first[1]) < 0.12 * Math.abs(last[0] - first[0]);
    return { kind: flat ? 'underline' : 'line', from: first, to: last, box };
  }
  // 一筆畫完的箭頭：一段直線（箭身），到尖端後折回來畫箭頭
  let tip = 0;
  for (let i = 1; i < pts.length; i++) if (dist(first, pts[i]) > dist(first, pts[tip])) tip = i;
  const shaft = pathLen(pts, 0, tip), head = pathLen(pts, tip);
  if (tip > 1 && dist(first, pts[tip]) / shaft > 0.93 && head > 0.08 * shaft && head < 0.7 * shaft) {
    return { kind: 'arrow', from: first, to: pts[tip], box };
  }
  return null;
}

/**
 * 一次停筆內畫的一組筆畫（1–3 筆）是不是一個圖示。分兩三筆畫的箭頭（箭身＋箭頭）也在這裡處理。
 * @param {number[][][]} strokes
 */
export function classifyGroup(strokes) {
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > 3) return null;
  const main = classifyStroke(strokes[0]);
  if (strokes.length === 1) return main;
  if (!main || (main.kind !== 'line' && main.kind !== 'underline')) return null;
  const shaft = dist(main.from, main.to);
  const rest = strokes.slice(1).map((pts) => ({ box: boxOf(pts), pts }));
  const nearEnd = (end) => rest.every((r) => Math.hypot(r.box.w, r.box.h) < 0.5 * shaft && dist([r.box.x + r.box.w / 2, r.box.y + r.box.h / 2], end) < Math.max(40, 0.25 * shaft));
  const all = boxOf(strokes.flat());
  if (nearEnd(main.to)) return { kind: 'arrow', from: main.from, to: main.to, box: all };
  if (nearEnd(main.from)) return { kind: 'arrow', from: main.to, to: main.from, box: all };
  return null;
}

const NAMES = { circle: '圓圈', rect: '方框', triangle: '三角形', enclosure: '圈選範圍', line: '直線', underline: '橫線', arrow: '箭頭' };
const quote = (s) => `「${String(s).slice(0, 30)}」`;
const gap = (pt, b) => Math.hypot(Math.max(b.x - pt[0], 0, pt[0] - (b.x + b.w)), Math.max(b.y - pt[1], 0, pt[1] - (b.y + b.h)));

/**
 * 把圖示跟畫布上其他內容的位置關係轉成一句話。
 * @param shape classifyStroke／classifyGroup 的結果
 * @param {{label:string, box:{x,y,w,h}}[]} others 畫布上其他有文字意義的物件（文字方塊、已辨識的手寫）
 */
export function describeShape(shape, others = []) {
  const list = others.filter((o) => o && o.label && o.box);
  const b = shape.box;
  if (!shape.from) {
    const inside = list.filter((o) => {
      const cx = o.box.x + o.box.w / 2, cy = o.box.y + o.box.h / 2;
      return cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h;
    });
    return inside.length ? `圈選重點：${inside.map((o) => quote(o.label)).join('')}` : `圖示：${NAMES[shape.kind]}`;
  }
  if (shape.kind === 'underline') {
    const midX = (shape.from[0] + shape.to[0]) / 2, y = (shape.from[1] + shape.to[1]) / 2;
    const above = list.find((o) => midX > o.box.x && midX < o.box.x + o.box.w && y - (o.box.y + o.box.h) > -8 && y - (o.box.y + o.box.h) < 30);
    if (above) return `強調：${quote(above.label)}`;
  }
  const near = (pt) => list.map((o) => ({ o, d: gap(pt, o.box) })).filter((x) => x.d < 60).sort((p, q) => p.d - q.d)[0]?.o;
  const a = near(shape.from), z = near(shape.to);
  if (a && z && a !== z) return shape.kind === 'arrow' ? `關係：${quote(a.label)}→${quote(z.label)}` : `連結：${quote(a.label)}—${quote(z.label)}`;
  if (shape.kind === 'arrow' && z) return `箭頭指向：${quote(z.label)}`;
  return `圖示：${NAMES[shape.kind]}`;
}

// ---------------- 手寫文字辨識 ----------------
//
// 辨識服務對「一次送一整句」的中文表現不好：實測 6 個字以上的詞句常常只認出前半段，筆跡有抖動時更嚴重。
// 一個字一個字分開送出時，逐字正確率高很多。所以流程是：
//   平滑筆畫 → 分行 → 每一行試各種「哪幾筆是同一個字」的切法並分別辨識 → 挑整行最合理的切法 → 用詞庫校正 → 接回一句。
// 英文不能這樣切（一個單字會被切碎），所以如果辨識出來的大多不是中文，就改成整行送出重新辨識。

const INK_URL = 'https://inputtools.google.com/request?itc=zh-t-i0-handwrit&app=researchflow&c=1&num=5';
const TARGET_H = 110; // 送出前把每一段的行高放大／縮小到這個像素數
const CJK = /[㐀-鿿豈-﫿]/;

// 去掉滑鼠／觸控筆的細微抖動：端點不動，中間的點跟前後做加權平均，做兩輪。
export function smoothStroke(pts) {
  let out = pts;
  for (let n = 0; n < 2 && out.length > 4; n++) {
    out = out.map((p, i) => {
      if (i === 0 || i === out.length - 1) return p;
      const a = out[i - 1], b = out[i + 1];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4, p[2]];
    });
  }
  return out;
}

const span = (pts, ax) => { const v = pts.map((p) => p[ax]); return [Math.min(...v), Math.max(...v)]; };

// 把沿某個軸（0=x、1=y）互相重疊的筆畫併成一群，回傳依位置排序的群：[{from,to,strokes}]
function clusters(strokes, ax, slack = 0) {
  const items = strokes.map((pts) => ({ pts, s: span(pts, ax) })).sort((a, b) => a.s[0] - b.s[0]);
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && it.s[0] <= last.to + slack) { last.to = Math.max(last.to, it.s[1]); last.strokes.push(it.pts); }
    else out.push({ from: it.s[0], to: it.s[1], strokes: [it.pts] });
  }
  return out;
}

// 分行：沿垂直於書寫方向的軸找完全沒有筆跡的空白帶。只有夠高的帶才算一行，
// 否則「二」「三」這種筆畫之間本來就有空隙的字會被拆成好幾行。
function splitLines(strokes, ax) {
  const bands = clusters(strokes, ax, 6);
  const tall = bands.filter((b) => b.to - b.from >= 14);
  if (tall.length < 2 || tall.length !== bands.length) return [strokes];
  return bands.map((b) => b.strokes);
}

// 把一段筆畫轉成辨識服務要的格式：每一筆是 [[x...],[y...],[t...]]，座標平移到原點並縮放到固定行高。
export function inkRequest(strokes) {
  const box = boxOf(strokes.flat()), t0 = strokes[0]?.[0]?.[2] || 0;
  const k = Math.min(6, Math.max(0.4, TARGET_H / Math.max(Math.min(box.w, box.h), Math.max(box.w, box.h) / 3, 12)));
  return {
    options: 'enable_pre_space',
    requests: [{
      writing_guide: { writing_area_width: Math.ceil(box.w * k) + 20, writing_area_height: Math.ceil(box.h * k) + 20 },
      ink: strokes.map((pts) => [
        pts.map((p) => Math.round((p[0] - box.x) * k) + 10),
        pts.map((p) => Math.round((p[1] - box.y) * k) + 10),
        pts.map((p, i) => Math.max(0, Math.round((p[2] || t0 + i * 8) - t0))),
      ]),
      language: 'zh_TW',
    }],
  };
}

// 候選字挑選：這是中文研究畫布，所以當第一候選只是一個符號（「+」「~」「□」），而候選清單裡有單一中文字時，
// 改用中文的（「十」「一」「口」）。英文字母只處理最常跟中文搞混的兩組（t↔十、o↔口），其餘照辨識服務的排序。
const LOOKALIKE = { t: '十', T: '十', o: '口', O: '口', 0: '口' };
export function pickCandidate(cands) {
  const list = (Array.isArray(cands) ? cands : []).filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
  if (!list.length) return '';
  const top = list[0];
  if ([...top].length !== 1 || CJK.test(top)) return top;
  if (LOOKALIKE[top]) return list.includes(LOOKALIKE[top]) ? LOOKALIKE[top] : top;
  if (/[A-Za-z0-9]/.test(top)) return top;
  return list.find((c) => [...c].length === 1 && CJK.test(c)) || top;
}

// ---------------- 詞庫校正 ----------------
// 一字一段辨識時，辨識服務看不到前後文，潦草的字常常「正確答案排在第 2、3 候選」。
// 這裡用一份常用詞詞庫（src/lexicon-zh.txt：研究常用詞＋依詞頻排序的 4 萬個中文詞）當對照：
// 在每個字的前幾個候選裡，找出能組成詞庫裡的詞的組合。用到非第一候選要付代價，所以第一候選本身合理時不會被亂改。

let LEX = null; // Map<詞, 名次>，名次越小越常用
export function setLexicon(words) {
  LEX = new Map();
  (Array.isArray(words) ? words : []).forEach((w, i) => { if (w && !LEX.has(w)) LEX.set(w, i); });
}
// 一個詞在常用詞表裡的名次（越小越常用）；不在表裡或詞庫還沒載入時回傳 undefined。給關鍵字抽取用。
export const lexRank = (word) => (LEX ? LEX.get(word) : undefined);
export async function loadLexicon(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`詞庫載入失敗 HTTP ${res.status}`);
  setLexicon((await res.text()).split('\n'));
  return LEX.size;
}

const RANK_COST = 1.5; // 每往後挑一個候選的代價
const wordGain = (word) => { const r = LEX.get(word); return r === undefined ? -Infinity : [...word].length * 2.2 + (r < 5000 ? 1 : r < 20000 ? 0.5 : 0); };

/**
 * 從每一段的候選清單挑出整句最合理的組合。
 * @param {string[][]} candLists 每一段的候選（依辨識服務的排序）
 * @returns {string[]} 每一段選中的字
 */
export function pickSequence(candLists) {
  const tops = candLists.map(pickCandidate);
  if (!LEX || candLists.length < 2) return tops;
  // 只有「第一候選是單一中文字」的段參與組詞；其餘（符號、英數、多個字）固定用第一候選
  const opts = candLists.map((list, i) => {
    if ([...tops[i]].length !== 1 || !CJK.test(tops[i])) return null;
    const seen = new Set([tops[i]]), out = [tops[i]];
    for (const c of list) if ([...c].length === 1 && CJK.test(c) && !seen.has(c) && out.length < 5) { seen.add(c); out.push(c); }
    return out;
  });
  const n = candLists.length, best = new Array(n + 1).fill(0), pick = new Array(n).fill(null);
  for (let i = n - 1; i >= 0; i--) {
    best[i] = best[i + 1]; pick[i] = [tops[i]];
    if (!opts[i]) continue;
    for (let len = 2; len <= 4 && i + len <= n; len++) {
      if (opts.slice(i, i + len).some((o) => !o)) break;
      const walk = (k, chars, cost) => {
        if (cost > 4.5) return;
        if (k === len) {
          const score = wordGain(chars.join('')) - cost + best[i + len];
          if (score > best[i]) { best[i] = score; pick[i] = chars.slice(); }
          return;
        }
        opts[i + k].forEach((c, r) => walk(k + 1, [...chars, c], cost + r * RANK_COST));
      };
      walk(0, [], 0);
    }
  }
  const out = [];
  for (let i = 0; i < n; i += pick[i].length) out.push(...pick[i]);
  return out;
}

// 回應格式：["SUCCESS", [[id, ["候選1","候選2",...], ...]]]
export function parseInkCandidates(json) {
  if (!Array.isArray(json) || json[0] !== 'SUCCESS') return [];
  const list = json[1]?.[0]?.[1];
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim().slice(0, 200)) : [];
}
export const parseInkResponse = (json) => pickCandidate(parseInkCandidates(json));

// 辨識服務偶爾會回傳異體字或簡體字，換成臺灣常用的寫法。
const VARIANTS = Object.fromEntries([
  '閲閱', '査查', '説說', '爲為', '裏裡', '綫線', '衆眾', '麽麼', '啓啟', '强強', '産產', '内內',
  '赖賴', '资資', '学學', '习習', '问問', '题題', '证證', '据據', '响響', '绩績', '认認', '术術', '诚誠', '寻尋',
  '较較', '课課', '线線', '实實', '验驗', '组組', '对對', '调調', '结結', '读讀', '阅閱', '机機', '动動', '体體', '产產', '确確',
].map((pair) => [...pair]));

// 各段接回一句（sep：段與段之間放什麼）：中文字之間不留空白，中文後面的半形標點換成全形。
export function joinText(parts, sep = '') {
  const HALF = { ',': '，', '.': '。', '?': '？', '!': '！', ':': '：', ';': '；', '(': '（', ')': '）' };
  const out = parts.filter(Boolean).join(sep);
  return [...out].map((ch) => VARIANTS[ch] || ch).join('')
    .replace(/([㐀-鿿])\s+(?=[㐀-鿿])/g, '$1')
    .replace(/([㐀-鿿])([,.?!:;()])/g, (m, a, b) => a + HALF[b])
    .slice(0, 200);
}

// 同一段筆畫常常會被重複送出（使用者每多寫一個字，整句就重新辨識一次），所以把結果記起來。
const cache = new Map();
export function _clearInkCache() { cache.clear(); }
const keyOf = (chunk) => chunk.map((pts) => `${pts.length}:${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)},${pts[pts.length - 1][0].toFixed(1)},${pts[pts.length - 1][1].toFixed(1)}`).join('|');

async function ask(chunk, fetchImpl) {
  const key = keyOf(chunk);
  if (cache.has(key)) return cache.get(key);
  const res = await fetchImpl(INK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inkRequest(chunk)) });
  if (!res.ok) throw new Error(`手寫辨識服務 HTTP ${res.status}`);
  const cands = parseInkCandidates(await res.json());
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  cache.set(key, cands);
  return cands;
}

// 一次最多同時送出幾個請求（免費的公開服務，不要一口氣灌太多）
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const byTime = (chunk) => chunk.slice().sort((a, b) => (a[0][2] || 0) - (b[0][2] || 0));

// 切段評分的參數（用合成的工整到潦草筆跡調出來的，見 README 的驗證說明）
const TUNE = { base: 4, other: 1, narrow: 8, wide: 2, seg: 1, pair: 1.5, multi: 1 };
export function _tune(patch) { Object.assign(TUNE, patch); return TUNE; }

// 一個候選切段的分數。中文字大約是正方形（寬 ≈ 行高），所以辨識成「一個字」而且寬度接近一個字的切段分數最高；
// 太窄（多半是偏旁或一點一撇）、太寬（吃到隔壁字的一部分）都扣分；每多切一段也有固定成本，避免把一個字切成兩半各自成字。
function segScore(top, ratio) {
  const chars = [...top];
  if (!chars.length) return -6;
  const zh = chars.filter((c) => CJK.test(c)).length;
  const shape = (r) => -TUNE.narrow * Math.max(0, 0.9 - r) - TUNE.wide * Math.max(0, r - 1.15);
  if (chars.length === 1) return (zh ? TUNE.base : TUNE.other) + shape(ratio) - TUNE.seg;
  const each = ratio / chars.length;
  return chars.length * ((zh === chars.length ? TUNE.base : TUNE.other) + shape(each) - TUNE.seg) - TUNE.multi;
}

/**
 * 辨識一行手寫：真人寫字的字距、大小都不固定，沒辦法只靠空隙決定哪裡是字的邊界，
 * 所以把相鄰的筆畫群試著合成各種可能的「一個字」，每一種都送去辨識，再挑出整行分數最高的切法
 * （相鄰兩個字能組成詞庫裡的詞會加分）。
 * @returns {Promise<string[][]>} 依閱讀順序，每個字（段）的候選清單
 */
async function recognizeLine(line, ax, fetchImpl) {
  const cross = span(line.flat(), 1 - ax), along = span(line.flat(), ax);
  const H = Math.max(cross[1] - cross[0], 12);
  // 先把「合起來還不到一個字寬、而且靠得很近」的相鄰筆畫群併起來（左右結構的字：認＝言＋忍），
  // 之後各種切法只會在這些群的邊界下刀，不會把一個寫得緊湊的字切成兩半。
  const atoms = [];
  for (const g of clusters(line, ax)) {
    const last = atoms[atoms.length - 1];
    if (last && g.to - last.from <= 1.15 * H && g.from - last.to < 0.2 * H) { last.to = g.to; last.strokes.push(...g.strokes); }
    else atoms.push({ ...g, strokes: g.strokes.slice() });
  }
  if (atoms.length === 1 || along[1] - along[0] <= 1.25 * H) return [await ask(byTime(line), fetchImpl)];
  const segs = [];
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i; j < atoms.length && j < i + 12; j++) { // 一個字可能由很多互不重疊的筆畫群組成（「性」的豎心旁、直書時的每一橫）
      const width = atoms[j].to - atoms[i].from;
      if (j > i && width > 1.6 * H) break;
      segs.push({ i, j, ratio: width / H, strokes: byTime(atoms.slice(i, j + 1).flatMap((a) => a.strokes)) });
    }
  }
  const cands = await mapLimit(segs, 6, (seg) => ask(seg.strokes, fetchImpl));
  segs.forEach((seg, k) => { seg.cands = cands[k]; seg.top = pickCandidate(cands[k]); seg.score = segScore(seg.top, seg.ratio); });
  // 動態規劃：best[pos] = 走到第 pos 個筆畫群為止的最佳切法（記住最後一段，才能算「跟前一個字組成詞」的加分）
  const best = Array.from({ length: atoms.length + 1 }, () => null);
  best[0] = { score: 0, path: [] };
  for (let pos = 0; pos < atoms.length; pos++) {
    const here = best[pos];
    if (!here) continue;
    for (const seg of segs) {
      if (seg.i !== pos) continue;
      const prev = here.path[here.path.length - 1];
      const pair = prev && LEX && LEX.has([...prev.top].pop() + [...seg.top][0]) ? TUNE.pair : 0;
      const score = here.score + seg.score + pair;
      if (!best[seg.j + 1] || score > best[seg.j + 1].score) best[seg.j + 1] = { score, path: [...here.path, seg] };
    }
  }
  return best[atoms.length].path.map((seg) => seg.cands);
}

/**
 * 辨識一組手寫筆畫。
 * @returns {Promise<{text:string, alts:string[]}>} alts：其他候選（只有整組就是一小段時才有，給使用者快速改選）
 */
export async function recognizeInkDetailed(strokes, fetchImpl = fetch) {
  const clean = strokes.filter((pts) => Array.isArray(pts) && pts.length).map(smoothStroke);
  if (!clean.length) return { text: '', alts: [] };
  const box = boxOf(clean.flat());
  const vertical = box.h > 2.2 * box.w && box.h > 90;
  const ax = vertical ? 1 : 0;
  let lines = splitLines(clean, 1 - ax);
  if (vertical) lines = lines.reverse(); // 直書由右到左
  const perLine = [];
  for (const line of lines) perLine.push(await recognizeLine(line, ax, fetchImpl));
  const results = perLine.flat();
  const text = joinText(pickSequence(results), '');
  const chars = [...text].filter((ch) => ch.trim());
  // 切完之後大多不是中文 → 這是英文或數字，改成整行送出（不切字），並且不套用「優先選中文」
  if (results.length > 1 && chars.filter((ch) => CJK.test(ch)).length * 2 < chars.length) {
    const whole = await Promise.all(lines.map((line) => ask(byTime(line), fetchImpl)));
    return { text: joinText(whole.map((c) => c[0] || ''), ' '), alts: whole.length === 1 ? whole[0].slice(1, 5) : [] };
  }
  const alts = results.length === 1 ? results[0].filter((c) => c !== text).slice(0, 4) : [];
  return { text, alts };
}

export async function recognizeInk(strokes, fetchImpl = fetch) {
  return (await recognizeInkDetailed(strokes, fetchImpl)).text;
}
