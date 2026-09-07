import test from 'node:test';
import assert from 'node:assert/strict';
import { cartWrite, verifyCart } from '../shopping.js';
import { allowedRequest, HOME } from '../shufersal.js';
const args = { product_code:'P_123', selling_method:'BY_UNIT', quantity:2, expected_quantity:3 };
const cart = { items:[{ productCode:'P_123', sellingMethod:'BY_UNIT', quantity:3, entryNumber:0 }] };
test('add increments, update sets quantity, removal targets only the current entry', () => {
  assert.equal(cartWrite('add',args,cart).after,5);
  const update = cartWrite('update',args,cart);
  assert.equal(update.after,2); assert.match(update.path,/entryNumber=0/);
  assert.equal(cartWrite('remove',args,cart).after,0);
  assert.throws(()=>cartWrite('update',{...args,expected_quantity:2},cart),/changed/);
  assert.throws(()=>cartWrite('add',{...args,quantity:0.5},cart),/quantity/);
});
test('HTML success or partial quantity is insufficient: read-back must match', () => {
  assert.throws(()=>verifyCart(cart,'P_123','BY_UNIT',5),/not confirmed/);
  assert.equal(verifyCart(cart,'P_123','BY_UNIT',3),cart);
  assert.throws(()=>verifyCart(cart,'P_123','BY_UNIT',0),/not confirmed/);
});
test('a cart write is admitted only with its exact armed body and URL', () => {
  const w=cartWrite('add',args,cart);const pending={url:HOME+'cart/add',body:w.body};
  assert.equal(allowedRequest(pending.url,'POST',false,w.body,pending),true);
  assert.equal(allowedRequest(pending.url,'POST',false,w.body+' ',pending),false);
  for(const suffix of ['checkout','cart/remove','cart/cartFromOrder/123','cart/load?executeTransaction=true'])
    assert.equal(allowedRequest(HOME+suffix,'GET',false),false);
  assert.equal(allowedRequest(HOME+'cart/add','POST',false,w.body),false);
});
