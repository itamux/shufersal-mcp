import test from 'node:test';
import assert from 'node:assert/strict';
import { readOrders } from '../shopping.js';
const old={code:'OLD',created:1,createdString:'fixture date',totalItems:1,totalPrice:{value:10,currencyIso:'ILS'},paymentInfo:{token:'fixture-secret'},deliveryAddress:{phone:'fixture-phone'}};
const recent={...old,code:'NEW',created:2};
test('history is paginated and details project only shopping fields',async t=>{
  const paths=[];
  t.mock.method(globalThis,'fetch',async path=>{paths.push(path);return new Response(JSON.stringify(path.endsWith('/orders')?{activeOrders:[],closedOrders:[old,recent]}:{...recent,entries:[{quantity:1,product:{code:'P_123',name:'Fixture',images:[{format:'thumbnail',url:'https://media.shufersal.co.il/product_images/default/S_P_default.png'},{format:'product',url:'https://res.cloudinary.com/shufersal/image/upload/v1/product.png'}],sellingMethod:{code:'BY_UNIT'}},patientName:'fixture-private'}]}),{headers:{'content-type':'application/json'}});});
  const list=await readOrders({limit:1});assert.equal(list.orders[0].orderNumber,'NEW');assert.equal(list.hasMore,true);
  const detail=await readOrders({orderNumber:'NEW'});assert.equal(detail.items.length,1);assert.equal(detail.items[0].imageUrl,'https://res.cloudinary.com/shufersal/image/upload/v1/product.png');
  assert.doesNotMatch(JSON.stringify({list,detail}),/fixture-secret|fixture-phone|fixture-private|paymentInfo|deliveryAddress/);
  await assert.rejects(readOrders({orderNumber:'FOREIGN'}),/not in account/);
  assert.ok(!paths.some(p=>p.endsWith('FOREIGN')));
});
test('an empty history is valid; an auth page or malformed data is not',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({activeOrders:[],closedOrders:[]}),{headers:{'content-type':'application/json'}}));
  assert.equal((await readOrders()).total,0);
  globalThis.fetch=async()=>new Response('<form>Login</form>',{headers:{'content-type':'text/html'}});
  await assert.rejects(readOrders(),/unavailable/);
});

test('active grouping is authoritative and editability is never inferred from activity', async t => {
  const active = [
    { ...recent, code: 'ACTIVE', isActive: false },
    { ...recent, code: 'EDITABLE', isUpdatable: true },
    { ...recent, code: 'LOCKED', isUpdatable: false },
  ];
  t.mock.method(globalThis, 'fetch', async path => new Response(JSON.stringify(path.endsWith('/orders')
    ? { activeOrders: active, closedOrders: [{ ...old, isActive: true }] }
    : { ...active[0], consignments: [{ timeSlotStartTimeString: 'fixture start', timeSlotEndTimeString: 'fixture end', address: 'PRIVATE' }], entries: [{ quantity: 1, product: { code: 'P_1' } }] }), { headers: { 'content-type': 'application/json' } }));
  const all = await readOrders();
  assert.equal(all.orders.find(o => o.orderNumber === 'OLD').active, false);
  const result = await readOrders({ activeOnly: true });
  assert.equal(result.total, 3);
  assert.ok(result.orders.every(o => o.active));
  assert.deepEqual(result.orders.map(o => o.editability), ['unknown', 'allowed', 'not_allowed']);
  assert.ok(result.orders.every(o => o.editDeadline === null));
  const details = await readOrders({ orderNumber: 'ACTIVE' });
  assert.equal(details.active, true);
  assert.equal(details.items[0].stockSignal, 'unknown');
  assert.equal(details.deliveryWindows[0].start, 'fixture start');
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE/);
});
