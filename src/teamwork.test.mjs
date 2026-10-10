import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_TYPES, typeOf, canvasActivity, canvasAlerts, taskSummary, taskAlerts } from './teamwork.mjs';

const text = (by, tag = '') => ({ type: 'text', by, tag });

test('TASK_TYPES：只有「研究內容」是畫布上看得到的；不認得的類型當成「其他」', () => {
  assert.deepEqual(TASK_TYPES.filter((t) => t.onCanvas).map((t) => t.id), ['research']);
  assert.equal(typeOf('present').name, '上台報告');
  assert.equal(typeOf('???').id, 'other');
});

test('canvasActivity：依建立者統計，手寫的後續筆畫不重複算，老師等不在名單裡的人不列', () => {
  const objs = [
    text('A', 'claim'), text('A', 'evidence'), text('B', 'question'), text('B'),
    { type: 'stroke', by: 'A' }, { type: 'stroke', by: 'A', hwSub: true }, { type: 'stroke', by: 'A', hwSub: true },
    { type: 'link', by: 'B' },
  ];
  const a = canvasActivity(objs, ['A', 'B', 'C']);
  assert.equal(a.total, 6);
  assert.deepEqual(a.rows.map((r) => [r.u, r.total]), [['A', 3], ['B', 3], ['C', 0]]);
  assert.equal(a.rows[0].kinds.hand, 1);
  assert.equal(a.rows[0].share, 0.5);
  assert.equal(a.rows[1].kinds.link, 1);
});

test('canvasActivity：建立者已離開小組的內容合併成一列，沒有內容時比例是 0', () => {
  const a = canvasActivity([text('X'), text('A')], ['A']);
  assert.deepEqual(a.rows.map((r) => [r.u, r.total]), [['A', 1], [null, 1]]);
  assert.deepEqual(canvasActivity([], ['A']).rows[0].share, 0);
});

test('canvasAlerts：超過 70% 才提示集中；內容太少或只有一個人時不提示', () => {
  const many = (by, n) => Array.from({ length: n }, () => text(by));
  const skew = canvasAlerts(canvasActivity([...many('A', 8), ...many('B', 2)], ['A', 'B', 'C']));
  assert.deepEqual(skew.map((x) => [x.level, x.u]), [['warn', 'A'], ['info', 'C']]);
  assert.match(skew[0].text, /80%/);
  assert.deepEqual(canvasAlerts(canvasActivity([...many('A', 7), ...many('B', 3)], ['A', 'B'])), []); // 剛好 70% 不算
  assert.deepEqual(canvasAlerts(canvasActivity(many('A', 3), ['A', 'B'])), []); // 內容太少
  assert.deepEqual(canvasAlerts(canvasActivity(many('A', 20), ['A'])), []); // 一人小組
});

test('taskSummary／taskAlerts：統計每個人的任務與自行標記完成數，提示沒有任務的人與沒人負責的任務', () => {
  const tasks = [{ assignee: 'A', done: true }, { assignee: 'A', done: false }, { assignee: '', done: false }, { assignee: 'Z', done: false }];
  const s = taskSummary(tasks, ['A', 'B']);
  assert.deepEqual(s.rows, [{ u: 'A', total: 2, done: 1 }, { u: 'B', total: 0, done: 0 }]);
  assert.equal(s.unassigned, 2);
  assert.deepEqual(taskAlerts(tasks, ['A', 'B']).map((x) => x.u), ['B', null]);
  assert.deepEqual(taskAlerts([], ['A', 'B']), []); // 還沒開始分工時不提示
});
