import test from 'node:test';
import assert from 'node:assert/strict';
import { Shufersal } from '../shufersal.js';
import { inspectShortages, OrderCareError } from '../order-care.js';
import { replacementLink, parseReplacementRequest, readReplacementRequest, recordReplacementSnapshot, reconcileReplacementViews, replacementEditGuard } from '../replacement-request.js';

const token = 'FIXTURE_PRIVATE_TOKEN_ONLY_123456';
const link = `https://services.shufersal.co.il/cfcalternative/?e=0&t=${token}`;
const website = { orderNumber: 'ORDER_1', items: [{ productCode: 'P_123', sellingMethod: 'BY_UNIT', name: 'Original', quantity: 1, stockSignal: 'out_of_stock' }] };
const wire = (overrides = {}) => ({ Error: { ErrorCode: 0, ErrorDescription: 'PRIVATE_ERROR' }, Content: {
  Order: [{ OrderNumber: 'ORDER_1', OrderTokenEnc: token, ClubID: 'PRIVATE_CLUB', IsExpired: false, IsReadOnly: false, CorrelateStatusCode: 0 }],
  Products: [{ ProductID: 123, ProductName: 'Original', RequestedQuantity: 1, CustomerCoordinationRequired: 6, Phone: 'PRIVATE_PHONE' }],
  AlternativeProducts: [{ ProductID: 456, ParentProductId: 123, ProductName: 'Replacement', RequestedQuantity: 2, CorrelateItemStatusCode: 1, OrderTokenEnc: token }], ...overrides,
} });
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('private links admit only the exact production host, path, environment and one token', () => {
  assert.deepEqual(replacementLink(link), { token, environment: '0' });
  for (const url of [link.replace('https:', 'http:'), link.replace('services.', 'evil.'), link.replace('cfcalternative/', 'other/'),
    link + '&t=OTHER_TOKEN_123456', link + '&e=0', link + '&redirect=evil', link + '#fragment', link.replace('e=0', 'e=1'),
    link.replace('https://', 'https://user:pass@'), link.replace(token, 'short')]) {
    assert.throws(() => replacementLink(url), OrderCareError);
  }
});

test('one fixed read POST, no redirects, no cookie or password headers, no token in output', async () => {
  const calls = [];
  const result = await readReplacementRequest(link, { fetcher: async (url, options) => {
    calls.push({ url, options }); return response(wire());
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://services.shufersal.co.il/CorrelateServer/api/Correlate/GetOrder');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { OrderTokenEnc: token, OrderNumber: null, Environment: '0' });
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ['accept', 'content-type']);
  assert.equal(result.alternatives[0].selection, 'selected'); assert.equal(result.submissionConfirmed, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|ClubID|Phone|OrderTokenEnc/);
});

test('errors and oversized or malformed payloads fail without exposing response details', async () => {
  for (const fetcher of [async () => { throw Error(token); }, async () => new Response(token, { status: 403 }),
    async () => response({ Error: { ErrorCode: 2, ErrorDescription: token } }),
    async () => response({ Error: { ErrorCode: 0 }, Content: {} }),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(readReplacementRequest(link, { fetcher }), error => error instanceof OrderCareError && !error.message.includes(token));
  }
  const expired = await readReplacementRequest(link, { fetcher: async () => response({ Error: { ErrorCode: 4, ErrorDescription: token } }) });
  assert.equal(expired.state, 'expired'); assert.equal(expired.orderNumber, null);
});

test('website shortage plus SMS choice is a discrepancy, not automatic evidence of failure', () => {
  const snapshot = recordReplacementSnapshot(parseReplacementRequest(wire()));
  const result = reconcileReplacementViews(website, inspectShortages(website), { snapshot, fresh: true, readState: 'read' });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].resolution, 'sms_replacement_reported');
  assert.equal(result.issues[0].needsReplacementDecision, null);
  assert.equal(result.websiteOrder.items[0].stockSignal, 'out_of_stock');
  assert.equal(result.replacementRequest.snapshot.alternatives[0].selection, 'selected');
  assert.equal(result.complete, false);
  const cached = reconcileReplacementViews(website, inspectShortages(website), { snapshot, fresh: false, readState: 'cached_not_rechecked' });
  assert.equal(cached.issues[0].resolution, 'sms_choice_previously_recorded');
  assert.equal(cached.issues[0].needsReplacementDecision, null);
});

test('lost choices and ambiguous alternatives are reported as conflicts and never reapplied', () => {
  const before = recordReplacementSnapshot(parseReplacementRequest(wire()));
  const after = recordReplacementSnapshot(parseReplacementRequest(wire({ AlternativeProducts: [] })), before);
  assert.equal(after.changesSincePreviousRead.removedOrChangedChoices.length, 1);
  const result = reconcileReplacementViews(website, inspectShortages(website), { snapshot: after, fresh: true, readState: 'read' });
  assert.equal(result.issues[0].resolution, 'conflicting_information');
  const disappeared = recordReplacementSnapshot(parseReplacementRequest(wire({ Products: [], AlternativeProducts: [] })), before);
  const noWebsiteRows = { ...website, items: [] };
  const lost = reconcileReplacementViews(noWebsiteRows, inspectShortages(noWebsiteRows), { snapshot: disappeared, fresh: true });
  assert.equal(lost.issues[0].resolution, 'conflicting_information');
  assert.equal(lost.issues[0].signals[0].kind, 'previous_choice_missing_or_changed');
  const guard = replacementEditGuard({ snapshot: before, fresh: true, readState: 'read' });
  assert.equal(guard.recordedChoices.length, 1); assert.equal(guard.canStartEdit, false);
  assert.ok(guard.requiredAfterSavingEdit.some(s => s.includes('never automatically')));
  const ambiguous = recordReplacementSnapshot(parseReplacementRequest(wire({ AlternativeProducts: [
    ...wire().Content.AlternativeProducts, { ProductID: 789, ParentProductId: 123, CorrelateItemStatusCode: 1 },
  ] })));
  assert.equal(reconcileReplacementViews(website, inspectShortages(website), { snapshot: ambiguous, fresh: true }).issues[0].resolution, 'conflicting_information');
});

test('foreign orders never reconcile; expiration and network failure retain prior choices as stale', async () => {
  let data = wire(), failure = false;
  const s = new Shufersal({ replacementFetch: async () => { if (failure) throw Error(token); return response(data); } });
  const snapshot = await s.replacementRequest(link);
  assert.equal(s.replacementSnapshots.size, 1);
  assert.doesNotMatch(JSON.stringify([...s.replacementSnapshots.values()]), /FIXTURE_PRIVATE|PRIVATE_CLUB/);
  await assert.rejects(s.replacementContext('FOREIGN', link), /different order/);
  assert.throws(() => reconcileReplacementViews({ ...website, orderNumber: 'FOREIGN' }, inspectShortages(website), { snapshot }), /different order/);
  data = { Error: { ErrorCode: 4 } };
  const expired = await s.replacementContext('ORDER_1', link);
  assert.equal(expired.fresh, false); assert.equal(expired.readState, 'expired'); assert.equal(expired.snapshot.recordedChoices.length, 1);
  failure = true;
  const failed = await s.replacementContext('ORDER_1', link);
  assert.equal(failed.readState, 'read_failed'); assert.equal(failed.snapshot.snapshotId, snapshot.snapshotId);
  assert.equal((await s.replacementContext('ORDER_1')).readState, 'cached_not_rechecked');
  await s.close();
});
