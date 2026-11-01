import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseRepositoryRemote } from '../archify/renderers/shared/repository-location.mjs';

export function windowsPathRepositoryEvidence(repoRoot) {
  const origin = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const location = parseRepositoryRemote(origin);
  assert.ok(location, 'controlled repository evidence requires a valid origin remote');
  const revision = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { url: location.url, revision };
}
