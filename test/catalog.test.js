import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogQuery } from '../catalog.js';
test('catalog grammar preserves server-side filters and paging', () => {
  assert.deepEqual(catalogQuery({query:'milk',category_code:'A01',brand_codes:['628'],filters:[{code:'preferences',value:'BESTSELLER'}],page:2,page_size:5,sort:'pricePerUnit-asc',food_only:true}), {
    q:'milk:pricePerUnit-asc:allCategories:A01:brand:628:preferences:BESTSELLER',page:2,limit:5,food:true,
    refinements:[{code:'brand',value:'628'},{code:'preferences',value:'BESTSELLER'}],metadataPath:'/online/he/c/A01',
  });
});
test('query grammar injection and unverified sort codes are rejected', () => {
  for(const args of [{query:'milk:brand:628'},{category_code:'../login'},{sort:'price-asc'},{page:-1},{page_size:51},{filters:[{code:'brand',value:'628:other:value'}]}]) assert.throws(()=>catalogQuery(args));
});

test('Hebrew facet values remain usable', () => { assert.ok(catalogQuery({filters:[{code:'feature-alavi',value:'חלבי'}]}).q.endsWith(':feature-alavi:חלבי')); });
