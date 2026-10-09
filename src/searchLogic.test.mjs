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

import { crossrefUrl, normalizeCrossref } from './searchLogic.mjs';

test('crossrefUrl：把布林查詢攤平成一串詞，並帶上年份、期刊論文、有摘要的篩選', () => {
  const url = new URL(crossrefUrl('("mobile phone" OR smartphone) AND sleep', { fromYear: 2021 }));
  assert.equal(url.searchParams.get('query.bibliographic'), 'mobile phone smartphone sleep');
  assert.match(url.searchParams.get('filter'), /from-pub-date:2021-01-01.*has-abstract:true/);
});

test('normalizeCrossref：整理成跟 OpenAlex 一樣的格式，摘要的 XML 標籤要拿掉；沒有摘要或 DOI 的不要', () => {
  const item = { DOI: '10.1/x', title: ['A <i>study</i>'], abstract: '<jats:title>Abstract</jats:title><jats:p>Sleep  improved.</jats:p>', issued: { 'date-parts': [[2023, 5]] },
    author: [{ given: 'A', family: 'Lin' }, { family: 'Wu' }], 'container-title': ['J'] };
  assert.deepEqual(normalizeCrossref(item, 'q'), { id: 'https://doi.org/10.1/x', title: 'A study', year: 2023, doi: 'https://doi.org/10.1/x', url: 'https://doi.org/10.1/x',
    authors: ['A Lin', 'Wu'], venue: 'J', abstract: 'Sleep improved.', q: 'q', src: 'Crossref' });
  assert.equal(normalizeCrossref({ ...item, abstract: '' }, 'q'), null);
  assert.equal(normalizeCrossref({ title: ['x'], abstract: 'y' }, 'q'), null);
});
