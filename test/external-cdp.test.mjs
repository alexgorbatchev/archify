import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChromeVisualBrowser, runBrowserCheck } from '../archify/bin/visual-check.mjs';
import { WebSocketCdp } from '../archify/bin/cdp.mjs';

class BrowserSocket extends EventTarget {
  static instances = [];
  constructor() {
    super();
    this.commands = [];
    this.readyState = 0;
    BrowserSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }
  message(message) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  send(raw) {
    const command = JSON.parse(raw);
    this.commands.push(command);
    const results = {
      'Target.createBrowserContext': { browserContextId: 'owned-context' },
      'Target.createTarget': { targetId: `owned-tab-${this.commands.length}` },
      'Target.attachToTarget': { sessionId: 'owned-session' },
    };
    queueMicrotask(() => this.message({ id: command.id, result: results[command.method] || {} }));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

test('external CDP creates isolated targets and disposes only its owned context', async () => {
  const browser = new ChromeVisualBrowser(null, {
    cdpUrl: 'ws://localhost:9222/devtools/browser/test',
    WebSocketImpl: BrowserSocket,
    spawnImpl() { throw new Error('external CDP must not launch Chrome'); },
  });
  await browser.sessionPromise;
  const socket = BrowserSocket.instances.at(-1);
  await browser.resetPage();
  await browser.close();
  await browser.close();
  const methods = socket.commands.map(({ method }) => method);
  assert.equal(methods.includes('Target.getTargets'), false, 'never adopt a caller tab');
  assert.equal(methods.includes('Browser.close'), false, 'caller owns the browser');
  const targets = socket.commands.filter(({ method }) => method === 'Target.createTarget');
  assert.equal(targets.length, 2);
  assert.ok(targets.every(({ params }) => params.browserContextId === 'owned-context'));
  assert.deepEqual(socket.commands.filter(({ method }) => method === 'Target.disposeBrowserContext'), [
    { id: socket.commands.at(-1).id, method: 'Target.disposeBrowserContext', params: { browserContextId: 'owned-context' } },
  ]);
  assert.equal(socket.readyState, 3);
});

test('failed attachment still disposes the owned context and disconnects', async () => {
  class FailedAttachment extends BrowserSocket {
    send(raw) {
      const command = JSON.parse(raw);
      if (command.method !== 'Target.attachToTarget') return super.send(raw);
      this.commands.push(command);
      queueMicrotask(() => this.message({ id: command.id, error: { message: 'attachment refused' } }));
    }
  }
  const browser = new ChromeVisualBrowser(null, {
    cdpUrl: 'ws://localhost:9222/devtools/browser/test', WebSocketImpl: FailedAttachment,
  });
  await assert.rejects(browser.sessionPromise, /attachment refused/);
  const socket = BrowserSocket.instances.at(-1);
  await browser.close();
  assert.equal(socket.commands.at(-1).method, 'Target.disposeBrowserContext');
  assert.equal(socket.readyState, 3);
});

test('WebSocket CDP correlates replies, session events and protocol errors', async () => {
  const cdp = new WebSocketCdp('ws://localhost:9222', { WebSocketImpl: BrowserSocket });
  await cdp.ready;
  const socket = BrowserSocket.instances.at(-1);
  const received = [];
  const unsubscribe = cdp.subscribe((event) => received.push(event));
  const loaded = cdp.waitFor('Page.loadEventFired', 'ours');
  socket.message({ method: 'Page.loadEventFired', sessionId: 'theirs', params: { wrong: true } });
  socket.message({ method: 'Page.loadEventFired', sessionId: 'ours', params: { loaded: true } });
  assert.deepEqual(await loaded, { loaded: true });
  assert.equal(received.length, 2);
  unsubscribe();
  assert.deepEqual(await cdp.send('Page.enable', {}, 'ours'), {});
  assert.equal(socket.commands.at(-1).sessionId, 'ours');
  socket.send = (raw) => {
    const { id } = JSON.parse(raw);
    queueMicrotask(() => socket.message({ id, error: { message: 'unsupported' } }));
  };
  await assert.rejects(cdp.send('Unknown.command'), /Unknown.command: unsupported/);
  await cdp.close();
});

test('disconnect rejects pending commands and events, including subsequent sends', async () => {
  const cdp = new WebSocketCdp('ws://localhost:9222', { WebSocketImpl: BrowserSocket });
  await cdp.ready;
  const socket = BrowserSocket.instances.at(-1);
  socket.send = () => {};
  const command = assert.rejects(cdp.send('Page.enable'), /closed/);
  const event = assert.rejects(cdp.waitFor('Page.loadEventFired', 'ours'), /closed/);
  socket.close();
  await Promise.all([command, event]);
  await assert.rejects(cdp.send('Page.enable'), /closed/);
  await cdp.close();
});

test('connection timeout is bounded and does not disclose endpoint credentials', async () => {
  class SilentSocket extends EventTarget {
    readyState = 0;
    close() { this.readyState = 3; }
  }
  const cdp = new WebSocketCdp('wss://localhost/browser?token=secret', {
    WebSocketImpl: SilentSocket,
    timeoutMs: 10,
  });
  await assert.rejects(cdp.ready, (error) => /timed out/.test(error.message) && !error.message.includes('secret'));
  assert.equal(cdp.socket.readyState, 3);
  await cdp.close();
});

test('invalid external URL fails browser-check without attempting local discovery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-external-cdp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const artifactPath = path.join(directory, 'diagram.html');
  fs.writeFileSync(artifactPath, '<!doctype html><html><body>diagram</body></html>');
  const result = await runBrowserCheck({
    artifactPath,
    cdpUrl: 'https://localhost/?token=secret',
    resolveChrome() { throw new Error('must not discover Chrome'); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.receipt.status, 'fail');
  assert.match(result.receipt.error, /ARCHIFY_CDP_URL.*ws:\/\/.*wss:\/\//);
  assert.equal(JSON.stringify(result.receipt).includes('secret'), false);
});

test('protocol and event timeouts reject without poisoning the connection', async () => {
  const cdp = new WebSocketCdp('ws://localhost:9222', { WebSocketImpl: BrowserSocket });
  await cdp.ready;
  const socket = BrowserSocket.instances.at(-1);
  const send = socket.send.bind(socket);
  socket.send = () => {};
  await assert.rejects(cdp.send('Page.enable', {}, undefined, 10), { code: 'ERR_CHROME_CDP_TIMEOUT', method: 'Page.enable' });
  await assert.rejects(cdp.waitFor('Page.loadEventFired', 'ours', 10), /event timed out/);
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.waiters.length, 0);
  socket.send = send;
  assert.deepEqual(await cdp.send('Page.enable'), {});
  cdp.close();
});

test('malformed messages and failed writes reject active work', async () => {
  for (const raw of ['broken', 'null', '[]']) {
    const cdp = new WebSocketCdp('ws://localhost:9222', { WebSocketImpl: BrowserSocket });
    await cdp.ready;
    cdp.socket.send = () => {};
    const pending = assert.rejects(cdp.send('Page.enable'), /invalid JSON/);
    cdp.receive(raw);
    await pending;
    await assert.rejects(cdp.waitFor('Page.loadEventFired'), /invalid JSON/);
    cdp.close();
  }
  const cdp = new WebSocketCdp('ws://localhost:9222', { WebSocketImpl: BrowserSocket });
  await cdp.ready;
  cdp.socket.send = () => { throw new Error('socket is closed'); };
  await assert.rejects(cdp.send('Page.enable'), /write failed/);
  cdp.close();
});

test('unavailable WebSocket support and constructor failures explain the configuration failure', () => {
  assert.throws(() => new WebSocketCdp('ws://localhost:9222', { WebSocketImpl: null }), /Node.js 22/);
  class FailedSocket { constructor() { throw new Error('token=secret'); } }
  assert.throws(() => new WebSocketCdp('wss://localhost/?token=secret', { WebSocketImpl: FailedSocket }), (error) =>
    /could not open/.test(error.message) && !error.message.includes('secret'));
});
