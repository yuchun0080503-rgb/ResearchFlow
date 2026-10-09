import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScope, proposeQuestion, keywordsFrom, buildQueries, classifyWork, searchEvidence, summarizeEvidence } from './agent-local.mjs';

const canvas = [
  { type: 'stroke', text: '研究主題：生成式 AI 與學習', tag: '' },
  { type: 'text', text: 'AI 搜尋資料速度比較快。', tag: 'claim' },
  { type: 'text', text: '但是可能產生 AI 依賴。', tag: 'counter' },
];

test('analyzeScope：缺哪個面向就問哪個面向', () => {
  const r = analyzeScope(canvas);
  assert.equal(r.tooBroad, true);
  assert.deepEqual(r.clarifyingQuestions.map((q) => q.key), ['who', 'ctx', 'out']);
  assert.equal(r.topic, '生成式 AI 與學習');
});

test('analyzeScope：對象、情境、結果都寫了就不再追問', () => {
  const r = analyzeScope([...canvas, { type: 'text', text: '大學生在寫作報告時的批判思考', tag: '' }]);
  assert.equal(r.tooBroad, false);
  assert.deepEqual(r.clarifyingQuestions, []);
});

test('analyzeScope：空畫布與未辨識的手寫不當作內容', () => {
  const r = analyzeScope([{ type: 'stroke', text: '（未能辨識，請手動輸入）' }]);
  assert.equal(r.tooBroad, true);
  assert.match(r.reasons[0], /還沒有/);
});

test('keywordsFrom：中文用語對應成英文關鍵字，並保留畫布上的英文詞', () => {
  const kw = keywordsFrom('大學生用生成式 AI 寫作，批判思考會下降嗎 scaffolding');
  assert.deepEqual(kw, ['generative AI', 'university students', 'academic writing', 'critical thinking', 'scaffolding']);
});

test('proposeQuestion：把回答套進問題；學生自己寫的問題原樣保留', () => {
  const answers = [{ key: 'who', answer: '大學生' }, { key: 'ctx', answer: '自主學習' }, { key: 'out', answer: '批判思考' }];
  const r = proposeQuestion({ items: canvas, answers });
  assert.match(r.researchQuestion, /大學生在自主學習情境中，批判思考會受到什麼影響/);
  assert.deepEqual([r.kwEn['大學生'], r.kwEn['批判思考']], ['university students', 'critical thinking']); // 關鍵字以中文呈現，英文對照在 kwEn
  assert.equal(proposeQuestion({ items: canvas, answers, ownQuestion: ' 我們的問題 ' }).researchQuestion, '我們的問題');
});

test('buildQueries：主題詞用 AND 接起來且都要出現，同義詞用 OR；第 2 輪起刻意找反向方向；沒有關鍵字就不查', () => {
  const r0 = buildQueries(['mobile phone', 'sleep', 'secondary school students', 'classroom learning'], 0, 'procon', 2);
  assert.deepEqual([r0.kind, r0.core, r0.scope], ['s', ['mobile phone', 'sleep'], ['secondary school students', 'classroom learning']]);
  assert.equal(r0.queries[0], '("mobile phone" OR smartphone) AND (sleep OR "sleep quality") AND ("secondary school students" OR adolescents)');
  assert.equal(r0.queries[1], '("mobile phone" OR smartphone OR cellphone) AND (sleep OR "sleep quality" OR "sleep duration")');
  const r1 = buildQueries(['mobile phone', 'sleep'], 1);
  assert.equal(r1.kind, 'c');
  assert.match(r1.queries[0], /AND \(negative OR risk\)$/);
  // 每條查詢最多 5 個布林運算子（超過會被文獻資料庫限速）
  for (const q of [...r0.queries, ...r1.queries]) assert.ok((q.match(/ AND | OR /g) || []).length <= 5, q);
  // 只有一個關鍵字：就查那一個；指定只有 1 個主題詞但有第二個關鍵字時，第二個也當成必要條件（不然範圍太大）
  assert.deepEqual(buildQueries(['origami'], 0).queries, ['origami']);
  assert.deepEqual(buildQueries(['origami', 'geometry'], 0, 'procon', 1).core, ['origami', 'geometry']);
  assert.deepEqual(buildQueries([], 0).queries, []);
});

const work = (abstract, doi = 'https://doi.org/10.1/x') => ({ id: 'W' + abstract.length, title: 'Generative AI and university students', year: 2024, doi, url: doi || 'https://openalex.org/W1', authors: ['A'], venue: 'J', abstract, q: 'q' });

test('classifyWork：依摘要用語做初步分類，並標示為尚未確認', () => {
  const pos = classifyWork(work('We ran a randomized experiment with undergraduate students. Results showed improved and enhanced academic performance overall.'), 'c', ['generative AI', 'university students']);
  assert.deepEqual([pos.k, pos.m, pos.p, pos.auto, pos.v, pos.d], ['s', '實驗研究', '大學生', true, true, '直接']);
  const neg = classifyWork(work('A survey of teachers raised concerns about plagiarism, dependence and reduced critical thinking among learners in general.', ''), 's', []);
  assert.deepEqual([neg.k, neg.m, neg.v], ['c', '問卷調查', false]);
  assert.equal(classifyWork(work('This article describes the design of a new curriculum for a course in some detail.'), 'c').k, 'c'); // 分不出來時沿用查詢方向
});

test('searchEvidence：整理 OpenAlex 回應、排除已有的文獻；全部查詢失敗時丟錯', async () => {
  const api = { results: [
    { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1/a', display_name: 'T1', publication_year: 2023, authorships: [], abstract_inverted_index: { AI: [0], improved: [1], learning: [2] } },
    { id: 'https://openalex.org/W2', doi: null, display_name: 'T2', publication_year: 2022, authorships: [], abstract_inverted_index: { Risk: [0], and: [1], harm: [2] } },
  ] };
  const ok = async () => ({ ok: true, json: async () => api });
  const r = await searchEvidence({ queries: ['q1'], kind: 's', keywords: [], excludeIds: ['https://openalex.org/W2'] }, ok);
  assert.deepEqual(r.evidence.map((e) => e.t), ['T1']);
  await assert.rejects(searchEvidence({ queries: ['q1'], kind: 's' }, async () => ({ ok: false, status: 500 })), /OpenAlex/);
  await assert.rejects(searchEvidence({ queries: [], kind: 's' }, ok), /關鍵字/);
});

test('summarizeEvidence：只報數量與標題，並提醒結論由小組判斷', () => {
  const s = summarizeEvidence([{ k: 's', t: 'A', y: 2024, v: true, auto: true }, { k: 'c', t: 'B', y: 2023, v: false }]);
  assert.match(s, /支持方向 1 筆/);
  assert.match(s, /1 筆來源待驗證/);
  assert.match(s, /結論請由小組自行判斷/);
});

import { suggestMode, claimQuestion, evidenceLevel, claimIssues } from './agent-local.mjs';

test('suggestMode：題目有正反／利弊／影響等字眼建議正反例證，其餘建議主張論證', () => {
  assert.equal(suggestMode('社群媒體對青少年的利弊').mode, 'procon');
  assert.match(suggestMode('AI 對學習的影響 需含正反證據').reason, /「正反」|「影響」/);
  assert.equal(suggestMode('臺灣茶產業的發展歷程').mode, 'claim');
  assert.equal(suggestMode('').mode, 'claim');
});

test('buildQueries：主張論證模式依序找直接證據、統整性研究、成立條件；反面例證要另外要求', () => {
  const kw = ['sleep', 'academic performance'];
  assert.equal(buildQueries(kw, 0, 'claim').kind, 's');
  assert.match(buildQueries(kw, 0, 'claim').queries[0], /^\(sleep OR "sleep quality"/);
  assert.match(buildQueries(kw, 1, 'claim').queries[0], /"systematic review" OR meta-analysis/);
  assert.equal(buildQueries(kw, 2, 'claim').kind, 's'); // 第 3 輪找成立條件與機制，仍然是幫主張找證據
  assert.match(buildQueries(kw, 2, 'claim').queries[0], /mechanism/);
  assert.equal(buildQueries(kw, 'counter', 'claim').kind, 'c'); // 反面例證只有學生要求時才找
  assert.equal(buildQueries(kw, 1).kind, 'c'); // 沒指定模式＝正反例證：第 2 輪找反向
});

test('claimQuestion／evidenceLevel：主張轉成研究問題；回顧與實驗的證據力最高', () => {
  assert.equal(claimQuestion(' 睡眠不足會降低成績 '), '「睡眠不足會降低成績」這個主張成立嗎？在什麼條件下成立，又有哪些限制？');
  assert.deepEqual(['文獻回顧', '實驗研究', '問卷調查', '質性研究', '摘要未說明'].map(evidenceLevel), ['高', '高', '中', '低', '不明']);
  const w = { id: 'W1', title: 'A meta-analysis of sleep', year: 2024, doi: 'https://doi.org/1', url: 'https://doi.org/1', authors: [], venue: '', abstract: 'This systematic review found that sleep improved grades in many studies overall.', q: 'q' };
  assert.equal(classifyWork(w, 's').lv, '高');
});

test('claimIssues：從主張的寫法與證據的組成列出潛在問題，不需要反面例證', () => {
  const ev = [
    { lv: '中', d: '直接', p: '大學生', v: true }, { lv: '不明', d: '間接', p: '大學生', v: false }, { lv: '中', d: '間接', p: '摘要未說明', v: true },
  ];
  const issues = claimIssues('睡眠不足一定會降低成績', ev, 2).join('\n');
  assert.match(issues, /「一定」/);
  assert.match(issues, /因果主張/);
  assert.match(issues, /沒有說明適用的對象/);
  assert.match(issues, /沒有證據力高的研究/);
  assert.match(issues, /只有 1／3 筆/);
  assert.match(issues, /幾乎都是大學生/);
  assert.match(issues, /1 筆證據的來源還沒有驗證/);
  assert.match(issues, /另外遇到 2 篇/);
  const good = claimIssues('大學生的睡眠時間與學業成績有關', [{ lv: '高', d: '直接', p: '大學生', v: true }, { lv: '高', d: '直接', p: '中學生', v: true }], 0);
  assert.deepEqual(good, []);
  assert.match(claimIssues('x', [], 0).join(''), /還沒有找到支持/);
});

import { keywordPairs, translateTerm, buildQueriesZh } from './agent-local.mjs';

test('keywordPairs：保留中文原文，並附上英文對照', () => {
  assert.deepEqual(keywordPairs('大學生用生成式 AI 寫作 scaffolding'), [
    { zh: '生成式AI', en: 'generative AI' }, { zh: '大學生', en: 'university students' }, { zh: '寫作', en: 'academic writing' }, { zh: '', en: 'scaffolding' },
  ]);
  const r = proposeQuestion({ items: [{ type: 'text', text: '睡眠不足會影響批判思考', tag: 'claim' }], answers: [] });
  assert.deepEqual(r.keywords, ['批判思考', '睡眠']);
  assert.deepEqual(r.kwEn, { 批判思考: 'critical thinking', 睡眠: 'sleep' });
});

test('translateTerm：內建對照表 → 維基百科條目對應 → 機器翻譯；英文原樣回傳；全部失敗回傳空字串', async () => {
  const never = async () => { throw new Error('不應該連網'); };
  assert.deepEqual(await translateTerm('批判思考', never), { en: 'critical thinking', via: '內建對照表' });
  assert.deepEqual(await translateTerm('sleep', never), { en: 'sleep', via: '' });
  const wiki = async (url) => ({ ok: true, json: async () => (url.includes('wikipedia') ? { query: { pages: { 1: { langlinks: [{ '*': 'Sleep deprivation (medicine)' }] } } } } : {}) });
  assert.deepEqual(await translateTerm('睡眠剝奪', wiki), { en: 'sleep deprivation', via: '維基百科條目對應' });
  const mt = async (url) => ({ ok: true, json: async () => (url.includes('wikipedia') ? { query: { pages: { '-1': {} } } } : { responseData: { translatedText: 'Night Owl Habit' } }) });
  assert.deepEqual(await translateTerm('夜貓子習慣', mt), { en: 'night owl habit', via: '機器翻譯' });
  assert.deepEqual(await translateTerm('夜貓子習慣', async () => ({ ok: false })), { en: '', via: '' });
});

test('buildQueriesZh：只用中文關鍵字（前 3 個），各模式各輪的方向跟英文版對應', () => {
  const kw = ['睡眠', 'sleep', '學業成績', '大學生', '動機'];
  assert.deepEqual(buildQueriesZh(kw, 0), ['睡眠 學業成績 大學生']);
  assert.deepEqual(buildQueriesZh(kw, 1), ['睡眠 學業成績 大學生 負面影響', '睡眠 學業成績 大學生 風險']);
  assert.match(buildQueriesZh(kw, 1, 'claim')[0], /後設分析/);
  assert.match(buildQueriesZh(kw, 'counter', 'claim')[0], /限制/);
  assert.deepEqual(buildQueriesZh(['sleep'], 0), []);
});

test('classifyWork：中文文獻用中文的線索詞判斷方向、方法與對象', () => {
  const w = { id: 'Z1', title: '大學生睡眠品質與學業成就之關係', year: 2021, doi: 'https://doi.org/1', url: 'https://doi.org/1', authors: [], venue: '教育期刊', q: '睡眠 學業',
    abstract: '本研究以問卷調查法探討大學生睡眠品質與學業成就之關係。結果顯示睡眠品質較佳者學業成就顯著高於睡眠品質不佳者；良好睡眠有助提升學習專注。' };
  const e = classifyWork(w, 'c', ['睡眠', '學業']);
  assert.deepEqual([e.k, e.m, e.p, e.lang, e.lv, e.sc], ['s', '問卷調查', '大學生', 'zh', '中', '關鍵字符合 2／2']);
  assert.match(e.f, /有助提升/);
});

test('searchEvidence：英文與中文查詢一起跑，中文查詢帶 language:zh；只有中文關鍵字也能搜尋', async () => {
  const urls = [];
  const mk = (id, title, words) => ({ id, doi: 'https://doi.org/' + id, display_name: title, publication_year: 2022, authorships: [], abstract_inverted_index: Object.fromEntries(words.map((x, i) => [x, [i]])) });
  const svc = async (url) => { urls.push(decodeURIComponent(url)); const zh = url.includes('language%3Azh');
    return { ok: true, json: async () => ({ results: zh ? [mk('Z1', '大學生睡眠研究', ['睡眠', '有助', '提升', '成績'])] : [mk('E1', 'English paper', ['sleep', 'improved', 'grades'])] }) }; };
  const r = await searchEvidence({ queries: ['sleep grades'], zhQueries: ['睡眠 成績'], kind: 's', keywords: ['sleep'], keywordsZh: ['睡眠'] }, svc);
  assert.deepEqual(r.evidence.map((e) => e.lang), ['en', 'zh']);
  assert.deepEqual(r.queries, ['sleep grades', '睡眠 成績']);
  assert.ok(urls.some((u) => u.includes('language:zh') && u.includes('2015-01-01')));
  const only = await searchEvidence({ queries: [], zhQueries: ['睡眠'], kind: 's', keywordsZh: ['睡眠'] }, svc);
  assert.equal(only.evidence.length, 1);
  // 中文結果要真的提到關鍵字（至少兩個），否則丟掉：這篇只有「睡眠」，沒有「手機」
  const strict = await searchEvidence({ queries: [], zhQueries: ['手機 睡眠'], kind: 's', keywordsZh: ['手機', '睡眠'] }, svc);
  assert.equal(strict.evidence.length, 0);
});

import { extractZhTerms, relevance, boolQuery, isNegativeClaim } from './agent-local.mjs';

test('extractZhTerms：用詞庫做最長詞比對，去掉功能詞與太常見的詞，依出現順序回傳', () => {
  const rank = { 高中生: 9000, 高中: 3000, 手機: 2500, 睡眠: 4000, 可能: 120, 因為: 130, 影響: 200, 睡前: 15000, 的: 105, 學業成績: 12000, 學業: 6000, 成績: 900, 批判思考: 50, 需要: 110 };
  const rankOf = (w) => rank[w];
  assert.deepEqual(extractZhTerms('高中生睡前滑手機可能會影響睡眠', rankOf), ['高中生', '睡前', '手機', '睡眠']);
  assert.deepEqual(extractZhTerms('因為手機，學業成績變差；手機！', rankOf), ['手機', '學業成績']);
  assert.deepEqual(extractZhTerms('需要批判思考', rankOf), ['批判思考']); // 手動加入的研究常用詞排在詞表最前面，一定保留
  assert.deepEqual(extractZhTerms('English only', rankOf), []);
  assert.deepEqual(extractZhTerms('手機', () => undefined), []); // 詞庫還沒載入
});

test('boolQuery：先保證每一組都有一個詞，剩下的額度才補同義詞，總共最多 5 個運算子', () => {
  assert.equal(boolQuery([['a', 'a2', 'a3'], ['b', 'b2'], ['c']]), '(a OR a2 OR a3) AND (b OR b2) AND c');
  assert.equal(boolQuery([['a', 'a2'], ['b', 'b2'], ['c', 'c2'], ['d', 'd2']]), '(a OR a2) AND (b OR b2) AND c AND d');
  assert.equal(boolQuery([['two words']]), '"two words"');
  assert.equal(boolQuery([]), '');
});

test('relevance：每個主題詞（或同義詞）都要出現在標題或摘要；出現在標題的分數比較高', () => {
  const core = ['mobile phone', 'sleep'];
  const a = relevance({ title: 'Smartphone use and sleep quality in adolescents', abstract: '' }, core, ['secondary school students']);
  assert.deepEqual([a.ok, a.coreHit, a.inTitle], [true, 2, 2]);
  const b = relevance({ title: 'Screen time in schools', abstract: 'We surveyed cellphone habits and sleep.' }, core);
  assert.deepEqual([b.ok, b.inTitle], [true, 0]);
  assert.ok(a.score > b.score);
  assert.equal(relevance({ title: 'Mobile phone use in class', abstract: 'Attention and grades.' }, core).ok, false); // 沒提到睡眠 → 離題
});

test('classifyWork：主張本身是負面的時候，發現負面結果的研究算「支持」', () => {
  assert.equal(isNegativeClaim('高中生睡前滑手機會讓睡眠變差'), true);
  assert.equal(isNegativeClaim('生成式 AI 能提升學習效率'), false);
  const w = { id: 'W9', title: 'Smartphone addiction and sleep', year: 2023, doi: 'https://doi.org/9', url: 'https://doi.org/9', authors: [], venue: '', q: 'q',
    abstract: 'Smartphone addiction was associated with reduced sleep quality and higher risk of insomnia among adolescents in this survey.' };
  assert.equal(classifyWork(w, 's', [], false).k, 'c');
  assert.equal(classifyWork(w, 's', [], true).k, 's');
});

test('searchEvidence：離題的文獻（沒有提到全部主題詞）會被丟掉，其餘依相關度排序', async () => {
  const mk = (id, title, text) => ({ id, doi: 'https://doi.org/' + id, display_name: title, publication_year: 2023, authorships: [], abstract_inverted_index: Object.fromEntries(text.split(' ').map((x, i) => [x + '\u200b'.repeat(i), [i]])) });
  const svc = async () => ({ ok: true, json: async () => ({ results: [
    mk('A', 'Phones in the classroom', 'mobile phone use and attention in class'),
    mk('B', 'Evening habits of teenagers', 'smartphone use was linked to shorter sleep duration'),
    mk('C', 'Mobile phone use and sleep quality', 'mobile phone use improved nothing and sleep suffered'),
  ] }) });
  const plan = buildQueries(['mobile phone', 'sleep'], 0);
  const r = await searchEvidence({ ...plan, keywords: ['mobile phone', 'sleep'] }, svc);
  assert.deepEqual(r.evidence.map((e) => e.id), ['C', 'B']);
  assert.deepEqual(r.evidence.map((e) => e.rel), ['高', '中']);
  assert.equal(r.dropped, 1);
});

test('searchEvidence：OpenAlex 額度用完（429）時自動改查 Crossref，並告知是備援；撤稿的論文不要', async () => {
  const urls = [];
  const svc = async (url) => { urls.push(url);
    if (url.includes('openalex')) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ message: { items: [
      { DOI: '10.1/a', title: ['Smartphone use and sleep quality'], abstract: '<p>mobile phone use reduced sleep</p>', issued: { 'date-parts': [[2022]] } },
      { DOI: '10.1/b', title: ['RETRACTED: Mobile phone and sleep'], abstract: '<p>mobile phone sleep</p>', issued: { 'date-parts': [[2021]] } },
      { DOI: '10.1/c', title: ['Phones at school'], abstract: '<p>smartphone bans and grades</p>', issued: { 'date-parts': [[2023]] } },
    ] } }) }; };
  const r = await searchEvidence({ ...buildQueries(['mobile phone', 'sleep'], 0), keywords: ['mobile phone', 'sleep'] }, svc);
  assert.equal(r.fallback, true);
  assert.deepEqual(r.evidence.map((e) => [e.id, e.src]), [['https://doi.org/10.1/a', 'Crossref']]);
  assert.ok(urls.some((u) => u.includes('api.crossref.org')));
  await assert.rejects(searchEvidence({ ...buildQueries(['mobile phone', 'sleep'], 0) }, async () => ({ ok: false, status: 500 })), /都沒有回應/);
});

import { searchRelaxed } from './agent-local.mjs';

test('searchRelaxed：全部主題詞都要求時找不到，就把最後一個主題詞放寬再找；回報放寬了哪個', async () => {
  const mk = (id, title, text) => ({ id, doi: 'https://doi.org/' + id, display_name: title, publication_year: 2023, authorships: [], abstract_inverted_index: Object.fromEntries(text.split(' ').map((x, i) => [x + '​'.repeat(i), [i]])) });
  const works = ['A', 'B', 'C', 'D'].map((id) => mk(id, 'Social media and anxiety ' + id, 'social media use and anxiety in teens'));
  const svc = async () => ({ ok: true, json: async () => ({ results: works }) });
  const r = await searchRelaxed({ keywords: ['social media', 'anxiety', 'active hours'], coreCount: 3, round: 0, mode: 'procon' }, svc);
  assert.deepEqual(r.relaxed, ['active hours']);
  assert.equal(r.evidence.length, 4);
  assert.deepEqual([...new Set(r.evidence.map((e) => e.rel))], ['中']); // 放寬後才找到的不算「高」
  const strict = await searchRelaxed({ keywords: ['social media', 'anxiety'], coreCount: 2, round: 0, mode: 'procon' }, svc);
  assert.deepEqual([strict.relaxed, strict.evidence[0].rel], [[], '高']);
});
