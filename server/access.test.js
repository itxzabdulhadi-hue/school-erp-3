import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, allCrud, userRolesFor } from './access.js';

test('role assignment maps person types to one school portal role', () => {
  assert.deepEqual(userRolesFor('student'), ['student']);
  assert.deepEqual(userRolesFor('teacher'), ['teacher']);
  assert.deepEqual(userRolesFor('accountant'), ['accountant']);
  assert.deepEqual(userRolesFor('transport_manager'), ['transport_manager']);
});

test('unrecognized employee types default to the least-privileged staff role', () => {
  assert.deepEqual(userRolesFor('unknown'), ['staff']);
  assert.deepEqual(userRolesFor('staff'), ['staff']);
});

test('permission action vocabulary is explicit and CRUD grants do not include approval', () => {
  assert.deepEqual(ACTIONS, ['view', 'create', 'edit', 'delete', 'approve', 'export']);
  assert.deepEqual(allCrud('students'), [
    'students.view', 'students.create', 'students.edit', 'students.delete', 'students.export',
  ]);
});
