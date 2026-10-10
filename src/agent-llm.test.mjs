import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, modelLabel } from './llm.mjs';
import { planSearch, translate, judgeWorks, refineEvidence, readInk } from './agent-llm.mjs';

// 假的 Ollama：/api/tags 回報有安裝的模型，/api/chat 回傳事先準備好的 JSON（並記下送出的內容）
const fake = (models, reply) => {
  const calls = [];
  const fn = async (url, opts) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: models.map((name) => ({ name })) }) };
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }) };
  };
  fn.calls = calls;
  return fn;
};

test('detect：依偏好順序挑 Qwen 模型；沒有 Ollama 或沒有 Qwen 時 ok 為 false', async () => {
  const a = await detect(true, fake(['llama3:8b', 'qwen3.5:4b', 'qwen3.5:9b']));
  assert.deepEqual([a.ok, a.model, a.vision], [true, 'qwen3.5:9b', true]);
  assert.equal(modelLabel('qwen3.5:9b'), 'Qwen 3.5（9B，本機）');
  assert.equal((await detect(true, fake(['llama3:8b']))).ok, false);
  assert.equal((await detect(true, async () => { throw new Error('connection refused'); })).ok, false);
});

test('planSearch：把寫在一起的概念拆開，丟掉不是英文的翻譯，沒有主題詞就視為失敗', async () => {
  const f = fake(['qwen3.5:9b'], { focus: '查證重點', keywords: [
    { zh: '人工智慧、自主判斷能力', en: 'Artificial Intelligence, independent thinking', role: 'core', synonyms: ['critical thinking', '批判思考'] },
    { zh: '學生', en: 'students', role: 'scope', synonyms: ['learners'] },
    { zh: '能力', en: '能力', role: 'core', synonyms: [] },
  ] });
  await detect(true, f);
  const r = await planSearch({ title: 'AI 與學生學習研究', claim: '影響學生自主判斷能力' }, f);
  assert.deepEqual(r.keywords.map((k) => [k.zh, k.en, k.role]), [['人工智慧', 'artificial intelligence', 'core'], ['自主判斷能力', 'independent thinking', 'core'], ['學生', 'students', 'scope']]);
  assert.deepEqual(r.keywords[1].synonyms, ['critical thinking']);
  assert.match(f.calls[0].messages[1].content, /AI 與學生學習研究/);
  assert.equal(f.calls[0].think, false);
  const none = fake(['qwen3.5:9b'], { focus: '', keywords: [{ zh: '學生', en: 'students', role: 'scope', synonyms: [] }] });
  await assert.rejects(planSearch({ title: 't', claim: 'c' }, none), /主題詞/);
});

test('translate：只接受英文結果', async () => {
  const f = fake(['qwen3.5:9b'], { en: 'Screen Time', synonyms: ['usage duration'] });
  await detect(true, f);
  assert.deepEqual(await translate('使用時間', '社群媒體', f), { en: 'screen time', synonyms: ['usage duration'] });
  await assert.rejects(translate('使用時間', '', fake(['qwen3.5:9b'], { en: '使用時間', synonyms: [] })), /英文/);
});

test('judgeWorks／refineEvidence：排除不切題的、依模型判斷的立場分類、摘要沒寫結果時沿用規則式分類', async () => {
  const f = fake(['qwen3.5:9b'], { items: [
    { i: 0, rel: 3, stance: 'support', finding: '過度依賴 AI 會降低獨立思考。' },
    { i: 1, rel: 1, stance: 'support', finding: '談的是醫療決策。' },
    { i: 2, rel: 2, stance: 'mixed', finding: '只有在缺乏引導時才會下降。' },
    { i: 3, rel: 3, stance: 'unclear', finding: '' },
    // 第 4 篇模型漏掉了
  ] });
  await detect(true, f);
  const ev = ['a', 'b', 'c', 'd', 'e'].map((id, n) => ({ id, t: 'T' + id, f: '原摘要' + id, _ab: '完整摘要' + id, k: n === 3 ? 'c' : 's' }));
  const v = await judgeWorks({ claim: '主張', works: ev.map((e) => ({ title: e.t, abstract: e._ab })) }, f);
  assert.deepEqual(v.map((x) => [x.rel, x.stance]), [[3, 'support'], [1, 'unrelated'], [2, 'mixed'], [3, 'unclear'], [-1, 'unrelated']]);
  const r = await refineEvidence({ claim: '主張', evidence: ev, model: 'Qwen' }, f);
  assert.deepEqual([r.judged, r.removed], [4, 1]);
  assert.deepEqual(r.evidence.map((e) => [e.id, e.k, e.rel]), [['a', 's', '高'], ['d', 'c', '高'], ['c', 'c', '中'], ['e', 's', undefined]]);
  assert.equal(r.evidence[0].f, '過度依賴 AI 會降低獨立思考。');
  assert.equal(r.evidence[0].fo, '原摘要a');
  assert.equal(r.evidence[1].unc, true);
  assert.equal(r.evidence[2].mix, true);
  assert.match(f.calls[1].messages[1].content, /完整摘要a/);
});

test('readInk：把圖片交給模型並回傳文字；模型沒照格式回答時丟出錯誤', async () => {
  const f = fake(['qwen3.5:9b'], { text: ' 學生自主判斷能力 ' });
  await detect(true, f);
  assert.equal(await readInk('BASE64', '學生目王', f), '學生自主判斷能力');
  assert.deepEqual(f.calls[0].messages[1].images, ['BASE64']);
  await assert.rejects(readInk('BASE64', '', fake(['qwen3.5:9b'], '不是 JSON')), /格式/);
});
