import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentCall, checkSetLevel, normalizeLevel, TOKEN_BUDGET } from './harness.mjs';

test('normalizeLevel：沒設定或亂填時回到預設 Level 2', () => {
  assert.equal(normalizeLevel(undefined), 2);
  assert.equal(normalizeLevel('3'), 2);
  assert.equal(normalizeLevel(7), 2);
  assert.equal(normalizeLevel(0), 0);
  assert.equal(normalizeLevel(3), 3);
});

test('checkAgentCall：viewer／teacher／非成員都不能執行 Agent', () => {
  for (const role of ['viewer', 'teacher', undefined]) {
    const r = checkAgentCall({ role, aiLevel: 3, action: 'analyzeScope' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'permission-denied');
  }
});

test('checkAgentCall：Level 0 時所有 Agent 動作都被拒絕', () => {
  for (const action of ['readHandwriting', 'analyzeScope', 'searchEvidence', 'proposeKeywords', 'proposeQuestion', 'summarizeEvidence']) {
    assert.equal(checkAgentCall({ role: 'editor', aiLevel: 0, action }).ok, false, action);
  }
});

test('checkAgentCall：Level 1 可以分析與搜尋，但不能請 Agent 草擬研究問題', () => {
  assert.equal(checkAgentCall({ role: 'editor', aiLevel: 1, action: 'analyzeScope' }).ok, true);
  assert.equal(checkAgentCall({ role: 'editor', aiLevel: 1, action: 'searchEvidence' }).ok, true);
  assert.equal(checkAgentCall({ role: 'editor', aiLevel: 1, action: 'proposeKeywords' }).ok, true);
  assert.equal(checkAgentCall({ role: 'editor', aiLevel: 1, action: 'proposeQuestion' }).ok, false);
});

test('checkAgentCall：證據摘要需要 Level 3', () => {
  assert.equal(checkAgentCall({ role: 'owner', aiLevel: 2, action: 'summarizeEvidence' }).ok, false);
  assert.equal(checkAgentCall({ role: 'owner', aiLevel: 3, action: 'summarizeEvidence' }).ok, true);
});

test('checkAgentCall：generateReport 在任何 Level 都被拒絕', () => {
  const r = checkAgentCall({ role: 'owner', aiLevel: 3, action: 'generateReport' });
  assert.equal(r.ok, false);
  assert.match(r.message, /generate_report/);
});

test('checkAgentCall：Token 預算用完後拒絕，並回報 resource-exhausted', () => {
  const r = checkAgentCall({ role: 'owner', aiLevel: 3, action: 'analyzeScope', tokensUsed: TOKEN_BUDGET });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'resource-exhausted');
  assert.equal(checkAgentCall({ role: 'owner', aiLevel: 3, action: 'analyzeScope', tokensUsed: TOKEN_BUDGET - 1 }).ok, true);
});

test('checkAgentCall：未知動作直接拒絕', () => {
  assert.equal(checkAgentCall({ role: 'owner', aiLevel: 3, action: 'deleteEverything' }).code, 'invalid-argument');
});

test('checkSetLevel：只有老師能設定，且 Level 必須是 0–3 的整數', () => {
  assert.equal(checkSetLevel({ role: 'teacher', level: 0 }).ok, true);
  assert.equal(checkSetLevel({ role: 'teacher', level: 3 }).ok, true);
  assert.equal(checkSetLevel({ role: 'owner', level: 3 }).ok, false);
  assert.equal(checkSetLevel({ role: 'teacher', level: 4 }).ok, false);
  assert.equal(checkSetLevel({ role: 'teacher', level: '2' }).ok, false);
});
