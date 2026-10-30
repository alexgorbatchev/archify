import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const shell = workflow.jobs['published-update-manifest'].steps.find((step) => step.name === 'Public notifier manifest must reference an existing stable Release').run;

test('published manifest gate follows its validated source rather than the running fork', {
  skip: process.platform === 'win32' ? 'the published manifest job executes in Ubuntu Bash' : false,
}, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-manifest-authority-'));
  const source = path.join(temporary, 'published');
  const checkout = path.join(temporary, 'fork');
  const bin = path.join(temporary, 'bin');
  const requests = path.join(temporary, 'requests');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  try {
    for (const directory of [source, checkout, bin]) fs.mkdirSync(directory);
    fs.mkdirSync(path.join(source, 'archify'));
    fs.writeFileSync(path.join(source, 'archify/package.json'), '{"version":"3.0.0"}');
    const archive = Buffer.from('published archive fixture');
    fs.writeFileSync(path.join(source, 'archify.zip'), archive);
    fs.mkdirSync(path.join(source, 'scripts'));
    fs.writeFileSync(path.join(source, 'scripts/stage-clean-skill.mjs'), '');
    fs.writeFileSync(path.join(source, 'scripts/write-deterministic-zip.mjs'), '');
    fs.writeFileSync(path.join(source, 'scripts/build-zip.sh'), '#!/bin/sh\ncp "$(dirname "$0")/../archify.zip" "$1"\n', { mode: 0o755 });
    git(source, 'init');
    git(source, 'add', '.');
    git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'published');
    git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'v3.0.0', '-m', 'published');
    const manifest = {
      schemaVersion: 1, skillId: 'archify', channel: 'stable', version: '3.0.0',
      publishedAt: new Date(Number(git(source, 'for-each-ref', '--format=%(taggerdate:unix)', 'refs/tags/v3.0.0')) * 1000).toISOString().replace('.000Z', 'Z'),
      source: { repository: 'https://github.com/tt-a1i/archify', ref: 'v3.0.0', treeSha: git(source, 'rev-parse', 'HEAD:archify') },
      artifact: { sha256: crypto.createHash('sha256').update(archive).digest('hex') },
      summary: 'Published fixture.', releaseNotes: 'https://github.com/tt-a1i/archify/releases/tag/v3.0.0', severity: 'normal',
    };
    git(checkout, 'init');
    git(checkout, 'remote', 'add', 'origin', 'https://github.com/example/fork');
    for (const relative of ['archify/scripts/update-contract.mjs', 'scripts/check-stable-update-manifest.mjs']) {
      fs.mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
      fs.copyFileSync(path.join(root, relative), path.join(checkout, relative));
    }
    fs.mkdirSync(path.join(checkout, 'docs/skill-updates/archify'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'archify/package.json'), '{"version":"9.0.0-dev.0"}');
    const manifestPath = path.join(checkout, 'docs/skill-updates/archify/stable.json');
    const gh = `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2); fs.appendFileSync(process.env.REQUESTS, JSON.stringify(args)+'\\n');
const endpoint = args[1];
if (endpoint === 'repos/tt-a1i/archify/releases/latest') console.log('v3.0.0');
else if (endpoint === 'repos/tt-a1i/archify/releases/tags/v3.0.0') console.log('17');
else if (endpoint === 'repos/tt-a1i/archify/releases/assets/17') process.stdout.write(fs.readFileSync(process.env.PUBLISHED_ARCHIVE));
else { console.error('wrong release authority: '+endpoint); process.exit(1); }
`;
    fs.writeFileSync(path.join(bin, 'gh'), gh, { mode: 0o755 });
    const environment = {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: 'example/fork',
      RUNNER_TEMP: temporary, REQUESTS: requests, PUBLISHED_ARCHIVE: path.join(source, 'archify.zip'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${source}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/tt-a1i/archify',
    };
    const run = (value) => {
      fs.writeFileSync(manifestPath, JSON.stringify(value));
      return spawnSync('bash', ['-c', shell], { cwd: checkout, env: environment, encoding: 'utf8' });
    };
    const passing = run(manifest);
    assert.equal(passing.status, 0, `${passing.stdout}\n${passing.stderr}`);
    assert.match(passing.stdout, /stable update manifest ok: v3\.0\.0/);
    assert.equal(fs.readFileSync(requests, 'utf8').trim().split('\n').length, 3);
    const acceptedRequests = fs.readFileSync(requests, 'utf8');
    for (const sourceIdentity of [
      { ...manifest.source, repository: 'https://github.com/example/attacker' },
      { ...manifest.source, ref: 'main' },
    ]) {
      const rejected = run({ ...manifest, source: sourceIdentity });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /invalid immutable stable release identity/);
      assert.equal(fs.readFileSync(requests, 'utf8'), acceptedRequests, 'invalid identity must fail before network access');
    }
    for (const invalid of [
      { ...manifest, source: { ...manifest.source, treeSha: 'c'.repeat(40) } },
      { ...manifest, artifact: { sha256: 'c'.repeat(64) } },
    ]) {
      const rejected = run(invalid);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /stable update manifest (?:treeSha|archive sha256) .* does not match/);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
