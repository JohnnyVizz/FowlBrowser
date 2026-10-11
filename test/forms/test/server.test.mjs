// node --test test/forms/test/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { startServer } from '../server.mjs';

const { forms, personas } = JSON.parse(fs.readFileSync(new URL('../personas.json', import.meta.url), 'utf8'));
const port = 25413;
const base = `http://127.0.0.1:${port}`;
let server;
test.before(() => { server = startServer({ port }); });
test.after(() => server.close());

const post = async (form, body) => (await fetch(`${base}/submit/${form}`, { method: 'POST', body: JSON.stringify(body) })).json();
const grade = async (token) => (await fetch(`${base}/grade/${token}`)).json();

test('every persona has every field of its form', () => {
  assert.equal(Object.keys(personas).length, 12);
  for (const [token, p] of Object.entries(personas)) {
    assert.deepEqual(Object.keys(p.fields).sort(), [...forms[p.form].fields].sort(), token);
    assert.equal(p.fields.reference, token);
  }
  for (const form of Object.keys(forms)) {
    const two = Object.values(personas).filter((p) => p.form === form).map((p) => p.browser).sort();
    assert.deepEqual(two, ['chrome', 'helium'], form);
  }
});

test('no submission yet: not ok, nothing scored', async () => {
  const g = await grade('p01');
  assert.equal(g.ok, false);
  assert.equal(g.submissions, 0);
  assert.equal(g.score, 0);
});

for (const [token, p] of Object.entries(personas)) {
  test(`${p.form} ${token}: correct payload scores full, a wrong one names the field`, async () => {
    const { id } = await post(p.form, p.fields);
    assert.match(id, /^SUB-/);
    let g = await grade(token);
    assert.equal(g.ok, true, JSON.stringify(g.fields.filter((f) => !f.ok)));
    assert.equal(g.score, g.total);
    assert.equal(g.id, id);
    // the extra fields a page sends (attachmentBytes) are not graded
    const wrongField = forms[p.form].fields.find((f) => f !== 'reference');
    await post(p.form, { ...p.fields, [wrongField]: 'wrong value', attachmentBytes: 628 });
    g = await grade(token);
    assert.equal(g.ok, false);
    assert.equal(g.score, g.total - 1);
    assert.deepEqual(g.fields.filter((f) => !f.ok).map((f) => f.name), [wrongField]);
    assert.equal(g.submissions, 2);
    assert.deepEqual(g.crossTalk, []);
  });
}

test('the token decides the persona; a submission to the wrong form is not ok', async () => {
  await post('checkout', personas.p01.fields);
  const g = await grade('p01');
  assert.equal(g.ok, false);
  assert.equal(g.submittedForm, 'checkout');
});

test("another persona's value in my submission is cross-talk", async () => {
  await post('travel', { ...personas.p01.fields, email: personas.p02.fields.email, fullName: personas.p05.fields.fullName });
  const g = await grade('p01');
  assert.equal(g.ok, false);
  assert.deepEqual(g.crossTalk, [
    { field: 'fullName', value: 'aiko brennan', persona: 'p05' },
    { field: 'email', value: 'tomas.lind@example.org', persona: 'p02' },
  ]);
  // a shared value (both settings personas have the same priority items) is never cross-talk
  await post('settings', { ...personas.p07.fields, priorities: personas.p08.fields.priorities });
  assert.deepEqual((await grade('p07')).crossTalk, []);
});

test('grades lists every persona; pages and files are served', async () => {
  const all = await (await fetch(`${base}/grades`)).json();
  assert.equal(Object.keys(all).length, 12);
  for (const page of ['travel', 'checkout', 'signup', 'settings', 'survey', 'support']) {
    const res = await fetch(`${base}/${page}`);
    assert.equal(res.status, 200, page);
    assert.match(await res.text(), /Reference code/, page);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port + 1}/payment.html`)).status, 200);
  assert.equal((await fetch(`${base}/files/receipt.pdf`)).headers.get('content-type'), 'application/pdf');
  assert.equal((await fetch(`${base}/../personas.json`)).status, 404);
});
