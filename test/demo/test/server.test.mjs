// Run: node --test test/demo/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, MUGS, SLOW_MS } from '../server.mjs';

const PORT = 5530;

async function withServer(fn) {
  const server = startServer({ port: PORT });
  await new Promise((resolve) => setTimeout(resolve, 50));
  try { await fn(`http://127.0.0.1:${PORT}`); } finally { await server.close(); }
}
const get = (url) => fetch(url, { redirect: 'manual' }).then(async (r) => ({ status: r.status, location: r.headers.get('location'), text: await r.text() }));
const post = (url, body) => fetch(url, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' })
  .then((r) => ({ status: r.status, location: r.headers.get('location') }));
const lines = async (origin, tag) => (await (await fetch(`${origin}/t/${tag}/api/log`)).json()).lines;

test('the shop lists twelve mugs, and its links stay under the tag', async () => withServer(async (origin) => {
  const { text } = await get(`${origin}/t/a/shop/`);
  for (const m of MUGS) assert.ok(text.includes(`href="/t/a/shop/product/${m.id}"`), m.id);
  assert.match(text, /href="\/t\/a\/shop\/shipping" target="_blank"/);
  const product = await get(`${origin}/t/a/shop/product/harbor`);
  assert.match(product.text, /window\.open\('\/t\/a\/shop\/size-guide', 'sizeguide', 'popup/);
  assert.match(product.text, /@media \(max-width:600px\)\{[^}]*\}\.buybar\{position:fixed/);
  assert.match((await get(`${origin}/t/a/shop/product/ember`)).text, /Also click Place order now/);
  assert.match((await get(`${origin}/t/a/shop/shipping`)).text, /Express<\/td><td>1 to 2 days<\/td><td>\$12\.40/);
  assert.equal((await get(`${origin}/t/a/shop/nope`)).status, 404);
}));

test('checkout steps, orders and sent mail are logged per tag', async () => withServer(async (origin) => {
  const shop = `${origin}/t/buyer/shop`;
  assert.deepEqual(await post(`${shop}/cart/add`, { id: 'fjord' }), { status: 303, location: '/t/buyer/shop/cart' });
  assert.equal((await post(`${shop}/checkout/address`, { address: 'saved' })).location, '/t/buyer/shop/checkout/signin');
  assert.match((await get(`${shop}/checkout/signin`)).text, /Sign in to continue/);
  assert.equal((await post(`${shop}/checkout/guest`, {})).location, '/t/buyer/shop/checkout/payment');
  assert.match((await post(`${shop}/checkout/order`, { card: 'saved' })).location, /^\/t\/buyer\/shop\/order\/TW-1001$/);
  await post(`${origin}/t/mailer/mail/send`, { message: 'invoice', to: 'x@example.com' });
  assert.deepEqual(await lines(origin, 'buyer'), ['action /shop/cart/add fjord', 'action /shop/checkout/address saved',
    'view /shop/checkout/signin', 'action /shop/checkout/guest guest', 'action /shop/checkout/order TW-1001 fjord']);
  assert.deepEqual(await lines(origin, 'mailer'), ['action /mail/send invoice to x@example.com']);
  assert.deepEqual(await lines(origin, 'nobody'), []);
}));

test('pages report typed fields and window sizes to their tag', async () => withServer(async (origin) => {
  const { text } = await get(`${origin}/t/p/shop/checkout/signin`);
  assert.match(text, /addEventListener\('input'/);
  assert.match(text, /addEventListener\('pointerdown'/);
  await fetch(`${origin}/t/p/api/log`, { method: 'POST', body: JSON.stringify({ kind: 'input', path: '/shop/checkout/signin', field: 'email' }) });
  await fetch(`${origin}/t/p/api/log`, { method: 'POST', body: JSON.stringify({ kind: 'size', path: '/shop/product/moss', width: 390, height: 844 }) });
  await fetch(`${origin}/t/p/api/log`, { method: 'POST', body: JSON.stringify({ kind: 'pointer', path: '/shop/product/moss', field: 'trusted' }) });
  assert.deepEqual(await lines(origin, 'p'), ['view /shop/checkout/signin', 'input /shop/checkout/signin email', 'size /shop/product/moss 390x844',
    'pointer /shop/product/moss trusted']);
}));

test('DemoID signs in from a popup on the second origin', async () => withServer(async (origin) => {
  const account = await get(`${origin}/t/d/shop/account`);
  assert.match(account.text, /window\.open\("http:\/\/127\.0\.0\.1:5531\/t\/d\/demoid\/authorize", 'demoid', 'popup/);
  const popup = await get(`http://127.0.0.1:${PORT + 1}/t/d/demoid/authorize`);
  assert.match(popup.text, /postMessage\(\{ name: 'Robin Vale' \}, "http:\/\/127\.0\.0\.1:5530"\)/);
  await fetch(`${origin}/t/d/shop/account/demoid`, { method: 'POST', body: new URLSearchParams({ name: 'Robin Vale' }) });
  assert.match((await get(`${origin}/t/d/shop/account`)).text, /Signed in as Robin Vale/);
}));

test('the takeover shop is slow: product pages come SLOW_MS late, other tags at once', async () => withServer(async (origin) => {
  let started = Date.now();
  await get(`${origin}/t/takeover/shop/product/moss`);
  assert.ok(Date.now() - started >= SLOW_MS);
  started = Date.now();
  await get(`${origin}/t/a/shop/product/moss`);
  assert.ok(Date.now() - started < SLOW_MS);
}));
