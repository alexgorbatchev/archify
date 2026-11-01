import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Both development dependency roots compile schemas independently.
for (const [name, manifest] of [
  ['repository', new URL('../package.json', import.meta.url)],
  ['renderer', new URL('../archify/package.json', import.meta.url)],
]) {
  const require = createRequire(manifest);
  const uri = require('fast-uri');
  const Ajv2020 = require('ajv/dist/2020.js').default;

  test(`${name}: encoded schemes cannot become executable schemes`, () => {
    for (const input of ['%6Aavascript:alert(1)', '%u006Aavascript:alert(1)']) {
      assert.equal(uri.parse(input).error, 'URI scheme is malformed.');
      assert.equal(uri.normalize(input), input);
      assert.equal(uri.equal(input, 'javascript:alert(1)'), false);
      assert.throws(() => uri.resolve('https://example.org/base/', input), /URI scheme is malformed/);
    }
    assert.equal(uri.normalize('HTTPS://Example.org/path'), 'https://example.org/path');
  });

  test(`${name}: ambiguous domain hosts cannot silently change authority`, () => {
    for (const input of ['http://a@b@evil.example/', 'http://exa\tmple.org/']) {
      assert.equal(uri.parse(input).error, 'URI host is malformed.');
      assert.equal(uri.normalize(input), input);
      assert.equal(uri.equal(input, uri.normalize('http://evil.example/')), false);
      assert.throws(() => uri.resolve('http://trusted.example/', input), /URI host is malformed/);
    }
    assert.equal(uri.resolve('http://trusted.example/', '//user@example.org/path'), 'http://user@example.org/path');
  });

  test(`${name}: relative normalization preserves the resolved target`, () => {
    const base = 'https://example.org/parent/child/file';
    for (const input of ['a/../b', '../x', 'x/..', 'a/../a:b']) {
      const normalized = uri.normalize(input);
      assert.equal(uri.resolve(base, normalized), uri.resolve(base, input));
      assert.equal(uri.parse(normalized).scheme, undefined);
    }
    assert.equal(uri.equal('../x', 'x'), false);
    assert.equal(uri.equal('a/../b', '/b'), false);
  });

  test(`${name}: suffix references do not expose an executable scheme`, () => {
    const options = { reference: 'suffix', scheme: 'x' };
    for (const input of ['javascript:alert(1)', '%6Aavascript:alert(1)', 'data:text/html,x']) {
      const normalized = uri.normalize(input, options);
      assert.equal(uri.parse(normalized).scheme, undefined);
    }
    assert.equal(uri.normalize('path/to/file', options), 'path/to/file');
    assert.equal(uri.normalize('a/b:c', options), 'a/b:c');
  });

  test(`${name}: Ajv resolves registered relative schema references`, () => {
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema({
      $id: 'https://example.org/schemas/value.json',
      type: 'integer',
      minimum: 1,
    });
    const validate = ajv.compile({
      $id: 'https://example.org/schemas/nested/document.json',
      type: 'object',
      properties: { value: { $ref: '../value.json' } },
      required: ['value'],
      additionalProperties: false,
    });
    assert.equal(validate({ value: 1 }), true);
    assert.equal(validate({ value: 0 }), false);
    assert.equal(validate.errors[0].keyword, 'minimum');
    assert.equal(validate({ value: '1' }), false);
    assert.equal(validate.errors[0].keyword, 'type');
  });
}
