import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampQueries, openAlexUrl, abstractFromInvertedIndex, normalizeWork, dedupeWorks } from './searchLogic.mjs';

test('clampQueries：去掉空字串與重複（不分大小寫），最多 3 條、每條最多 120 字', () => {
  const out = clampQueries(['AI  dependency', 'ai dependency', '', null, 'b', 'c', 'd', 'x'.repeat(500)]);
  assert.deepEqual(out, ['AI dependency', 'b', 'c']);
  assert.equal(clampQueries(['x'.repeat(500)])[0].length, 120);
  assert.deepEqual(clampQueries('not an array'), []);
});

test('openAlexUrl：查詢字串要被正確編碼，並帶上年份與摘要篩選', () => {
  const url = new URL(openAlexUrl('AI & students?', { fromYear: 2021, perPage: 4, mailto: 'a@b.c' }));
  assert.equal(url.origin + url.pathname, 'https://api.openalex.org/works');
  assert.equal(url.searchParams.get('search'), 'AI & students?');
  assert.match(url.searchParams.get('filter'), /from_publication_date:2021-01-01/);
  assert.match(url.searchParams.get('filter'), /has_abstract:true/);
  assert.equal(url.searchParams.get('per-page'), '4');
  assert.equal(url.searchParams.get('mailto'), 'a@b.c');
});

test('abstractFromInvertedIndex：依位置還原成原本的句子', () => {
  assert.equal(abstractFromInvertedIndex({ students: [1, 4], AI: [0], helps: [2], some: [3] }), 'AI students helps some students');
  assert.equal(abstractFromInvertedIndex(null), '');
  assert.equal(abstractFromInvertedIndex({ bad: 'x', ok: [0] }), 'ok');
});

const work = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1000/xyz',
  display_name: 'A study',
  publication_year: 2024,
  authorships: [{ author: { display_name: 'A' } }, { author: { display_name: 'B' } }, {}, { author: { display_name: 'C' } }, { author: { display_name: 'D' } }],
  primary_location: { source: { display_name: 'Journal X' } },
  abstract_inverted_index: { Hello: [0], world: [1] },
};

test('normalizeWork：整理成前端要用的欄位，作者最多 3 位', () => {
  const w = normalizeWork(work, 'q1');
  assert.deepEqual(w, {
    id: 'https://openalex.org/W1', title: 'A study', year: 2024, doi: 'https://doi.org/10.1000/xyz',
    url: 'https://doi.org/10.1000/xyz', authors: ['A', 'B', 'C'], venue: 'Journal X', abstract: 'Hello world', q: 'q1',
  });
});

test('normalizeWork：沒有摘要或標題的文獻不能當證據，回傳 null', () => {
  assert.equal(normalizeWork({ ...work, abstract_inverted_index: null }, 'q'), null);
  assert.equal(normalizeWork({ ...work, display_name: '' }, 'q'), null);
  assert.equal(normalizeWork(null, 'q'), null);
});

test('normalizeWork：沒有 DOI 時連結退回 OpenAlex 頁面，doi 留空（前端會標成待驗證）', () => {
  const w = normalizeWork({ ...work, doi: null }, 'q');
  assert.equal(w.doi, '');
  assert.equal(w.url, 'https://openalex.org/W1');
});

test('dedupeWorks：同一篇只留一次，並排除前幾輪已經有的', () => {
  const a = { id: 'A' }, b = { id: 'B' }, c = { id: 'C' };
  assert.deepEqual(dedupeWorks([a, b, null, a, c], ['C']), [a, b]);
});
