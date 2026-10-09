import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, canChangeRole, isValidRole } from './permissions.mjs';

test('owner 擁有所有列出的動作', () => {
  for (const a of [
    'project.manageSettings', 'project.inviteMember', 'project.removeMember',
    'project.updateMemberRole', 'canvas.read', 'canvas.write', 'agent.execute',
    'evidence.read', 'researchState.read',
  ]) assert.equal(can('owner', a), true, `owner 應允許 ${a}`);
});

test('editor 可以寫畫布、不能管理成員', () => {
  assert.equal(can('editor', 'canvas.write'), true);
  assert.equal(can('editor', 'agent.execute'), true);
  assert.equal(can('editor', 'project.inviteMember'), false);
  assert.equal(can('editor', 'project.removeMember'), false);
  assert.equal(can('editor', 'project.manageSettings'), false);
});

test('viewer 只能讀取，不能寫畫布或執行 agent', () => {
  assert.equal(can('viewer', 'canvas.read'), true);
  assert.equal(can('viewer', 'evidence.read'), true);
  assert.equal(can('viewer', 'researchState.read'), true);
  assert.equal(can('viewer', 'canvas.write'), false);
  assert.equal(can('viewer', 'agent.execute'), false);
  assert.equal(can('viewer', 'project.inviteMember'), false);
});

test('非成員（role 為 undefined）一律拒絕', () => {
  assert.equal(can(undefined, 'canvas.read'), false);
  assert.equal(can(null, 'canvas.write'), false);
});

test('未知角色字串一律拒絕（防止 role 欄位被亂寫入）', () => {
  assert.equal(can('admin', 'canvas.read'), false);
  assert.equal(can('', 'canvas.read'), false);
});

test('isValidRole 只接受三種角色', () => {
  assert.equal(isValidRole('owner'), true);
  assert.equal(isValidRole('editor'), true);
  assert.equal(isValidRole('viewer'), true);
  assert.equal(isValidRole('teacher'), false);
});

test('canChangeRole：只有 owner 能改角色', () => {
  assert.equal(canChangeRole('owner', 'uid_B', 'uid_A', 'viewer'), true);
  assert.equal(canChangeRole('editor', 'uid_B', 'uid_A', 'viewer'), false);
  assert.equal(canChangeRole('viewer', 'uid_B', 'uid_A', 'editor'), false);
});

test('canChangeRole：owner 不能把自己降級（避免專案沒人能管理）', () => {
  assert.equal(canChangeRole('owner', 'uid_A', 'uid_A', 'editor'), false);
  assert.equal(canChangeRole('owner', 'uid_A', 'uid_A', 'owner'), true); // 原地不動允許
});

test('canChangeRole：拒絕非法角色字串', () => {
  assert.equal(canChangeRole('owner', 'uid_B', 'uid_A', 'teacher'), false);
});

test('teacher：可以檢視與設定 AI 權限，但不能改畫布、不能執行 Agent、不能管理成員', () => {
  for (const a of ['canvas.read', 'evidence.read', 'researchState.read', 'agentTrace.read', 'project.setAiLevel']) {
    assert.equal(can('teacher', a), true, `teacher 應允許 ${a}`);
  }
  for (const a of ['canvas.write', 'agent.execute', 'project.inviteMember', 'project.manageSettings']) {
    assert.equal(can('teacher', a), false, `teacher 不應允許 ${a}`);
  }
});

test('只有 teacher 能設定 AI 權限——owner 也不行（不能自己幫自己開權限）', () => {
  assert.equal(can('owner', 'project.setAiLevel'), false);
  assert.equal(can('editor', 'project.setAiLevel'), false);
});

test('canChangeRole：owner 不能更動老師的角色', () => {
  assert.equal(canChangeRole('owner', 'uid_T', 'uid_A', 'viewer', 'teacher'), false);
  assert.equal(canChangeRole('owner', 'uid_B', 'uid_A', 'viewer', 'editor'), true);
});
