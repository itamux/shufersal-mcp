import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedRequest, loginCredentials, Shufersal, HOME, LOGIN_POST } from '../shufersal.js';
const EMAIL = 'fixture@example.invalid';
const PASSWORD = 'fixture-password&=with spaces';
const pending = { email: EMAIL, password: PASSWORD };

const body = new URLSearchParams({ j_username: EMAIL, j_password: PASSWORD, CSRFToken: 'fixture' }).toString();
test('only an armed login POST can carry the configured credentials', () => {
  assert.equal(allowedRequest(LOGIN_POST, 'POST', pending, body), true);
  for (const [url, method, armed, data] of [
    [LOGIN_POST, 'POST', false, body], [LOGIN_POST + '?redirect=x', 'POST', pending, body],
    [HOME + 'cart/add', 'POST', pending, body], ['file:///etc/hosts', 'GET'],
    ['http://127.0.0.1/', 'GET'], ['https://www.shufersal.co.il.evil.invalid/', 'GET'],
    [HOME + 'logout', 'GET'], [LOGIN_POST, 'POST', pending, body + '&j_username=other'],
    [LOGIN_POST, 'POST', pending, body + '&j_password=other'],
    [LOGIN_POST, 'POST', { email: EMAIL, password: 'different' }, body],
  ]) assert.equal(allowedRequest(url, method, armed, data), false);
});
test('credentials come from ordinary environment values and missing values fail', () => {
  assert.deepEqual(loginCredentials({ SHUFERSAL_EMAIL: EMAIL, SHUFERSAL_PASSWORD: PASSWORD }), { email: EMAIL, password: PASSWORD });
  assert.equal(allowedRequest(LOGIN_POST, 'POST', pending, body.replace('j_password=', 'wrong=')), false);
  assert.throws(() => loginCredentials({}), /SHUFERSAL_EMAIL/);
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
