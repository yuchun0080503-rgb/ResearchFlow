// searchLogic.mjs — 第四步「搜尋 API」的純邏輯：組 OpenAlex 查詢網址、把回應整理成乾淨的文獻物件。
// 不含網路呼叫（fetch 留在 index.mjs），可以直接用 node:test 驗證。
//
// 為什麼選 OpenAlex：免費、不需要 API key、回傳 DOI 與摘要，足以做到「沒有可驗證來源的資料不標記為證據」。
// 文件：https://docs.openalex.org/api-entities/works

const MAX_QUERIES = 3;
const MAX_QUERY_LEN = 120;
const MAX_ABSTRACT_LEN = 1200;
export const PER_QUERY = 5;

export function clampQueries(queries) {
  const seen = new Set();
  return (Array.isArray(queries) ? queries : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LEN))
    .filter((q) => (seen.has(q.toLowerCase()) ? false : seen.add(q.toLowerCase())))
    .slice(0, MAX_QUERIES);
}

export function openAlexUrl(query, { fromYear = 2020, perPage = PER_QUERY, mailto = '' } = {}) {
  const params = new URLSearchParams({
    search: query,
    filter: `from_publication_date:${fromYear}-01-01,has_abstract:true,type:article`,
    'per-page': String(perPage),
    select: 'id,doi,display_name,publication_year,authorships,primary_location,abstract_inverted_index',
  });
  if (mailto) params.set('mailto', mailto); // OpenAlex 的 polite pool：有留信箱回應比較穩定
  return `https://api.openalex.org/works?${params}`;
}

// OpenAlex 的摘要是「倒排索引」{word: [位置, ...]}，要自己還原成一般文字。
export function abstractFromInvertedIndex(idx) {
  if (!idx || typeof idx !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) if (Number.isInteger(pos) && pos >= 0 && pos < 5000) words[pos] = word;
  }
  return words.filter(Boolean).join(' ');
}

// 回傳 null 代表這筆資料不能用（沒有標題或摘要——沒有摘要 Agent 無從判斷它支持還是反對，不能硬當證據）。
export function normalizeWork(w, query) {
  if (!w || typeof w !== 'object') return null;
  const title = typeof w.display_name === 'string' ? w.display_name.trim() : '';
  const abstract = abstractFromInvertedIndex(w.abstract_inverted_index).slice(0, MAX_ABSTRACT_LEN);
  const id = typeof w.id === 'string' ? w.id : '';
  if (!title || !abstract || !id) return null;
  const doi = typeof w.doi === 'string' && w.doi.startsWith('https://doi.org/') ? w.doi : '';
  const authors = (Array.isArray(w.authorships) ? w.authorships : [])
    .map((a) => a?.author?.display_name)
    .filter((n) => typeof n === 'string' && n)
    .slice(0, 3);
  return {
    id,
    title: title.slice(0, 300),
    year: Number.isInteger(w.publication_year) ? w.publication_year : null,
    doi,
    url: doi || id,
    authors,
    venue: w.primary_location?.source?.display_name || '',
    abstract,
    q: query,
  };
}

// 多條查詢的結果合併：同一篇只留第一次出現的，並排除前幾輪已經在 Evidence Map 裡的文獻。
export function dedupeWorks(works, excludeIds = []) {
  const seen = new Set(Array.isArray(excludeIds) ? excludeIds : []);
  const out = [];
  for (const w of works) {
    if (!w || seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
  }
  return out;
}
