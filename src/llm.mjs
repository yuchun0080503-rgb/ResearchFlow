// llm.mjs — 連到使用者電腦上的 Ollama，用本機的 Qwen 模型（不需要金鑰、不花錢、資料不離開電腦）。
//
// Ollama 是在自己電腦上執行開源模型的程式（https://ollama.com）。這個檔案只做三件事：
//   1. detect()：看這台電腦有沒有開著 Ollama、裝了哪個 Qwen 模型；
//   2. chatJSON()：問模型一個問題，要求它照指定的 JSON 格式回答（可以附圖片）；
//   3. status()：目前的狀態，給畫面顯示「這一步是誰做的」。
// 沒有 Ollama（隊友、評審直接打開網站）時 detect() 回傳 ok:false，呼叫端要退回規則式的做法。
//
// 讓網站連得到本機的 Ollama：啟動 Ollama 前要設定環境變數 OLLAMA_ORIGINS，把網站的網址加進去（見 README）。

const BASE = 'http://localhost:11434';
// 依序挑第一個有安裝的。都是看得懂圖片的 Qwen（手寫辨識要用）；數字越大越準、越吃記憶體。
export const PREFERRED = ['qwen3.5:9b', 'qwen3-vl:8b', 'qwen3.5:4b', 'qwen3-vl:4b', 'qwen3.5:2b', 'qwen3-vl:2b'];
// 文字的步驟（規劃關鍵字、判讀文獻、反思…）優先用不會「先思考」的 instruct 版：實測在 16GB 筆電上一次約 3–9 秒，
// 而且一定照 JSON 格式回答；看得懂圖片的 9B 模型一次要 50 秒以上。沒有安裝 instruct 版時才用上面挑到的模型。
export const TEXT_PREFERRED = ['qwen3:4b-instruct-2507-q4_K_M', 'qwen3:4b-instruct', 'qwen3:8b-instruct', 'qwen2.5:7b-instruct'];
// 會先「思考」的模型（Qwen 3.5、Qwen3-VL）：在 Ollama 0.30 同時傳 think:false 和 JSON Schema 時，格式限制會失效（實測回傳 Markdown 或 YAML），
// 所以這類模型改用 format:'json'，Schema 寫進提示裡；不思考的 instruct 模型直接用 Schema 限制。
const THINKING = /^qwen3\.5|^qwen3-vl/i;

let state = { ok: false, model: '', textModel: '', vision: false, checked: 0, reason: '尚未偵測' };
export const status = () => state;

const timed = async (url, opts = {}, ms = 2000, fetchImpl = fetch) => {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetchImpl(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
};

/**
 * 偵測本機的 Ollama 與可用的 Qwen 模型。結果會記住 60 秒（force 可以強制重查）。
 * @returns {Promise<{ok:boolean, model:string, vision:boolean, reason:string}>}
 */
export async function detect(force = false, fetchImpl = fetch) {
  if (!force && Date.now() - state.checked < 60000) return state;
  try {
    const res = await timed(`${BASE}/api/tags`, {}, 2000, fetchImpl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const names = ((await res.json()).models || []).map((m) => m.name);
    const model = PREFERRED.find((n) => names.includes(n)) || names.find((n) => /^qwen/i.test(n)) || '';
    const textModel = TEXT_PREFERRED.find((n) => names.includes(n)) || model;
    state = model
      ? { ok: true, model, textModel, vision: /^qwen3\.5|^qwen3-vl|^qwen2\.5vl/i.test(model), checked: Date.now(), reason: '' }
      : { ok: false, model: '', textModel: '', vision: false, checked: Date.now(), reason: 'Ollama 已啟動，但還沒有下載 Qwen 模型' };
  } catch (err) {
    state = { ok: false, model: '', textModel: '', vision: false, checked: Date.now(), reason: '這台電腦沒有啟動 Ollama（或沒有允許這個網站連線）' };
  }
  return state;
}

// 給畫面顯示的名稱：qwen3.5:9b → 「Qwen 3.5（9B，本機）」
export const modelLabel = (name = state.textModel || state.model) => {
  const m = String(name).match(/^qwen([\d.]*)(-vl|vl)?:(\w+)/i);
  return m ? `Qwen ${m[1]}${m[2] ? ' VL' : ''}（${m[3].toUpperCase()}，本機）` : name || '';
};

/**
 * 問模型並要求照 JSON 格式回答。
 * @param {object} o
 * @param {string} o.system 角色與規則
 * @param {string} o.user 這次的內容
 * @param {string[]} [o.images] base64 圖片（不含 data: 開頭）
 * @param {object} o.schema JSON Schema：模型的輸出會被限制成這個結構
 * @param {number} [o.maxTokens] 輸出上限
 * @param {number} [o.timeout] 毫秒
 * @returns {Promise<object>} 解析後的 JSON
 */
export async function chatJSON({ system, user, images, schema, maxTokens = 900, timeout = 180000 }, fetchImpl = fetch) {
  const st = await detect(false, fetchImpl);
  if (!st.ok) throw new Error(st.reason);
  // 有圖片才用看得懂圖片的模型；文字步驟用 instruct 版（快、格式穩定）
  const model = images && images.length ? st.model : (st.textModel || st.model);
  const thinking = THINKING.test(model);
  const res = await timed(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, keep_alive: '30m',
      ...(thinking ? { think: false, format: 'json' } : { format: schema }),
      options: { temperature: 0, num_predict: maxTokens, num_ctx: 6144 },
      messages: [{ role: 'system', content: system + '\n\n只輸出一個 JSON 物件，不要加任何說明文字，格式必須符合這個 JSON Schema：' + JSON.stringify(schema) },
        { role: 'user', content: user, ...(images && images.length ? { images } : {}) }],
    }),
  }, timeout, fetchImpl);
  if (!res.ok) throw new Error(`Ollama 回應 ${res.status}：${(await res.text()).slice(0, 200)}`);
  return parseJSON((await res.json()).message?.content || '', schema);
}

/**
 * 把模型的回答解析成 JSON。模型偶爾會包一層 ```json、前後多說一句話，或在只要一個陣列欄位時直接回傳陣列；
 * 這些情況都整理回來。真的不是 JSON 時丟出錯誤，呼叫端會退回規則式的做法。
 */
export function parseJSON(text, schema) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  let out = tryParse(raw);
  if (out === undefined) {
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}'), c = raw.indexOf('['), d = raw.lastIndexOf(']');
    const obj = () => (a >= 0 && b > a ? tryParse(raw.slice(a, b + 1)) : undefined), arr = () => (c >= 0 && d > c ? tryParse(raw.slice(c, d + 1)) : undefined);
    out = c >= 0 && (a < 0 || c < a) ? (arr() ?? obj()) : (obj() ?? arr());
  }
  if (out === undefined) throw new Error('模型沒有照格式回答：' + raw.slice(0, 120));
  // 要的是物件、拿到的是陣列：如果 Schema 只有一個陣列欄位，就把陣列放進那個欄位
  if (Array.isArray(out) && schema?.type === 'object') {
    const arrays = Object.entries(schema.properties || {}).filter(([, v]) => v?.type === 'array');
    if (arrays.length === 1) out = { [arrays[0][0]]: out };
  }
  return out;
}
