// searchLogic.mjs — 第四步「搜尋 API」的純邏輯：組 OpenAlex 查詢網址、把回應整理成乾淨的文獻物件。
// 不含網路呼叫（fetch 留在 index.mjs），可以直接用 node:test 驗證。
//
// 為什麼選 OpenAlex：免費、不需要 API key、回傳 DOI 與摘要，足以做到「沒有可驗證來源的資料不標記為證據」。
// 文件：https://docs.openalex.org/api-entities/works

const MAX_QUERIES = 3;
const MAX_QUERY_LEN = 120;
const MAX_ABSTRACT_LEN = 1200;
export const PER_QUERY = 5;

export function clampQueries(queries, maxLen = MAX_QUERY_LEN) {
  const seen = new Set();
  return (Array.isArray(queries) ? queries : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim().replace(/\s+/g, ' ').slice(0, maxLen))
    .filter((q) => (seen.has(q.toLowerCase()) ? false : seen.add(q.toLowerCase())))
    .slice(0, MAX_QUERIES);
}

// tiab：query 是布林查詢，只比對標題與摘要（比全文搜尋精準得多）。
// lang：只找某個語言的文獻（例如 'zh'）。OpenAlex 的搜尋本身不限語言，中文關鍵字可以直接查到中文期刊論文。
export function openAlexUrl(query, { fromYear = 2020, perPage = PER_QUERY, mailto = '', lang = '', tiab = false } = {}) {
  const params = new URLSearchParams({
    ...(tiab ? {} : { search: query }),
    filter: `from_publication_date:${fromYear}-01-01,has_abstract:true,type:article${lang ? `,language:${lang}` : ''}${tiab ? `,title_and_abstract.search:${query.replace(/,/g, ' ')}` : ''}`,
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

// ---------------- Crossref（備援來源）----------------
// OpenAlex 對沒有金鑰的使用者有每日額度（同一個網路位址共用，整個班級在同一個校園網路時很快會用完）。
// 額度用完或連不上時改查 Crossref：一樣免費、不需要金鑰、允許瀏覽器直接呼叫，沒有每日額度（每秒一次）。
// Crossref 不支援布林查詢，所以把布林式攤平成一串詞送出，找回來之後一樣要通過主題詞的相關度檢查。
// 文件：https://api.crossref.org/swagger-ui/index.html

export function crossrefUrl(boolQueryText, { fromYear = 2020, rows = 20 } = {}) {
  const flat = String(boolQueryText).replace(/[()"]/g, ' ').replace(/\b(AND|OR)\b/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const params = new URLSearchParams({
    'query.bibliographic': flat,
    filter: `from-pub-date:${fromYear}-01-01,type:journal-article,has-abstract:true`,
    rows: String(rows),
    select: 'DOI,title,abstract,issued,author,container-title',
  });
  return `https://api.crossref.org/works?${params}`;
}

// Crossref 的一筆資料 → 跟 normalizeWork 相同的格式。摘要是 JATS XML，要把標籤拿掉。
export function normalizeCrossref(item, query) {
  if (!item || typeof item !== 'object' || typeof item.DOI !== 'string') return null;
  const title = (Array.isArray(item.title) ? item.title[0] : '') || '';
  const abstract = String(item.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/^\s*abstract\s*/i, '').trim().slice(0, MAX_ABSTRACT_LEN);
  if (!title.trim() || !abstract) return null;
  const doi = `https://doi.org/${item.DOI}`;
  const year = item.issued?.['date-parts']?.[0]?.[0];
  return {
    id: doi,
    title: title.replace(/<[^>]+>/g, '').trim().slice(0, 300),
    year: Number.isInteger(year) ? year : null,
    doi,
    url: doi,
    authors: (Array.isArray(item.author) ? item.author : []).map((a) => [a?.given, a?.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 3),
    venue: (Array.isArray(item['container-title']) ? item['container-title'][0] : '') || '',
    abstract,
    q: query,
    src: 'Crossref',
  };
}
