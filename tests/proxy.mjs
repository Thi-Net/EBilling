import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../api/proxy.js', import.meta.url), 'utf8');
const SCRIPT_URL = 'https://script.google.com/macros/s/test-deployment/exec';
const actions = ['login', 'logout', 'dashboardClient', 'dashboardAdmin', 'kirimKeluhan', 'updateBroadcast', 'updateStatusKeluhan', 'generateInvoiceMidtrans'];
let checks = 0;
async function request(overrides = {}, env = { SCRIPT_URL }, upstream) {
  const calls = [];
  const context = vm.createContext({
    process: { env }, URL, URLSearchParams, AbortController,
    setTimeout: (fn) => setTimeout(fn, 10), clearTimeout,
    fetch: async (...args) => {
      calls.push(args);
      return upstream ? upstream(...args) : { ok: true, status: 200, text: async () => JSON.stringify({ success: true, token: 'opaque-token' }) };
    }
  });
  vm.runInContext(source.replace('export default async function handler', 'async function handler'), context);
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(n) { this.statusCode = n; return this; }, json(data) { this.data = data; return this; }, send(data) { this.data = typeof data === 'string' ? JSON.parse(data) : data; return this; } };
  await context.handler({ method: 'POST', url: '/api/proxy', query: {}, body: { action: 'login', id: 'User1', password: 'test-password' }, ...overrides }, res);
  assert.equal(res.headers['cache-control'], 'no-store');
  return { res, calls };
}
async function test(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }

await test('POST login forwards fixed URL and JSON body', async () => {
  const { res, calls } = await request();
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.token, 'opaque-token');
  assert.equal(calls[0][0], SCRIPT_URL);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), { action: 'login', id: 'User1', password: 'test-password' });
});
await test('all known actions forwarded; backend owns authentication', async () => {
  for (const action of actions) {
    const { res, calls } = await request({ body: { action, token: 'opaque-token' } });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
  }
});
await test('non-POST methods rejected without upstream call', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', undefined]) {
    const { res, calls } = await request({ method });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST');
    assert.equal(calls.length, 0);
  }
});
await test('queries rejected, never forwarded', async () => {
  for (const overrides of [{ query: { action: 'login' } }, { query: { arbitrary: 'x' } }, { url: '/api/proxy?password=secret' }, { url: '/api/proxy?%61ction=login' }]) {
    const { res, calls } = await request(overrides);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  }
});
await test('malformed bodies and actions rejected', async () => {
  for (const body of [undefined, null, [], 7, '{', '{}', {}, { action: 'unknown' }, { action: ['login'] }, { action: '' }, { action: null }, { action: '__proto__' }]) {
    const { res, calls } = await request({ body });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  }
  const { calls } = await request({ body: JSON.stringify({ action: 'login', id: 'User1', password: 'test-password' }) });
  assert.equal(JSON.parse(calls[0][1].body).action, 'login');
});
const webhook = { order_id: 'test-order', status_code: '200', gross_amount: '100000.00', signature_key: 'a'.repeat(128), transaction_status: 'settlement' };
await test('only shaped no-action webhook reaches backend signature check', async () => {
  assert.equal((await request({ body: webhook })).calls.length, 1);
  const failed = await request({ body: webhook }, { SCRIPT_URL }, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: false, message: 'settlement check failed' }) }));
  assert.equal(failed.res.statusCode, 502, 'webhook failure must trigger provider retry');
  assert.equal(failed.res.headers['retry-after'], '30');
  for (const key of Object.keys(webhook)) {
    const body = { ...webhook }; delete body[key];
    const { res, calls } = await request({ body });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  }
  assert.equal((await request({ body: { ...webhook, action: '' } })).res.statusCode, 400);
  assert.equal((await request({ body: { ...webhook, signature_key: 123 } })).res.statusCode, 400);
});
await test('missing or unsafe config fails closed', async () => {
  for (const value of [undefined, '', 'http://script.google.com/macros/s/id/exec', 'https://evil.test/macros/s/id/exec', 'https://script.google.com.evil.test/macros/s/id/exec', 'https://user:pass@script.google.com/macros/s/id/exec', SCRIPT_URL + '?action=login', SCRIPT_URL + '#x', 'https://script.google.com/macros/s/id/dev', 'https://script.google.com:8443/macros/s/id/exec']) {
    const { res, calls } = await request({}, { SCRIPT_URL: value });
    assert.equal(res.statusCode, 500);
    assert.equal(calls.length, 0);
    assert.ok(!JSON.stringify(res.data).includes('SCRIPT_URL'));
  }
});
await test('upstream HTTP, malformed JSON, and network errors sanitized', async () => {
  for (const upstream of [async () => { throw new Error('secret upstream detail'); }, async () => ({ ok: false, status: 403, text: async () => 'secret upstream detail' }), async () => ({ ok: true, status: 200, text: async () => '<html>secret upstream detail</html>' }), async () => ({ ok: true, status: 200, text: async () => 'null' })]) {
    const { res } = await request({}, { SCRIPT_URL }, upstream);
    assert.equal(res.statusCode, 502);
    assert.equal(res.data.success, false);
    assert.equal(typeof res.data.message, 'string');
    assert.ok(!JSON.stringify(res.data).includes('secret'));
  }
});
await test('timeout aborts upstream, including body read', async () => {
  for (const duringBody of [false, true]) {
    const { res } = await request({}, { SCRIPT_URL }, async (_url, init) => {
      const pending = () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('secret timeout'), { name: 'AbortError' }))));
      return duringBody ? { ok: true, status: 200, text: pending } : pending();
    });
    assert.equal(res.statusCode, 504);
    assert.equal(res.data.success, false);
  }
});
function page(file, stored, result = { success: true }) {
  const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const elements = new Map();
  const calls = [];
  const storage = new Map(stored === undefined ? [] : [['billing_session', stored]]);
  const context = vm.createContext({
    URL, Intl, console,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', className: '', addEventListener() {}, querySelectorAll() { return []; }, reset() {} });
      return elements.get(id);
    } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    window: { location: { origin: 'https://local.test', href: '' }, setInterval() {}, setTimeout(fn) { fn(); }, open() {} },
    alert() {}, fetch: async (url, init) => { calls.push({ url, ...init }); return { ok: true, json: async () => result }; }
  });
  vm.runInContext(script, context, { filename: file });
  for (const id of ['userId', 'password']) context.document.getElementById(id);
  return { context, elements, calls, storage };
}
await test('login sends password only in POST JSON and saves token', async () => {
  const p = page('index.html', undefined, { success: true, role: 'client', token: 'opaque-token', user: { id: 'User1', nama: 'User' } });
  p.elements.get('userId').value = 'User1'; p.elements.get('password').value = ' test-password ';
  await vm.runInContext('handleLogin({ preventDefault() {} })', p.context);
  assert.equal(p.calls[0].url, '/api/proxy');
  assert.equal(p.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(p.calls[0].body), { action: 'login', id: 'User1', password: ' test-password ' });
  assert.equal(JSON.parse(p.storage.get('billing_session')).token, 'opaque-token');
  const missing = page('index.html', undefined, { success: true, role: 'client', user: { id: 'User1', nama: 'User' } });
  missing.elements.get('userId').value = 'User1'; missing.elements.get('password').value = 'test-password';
  await vm.runInContext('handleLogin({ preventDefault() {} })', missing.context);
  assert.equal(missing.storage.has('billing_session'), false);
});
await test('dashboard rejects absent, legacy, and malformed sessions', async () => {
  for (const file of ['admin.html', 'dashboard.html']) {
    for (const stored of [undefined, '{', 'null', JSON.stringify({ role: file === 'admin.html' ? 'admin' : 'client', id: 'User1' })]) {
      const p = page(file, stored);
      assert.equal(p.context.window.location.href, 'index.html');
      assert.equal(p.calls.length, 0);
    }
  }
});
await test('dashboard and protected requests POST session token; logout revokes', async () => {
  for (const file of ['admin.html', 'dashboard.html']) {
    const p = page(file, JSON.stringify({ role: file === 'admin.html' ? 'admin' : 'client', id: 'User1', token: 'opaque-token' }));
    assert.equal(p.calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(p.calls[0].body), { action: file === 'admin.html' ? 'dashboardAdmin' : 'dashboardClient', token: 'opaque-token' });
    await vm.runInContext('postJson({action: "kirimKeluhan", token: "wrong", pesan: "test"})', p.context);
    assert.equal(JSON.parse(p.calls[1].body).token, 'opaque-token');
    await vm.runInContext('logout()', p.context);
    assert.equal(JSON.parse(p.calls[2].body).action, 'logout');
    assert.equal(JSON.parse(p.calls[2].body).token, 'opaque-token');
    assert.equal(p.storage.has('billing_session'), false);
  }
});
await test('untrusted table, history, broadcast and ticket values escaped', async () => {
  const value = `<unsafe attr="quoted" data-test='single'>&`;
  for (const file of ['admin.html', 'dashboard.html']) {
    const p = page(file);
    p.context.input = value;
    if (file === 'admin.html') {
      vm.runInContext('renderCustomers([{id:input,nama:input,paket:input,statusSistem:input,tglJatuhTempo:input,statusPembayaran:input,noWhatsApp:input}]); renderTickets([{idTiket:input,nama:input,idPelanggan:input,tgl:input,status:input,pesan:input}]);', p.context);
    } else {
      vm.runInContext('renderHistory([{orderId:input,tgl:input,metode:input,status:input}]); renderBroadcast([{pesan:input}]);', p.context);
    }
    for (const id of file === 'admin.html' ? ['customerTableBody', 'ticketList'] : ['historyList', 'broadcastList']) {
      const rendered = p.elements.get(id).innerHTML;
      assert.ok(!rendered.includes('<unsafe'), id);
      assert.ok(rendered.includes('&lt;unsafe'), id);
      assert.ok(!rendered.includes('attr="quoted"'), id);
    }
    if (file === 'admin.html') assert.ok(p.elements.get('ticketList').innerHTML.includes('data-ticket="&lt;unsafe attr=&quot;quoted&quot; data-test=&#39;single&#39;&gt;&amp;"'));
  }
});
console.log(`${checks} checks passed (VM/stub upstream; no live requests).`);
