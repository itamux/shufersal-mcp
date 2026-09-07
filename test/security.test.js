import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedRequest, loginPlaceholders, Shufersal, HOME, LOGIN_POST, EMAIL, PASSWORD } from '../shufersal.js';

const body = new URLSearchParams({ j_username: EMAIL, j_password: PASSWORD, CSRFToken: 'fixture' }).toString();
test('only an armed login POST can carry the placeholders', () => {
  assert.equal(allowedRequest(LOGIN_POST, 'POST', true, body), true);
  for (const [url, method, pending, data] of [
    [LOGIN_POST, 'POST', false, body], [LOGIN_POST + '?redirect=x', 'POST', true, body],
    [HOME + 'cart/add', 'POST', true, body], ['file:///etc/hosts', 'GET'],
    ['http://127.0.0.1/', 'GET'], ['https://www.shufersal.co.il.evil.invalid/', 'GET'],
    [HOME + 'logout', 'GET'], [LOGIN_POST, 'POST', true, body + '&j_username=other'],
  ]) assert.equal(allowedRequest(url, method, pending, data), false);
});
test('consumer environment rejects actual values and missing placeholders', () => {
  assert.deepEqual(loginPlaceholders({ SHUFERSAL_EMAIL: EMAIL, SHUFERSAL_PASSWORD: PASSWORD }), { email: EMAIL, password: PASSWORD });
  assert.throws(() => loginPlaceholders({ SHUFERSAL_EMAIL: 'fixture@example.invalid', SHUFERSAL_PASSWORD: 'fixture-only' }), /placeholders/);
  assert.throws(() => loginPlaceholders({}), /placeholders/);
});
test('a failed operation does not strand subsequent work', async () => {
  const s = new Shufersal(); const order = [];
  const a = s.run(async () => { order.push('first'); throw Error('fixture'); });
  const b = s.run(async () => { order.push('second'); return 2; });
  await assert.rejects(a); assert.equal(await b, 2); assert.deepEqual(order, ['first', 'second']);
});

test('native cart restore is admitted without transaction or merge parameters',()=>{
  assert.equal(allowedRequest(HOME+'cart/load?restoreCart=true','GET'),true);
  for(const path of ['cart/load?restoreCart=false','cart/load?restoreCart=true&executeTransaction=true','cart/load?restoreCart=true&restoreCart=true','cart/merge?toMerge=true','cart/transaction-load','cart/hard-load']) assert.equal(allowedRequest(HOME+path,'GET'),false);
});
