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
  assert.ok(r.keywords.includes('university students') && r.keywords.includes('critical thinking'));
  assert.equal(proposeQuestion({ items: canvas, answers, ownQuestion: ' 我們的問題 ' }).researchQuestion, '我們的問題');
});

test('buildQueries：第 2 輪起刻意找反向方向；沒有關鍵字就不查', () => {
  assert.equal(buildQueries(['a', 'b'], 0).kind, 's');
  const r2 = buildQueries(['a', 'b'], 1);
  assert.equal(r2.kind, 'c');
  assert.match(r2.queries[0], /^a b negative effects$/);
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
