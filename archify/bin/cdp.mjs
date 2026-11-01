// Shared CDP request/event handling for pipe and WebSocket transports.
export class CdpConnection {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.subscribers = new Set();
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    } catch {
      this.failAll(new Error('Chrome DevTools returned invalid JSON.'));
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    for (const subscriber of this.subscribers) subscriber(message);
    for (const waiter of [...this.waiters]) {
      if (waiter.method !== message.method) continue;
      if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message.params || {});
    }
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${method}: timed out after ${timeoutMs}ms`);
        error.code = 'ERR_CHROME_CDP_TIMEOUT';
        error.method = method;
        reject(this.failure('protocol timeout', error));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write(JSON.stringify(message));
      } catch (error) {
        this.failAll(this.failure('write', error));
      }
    });
  }

  waitFor(method, sessionId, timeoutMs = 15000) {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(this.failure('event timeout', new Error(`${method}: event timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  failAll(error) {
    this.closedError ||= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.waiters = [];
  }
}

export class WebSocketCdp extends CdpConnection {
  constructor(endpoint, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
    super();
    let url;
    try { url = new URL(endpoint); } catch { /* Report a credential-free configuration error below. */ }
    if (!url || !['ws:', 'wss:'].includes(url.protocol) || url.hash) {
      throw new Error('ARCHIFY_CDP_URL must be a browser CDP WebSocket URL beginning with ws:// or wss://.');
    }
    if (typeof WebSocketImpl !== 'function') {
      throw new Error('ARCHIFY_CDP_URL requires Node.js 22 or newer with native WebSocket support.');
    }
    try { this.socket = new WebSocketImpl(url.href); } catch {
      throw new Error('ARCHIFY_CDP_URL could not open a CDP WebSocket connection.');
    }
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = this.failure('connection', new Error(`timed out after ${timeoutMs}ms`));
        this.failAll(error);
        reject(error);
        this.socket.close();
      }, timeoutMs);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      const failed = (error) => {
        clearTimeout(timer);
        this.failAll(error);
        reject(error);
      };
      this.socket.addEventListener('error', () => failed(this.failure('connection', new Error('connection failed'))));
      this.socket.addEventListener('close', () => failed(this.failure('connection', new Error('connection closed'))));
    });
    this.socket.addEventListener('message', ({ data }) => this.receive(data));
  }

  failure(stage, error) {
    // Endpoints may contain credentials; never echo the endpoint or socket errors.
    const failure = new Error(`External Chrome DevTools ${stage} failed: ${error.message}`);
    if (error.code) failure.code = error.code;
    if (error.method) failure.method = error.method;
    return failure;
  }

  write(message) {
    try { this.socket.send(message); } catch {
      throw new Error('could not send CDP command');
    }
  }

  close() {
    this.failAll(new Error('visual-check finished'));
    this.socket.close();
  }
}
