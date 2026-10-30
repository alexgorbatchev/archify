import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { windowsPathRepositoryEvidence } from '../scripts/windows-path-evidence.mjs';
import { verifyRepositoryEvidence } from '../archify/renderers/shared/repository-evidence.mjs';
import { fixture, git } from './helpers/repository-evidence-fixture.mjs';

test('controlled path evidence verifies the actual fork and still rejects a different origin', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  git(data.root, 'remote', 'set-url', 'origin', 'https://github.com/alexgorbatchev/archify');
  data.diagram.meta.repository = windowsPathRepositoryEvidence(data.root);
  assert.equal(verifyRepositoryEvidence('architecture', data.diagram, data.root).verified, true);
  data.diagram.meta.repository.url = 'https://github.com/tt-a1i/archify';
  assert.throws(() => verifyRepositoryEvidence('architecture', data.diagram, data.root), /origin .* does not match/);
  git(data.root, 'remote', 'set-url', 'origin', '/not/a/public/repository');
  assert.throws(() => windowsPathRepositoryEvidence(data.root), /valid origin remote/);
});
