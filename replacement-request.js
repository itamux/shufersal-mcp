// The SMS application may submit automatically when rendered. Read its fixed
// GetOrder operation directly; never load the application or follow redirects.
import { createHash } from 'node:crypto';
import { OrderCareError } from './order-care.js';

const ENDPOINT = 'https://services.shufersal.co.il/CorrelateServer/api/Correlate/GetOrder';
const MAX_BYTES = 2 * 1024 * 1024;

export function replacementLink(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://services.shufersal.co.il' || url.pathname !== '/cfcalternative/'
      || url.username || url.password || url.hash || [...url.searchParams.keys()].some(k => !['e', 't'].includes(k))
      || url.searchParams.getAll('t').length !== 1 || url.searchParams.getAll('e').length > 1
      || (url.searchParams.has('e') && url.searchParams.get('e') !== '0')) throw Error();
    const token = url.searchParams.get('t');
    if (!/^[A-Za-z0-9_+/=-]{16,2048}$/.test(token)) throw Error();
    return { token, environment: '0' };
  } catch { throw new OrderCareError('Use the original HTTPS Shufersal replacement link with its single token and production environment.'); }
}

const code = value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
  : typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
const flag = value => value === true || value === 1 ? true : value === false || value === 0 ? false : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' ? value.slice(0, 500) : null;

export function parseReplacementRequest(data) {
  const errorCode = code(data?.Error?.ErrorCode);
  if (errorCode === '4') return { state: 'expired', orderNumber: null, checkedAt: new Date().toISOString(), products: [], alternatives: [], submissionConfirmed: false };
  if (errorCode !== '0') throw new OrderCareError('The replacement service did not return a readable request. No choices were submitted.');
  const content = data.Content;
  if (!Array.isArray(content?.Order) || content.Order.length !== 1 || !Array.isArray(content.Products)
    || (content.AlternativeProducts != null && !Array.isArray(content.AlternativeProducts))) {
    throw new OrderCareError('Replacement response format is not recognized. No choices were submitted.');
  }
  const order = content.Order[0];
  if (!order || typeof order !== 'object') throw new OrderCareError('Replacement response has no valid order record.');
  const orderNumber = code(order.OrderNumber);
  if (!orderNumber) throw new OrderCareError('Replacement response has no valid order identifier.');
  const product = p => {
    const productId = code(p?.ProductID);
    if (!productId) throw new OrderCareError('Replacement response has an invalid product identifier.');
    return { productId, name: text(p.ProductName), requestedQuantity: number(p.RequestedQuantity),
      unitDescription: text(p.UnitOfMeasureName), coordinationCode: code(p.CustomerCoordinationRequired),
      selectionCode: code(p.CorrelateItemStatusCode) };
  };
  const expired = flag(order.IsExpired), readOnly = flag(order.IsReadOnly);
  const statusCode = code(order.CorrelateStatusCode);
  const result = {
    orderNumber, checkedAt: new Date().toISOString(), expired, readOnly, statusCode,
    state: expired === true ? 'expired' : order.CorrelateValidityView ? 'restricted'
      : ['3', '5', '6'].includes(statusCode) ? 'finished'
      : readOnly === true ? 'read_only' : readOnly === false && expired === false ? 'open' : 'unknown',
    products: content.Products.map(product),
    alternatives: (content.AlternativeProducts || []).map(p => {
      const parentProductId = code(p.ParentProductId);
      if (!parentProductId) throw new OrderCareError('Replacement response has an invalid parent identifier.');
      return { ...product(p), parentProductId, maxQuantity: number(p.MaxQuantity),
        selection: code(p.CorrelateItemStatusCode) === '1' ? 'selected' : code(p.CorrelateItemStatusCode) === '2' ? 'rejected' : 'not_confirmed' };
    }),
    // Client terminal status codes do not prove the final basket was accepted.
    submissionConfirmed: false,
    complete: false,
    coverage: { products: 'read', alternatives: 'read', promotionGifts: 'not_projected', finalBasket: 'not_read' },
  };
  if (new Set(result.products.map(p => p.productId)).size !== result.products.length) {
    throw new OrderCareError('Replacement response contains ambiguous original products.');
  }
  result.note = 'These are replacement-service records, separate from website order items. A selected alternative is not proof of final basket confirmation or fulfillment.';
  return result;
}

export async function readReplacementRequest(url, { fetcher = fetch } = {}) {
  const { token, environment } = replacementLink(url);
  let data;
  try {
    const response = await fetcher(ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ OrderTokenEnc: token, OrderNumber: null, Environment: environment }),
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) throw Error();
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw Error();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new OrderCareError('Replacement request could not be read. No choices were submitted.'); }
  return parseReplacementRequest(data);
}

export function selectedChoices(snapshot) {
  return snapshot.alternatives.filter(p => p.selection === 'selected').map(p => ({
    originalProductId: p.parentProductId, replacementProductId: p.productId,
    quantity: p.requestedQuantity, unitDescription: p.unitDescription,
  }));
}

export function recordReplacementSnapshot(snapshot, previous = null) {
  const choices = selectedChoices(snapshot);
  const signature = choice => JSON.stringify(choice);
  const now = new Set(choices.map(signature));
  const previousChoices = previous ? selectedChoices(previous) : [];
  return { ...snapshot,
    snapshotId: createHash('sha256').update(JSON.stringify({ order: snapshot.orderNumber, checkedAt: snapshot.checkedAt, choices })).digest('hex'),
    recordedChoices: choices,
    changesSincePreviousRead: previous ? {
      previousSnapshotId: previous.snapshotId,
      removedOrChangedChoices: previousChoices.filter(c => !now.has(signature(c))),
      note: 'A changed choice may reflect an order edit, another client, or service state changes; no cause is inferred and nothing is reapplied.',
    } : null,
    retention: 'Sanitized snapshots only, in this MCP process memory. Links and tokens are not retained. Restarting clears the snapshots.',
  };
}

const productIdentity = value => /^P_\d+$/.test(value) ? value.slice(2) : value;

export function reconcileReplacementViews(order, report, { snapshot = null, fresh = false, readState = 'not_provided' } = {}) {
  if (snapshot && snapshot.orderNumber !== order.orderNumber) throw new OrderCareError('The SMS request belongs to a different order; it was not combined with this order.');
  const issues = report.issues.map(i => ({ ...i, signals: [...i.signals] }));
  const choices = snapshot ? selectedChoices(snapshot) : [];
  for (const product of snapshot?.products || []) {
    if (!['1', '2', '6', '10'].includes(product.coordinationCode)) continue;
    const matching = issues.filter(i => productIdentity(i.productCode) === product.productId);
    const signal = { source: 'sms_replacement_service', kind: 'coordination_required', coordinationCode: product.coordinationCode };
    if (matching.length) matching.forEach(i => i.signals.push(signal));
    else {
      const websiteRows = order.items.filter(i => productIdentity(i.productCode) === product.productId);
      issues.push({ productCode: websiteRows.length === 1 ? websiteRows[0].productCode : null,
        smsProductId: product.productId, name: product.name, sellingMethod: websiteRows.length === 1 ? websiteRows[0].sellingMethod : null,
        signals: [signal] });
    }
  }
  // Keep recorded/lost choices visible even when the website no longer lists
  // the original or the current SMS response has an empty product list.
  const ensureChoiceIssue = identity => {
    let issue = issues.find(i => (i.smsProductId || productIdentity(i.productCode)) === identity);
    if (!issue) {
      const rows = order.items.filter(i => productIdentity(i.productCode) === identity);
      issue = { productCode: rows.length === 1 ? rows[0].productCode : null, smsProductId: identity,
        sellingMethod: rows.length === 1 ? rows[0].sellingMethod : null,
        name: rows.length === 1 ? rows[0].name : null, signals: [] };
      issues.push(issue);
    }
    return issue;
  };
  for (const choice of choices) ensureChoiceIssue(choice.originalProductId).signals.push({ source: 'sms_replacement_service', kind: 'selection_reported' });
  for (const choice of snapshot?.changesSincePreviousRead?.removedOrChangedChoices || []) {
    ensureChoiceIssue(choice.originalProductId).signals.push({ source: 'sms_replacement_service', kind: 'previous_choice_missing_or_changed' });
  }
  for (const issue of issues) {
    const identity = issue.smsProductId || productIdentity(issue.productCode);
    const selected = choices.filter(c => c.originalProductId === identity);
    const removed = snapshot?.changesSincePreviousRead?.removedOrChangedChoices?.filter(c => c.originalProductId === identity) || [];
    const websiteRows = order.items.filter(i => productIdentity(i.productCode) === identity);
    issue.smsChoices = selected;
    issue.resolution = selected.length > 1 || removed.length || (selected.length && websiteRows.length !== 1)
      ? 'conflicting_information' : selected.length ? fresh ? 'sms_replacement_reported' : 'sms_choice_previously_recorded'
      : 'unresolved_in_checked_sources';
    const shortage = issue.signals.some(s => ['out_of_stock', 'coordination_required'].includes(s.kind));
    issue.needsReplacementDecision = shortage && issue.resolution === 'unresolved_in_checked_sources' && fresh && snapshot?.state === 'open' ? true : null;
    if (selected.length) issue.note = 'The SMS service records a choice. The original remaining unavailable on the website is not evidence this choice failed. Final submission and fulfillment remain unverified.';
  }
  return { ...report, issues,
    websiteOrder: { orderNumber: order.orderNumber, items: order.items },
    replacementRequest: { readState, fresh, snapshot },
    coverage: { ...report.coverage, replacementRequest: readState },
    note: 'Website order items and SMS choices are independent views. Editing the website order may invalidate SMS choices (user-reported behavior, not yet directly verified). Differences are not automatically failures. Never silently reapply choices. Coverage and fulfillment remain incomplete.',
  };
}

export function replacementEditGuard({ snapshot = null, fresh = false, readState = 'not_provided' } = {}) {
  return {
    replacementStateChecked: fresh, replacementReadState: readState,
    recordedSnapshotId: snapshot?.snapshotId || null,
    recordedChoices: snapshot ? selectedChoices(snapshot) : [],
    risk: 'Editing a website order may invalidate SMS replacement choices. This is user-reported behavior pending direct verification.',
    requiredBeforeStartingEdit: ['Read the replacement state again', 'Preserve the current choices', 'Explain the invalidation risk and obtain explicit approval'],
    requiredAfterSavingEdit: ['Re-read both independent views', 'Compare with the preserved choices', 'Report lost or changed choices; never automatically reapply them'],
    snapshotCoverage: snapshot?.coverage || null,
    canStartEdit: false,
  };
}
