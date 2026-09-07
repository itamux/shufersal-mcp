# Shufersal MCP — itamux fork

Headless product search, cart management, and online order history. Based on
[matipojo/shufersal-mcp](https://github.com/matipojo/shufersal-mcp), with a standalone browser implementation and verified shopping operations.

## Tools

| Tool | Behavior |
| --- | --- |
| `open_shufersal` | Open the site and check authentication. |
| `login_shufersal` | Log in once or reuse the browser session. |
| `search_shufersal` | Find products with filters, sorting and pages of 1–50 items. |
| `get_shufersal_cart` | Read cart entries, quantities, and displayed total. |
| `add_to_shufersal_cart` | Add a quantity, then verify the resulting quantity. |
| `update_shufersal_cart_item` | Set an absolute quantity, checking the caller's expected current quantity. |
| `remove_from_shufersal_cart` | Remove one product, checking its current quantity and verifying removal. |
| `get_shufersal_order_history` | Read current online order summaries, newest first, with limit/offset pagination. |
| `get_shufersal_order` | Read purchased products, quantities, and prices for an order in that history. |

Cart writes take `product_code` and `selling_method` (`BY_UNIT` or `BY_WEIGHT`)
from search/cart results. Add/update also take `quantity`. Update/remove require
`expected_quantity` from a fresh cart read. Unit quantities must be integers.
Weight quantities follow the site's selling method. A failure may follow a
successful write: always read the cart before retrying. Writes are never retried
automatically. The preflight quantity check is not a server-side transaction;
avoid simultaneous cart editing in another client.

No checkout, payment, order cancellation/editing, invoice sending, or bulk
cart clearing is exposed. The upstream arbitrary-webpage reader, console-log
resource, shopping-list stub, and heuristic cart-success check are removed.
Order output is projected inside Chromium to shopping fields only: payment
information, identity numbers, addresses and contact details are excluded.

## Run

Use Node 22.12+ and installed Chromium:

```sh
npm ci --ignore-scripts
export PUPPETEER_EXECUTABLE_PATH=/path/to/chromium
export SHUFERSAL_EMAIL='you@example.com'
export SHUFERSAL_PASSWORD='your-password'
npm start
```

Supply your account email and password through these environment variables, including
through your preferred secret manager or MCP client's environment configuration.
No proxy, external credential service, or deployment framework is required.
Credentials are never accepted as tool arguments or returned in tool results.

MCP transport is stdio (`node server.js`). Chromium runs headlessly with its
sandbox and TLS verification enabled. Credentials are submitted only to the fixed
Shufersal HTTPS login endpoint; cookies remain in the ephemeral browser session.
There is no persistent profile, cookie export, or remember-me option. A new server
process logs in again. Before shopping operations, an expired session is refreshed
once and the saved account cart is restored. Verification challenges fail without
bypasses. Writes are never replayed automatically.

Only the fixed Shufersal HTTPS origin is allowed. Each cart or coupon POST must
match one armed request. Merge decisions and checkout remain blocked.

## Tests

```sh
npm test
npm run test:browser
```

Browser tests intercept all requests with local fixtures; they do not touch a
real account. Live verification should separately check reads, then add/update/
remove one temporary item and restore the original cart. Never infer successful
cart changes from returned HTML or HTTP 200 alone.

Upstream author: Mati Horowitz. License: MIT (retained from upstream metadata).

## Catalog, sales and personal coupons (0.3)

`search_shufersal` keeps `query` and adds `category_code`, `brand_codes`,
`filters` (code/value pairs from returned facets), `sort`, `page` (zero based),
`page_size` (1–50, default 15) and `food_only`. Supported sort codes are
`relevance`, `pricePerUnit-asc`, `pricePerUnit-desc`, `name-asc`, `name-desc`,
`popularity`, and `topRated`, as advertised by the live catalog. The response
includes paging totals, available facets and sort codes. Unsupported filters
and ignored pagination/sorting fail instead of returning misleading results.

- `get_shufersal_categories`: omit `parent_code` for roots; supply a returned
  code for immediate subcategories. Repeat until an empty leaf list.
- `browse_shufersal_category`: requires `category_code`; supports the same
  filters, sort and paging as search without a text query.
- `get_shufersal_sales`: `category_code` (default `A`, supermarket), `page`
  (default 0). Returns the site's offer pages and multi-buy descriptions.
- `get_shufersal_promotion_products`: supply a returned `promotion_code` to
  list eligible product codes, package details and regular prices. Offer terms
  determine the discount; a multi-buy price is not a single-item price.
- `get_shufersal_personal_coupons`: authenticated, unexpired account coupons;
  `limit` (1–100), `offset`, optional `activated`, and `expiring_only`.
  Includes expiry and activation status, excluding prepaid cards and unique
  redemption codes. Unexpired does not guarantee remaining uses or eligibility;
  the site decides whether the offer applies. Use the separate activation tool to activate a selected coupon.

The catalog and coupon-list tools are read-only GET operations. Sale and
coupon promotion codes can be used to browse eligible products. Availability
and final discounts depend on the account, selected store and cart conditions.
No guessed price-range or discount-percent filter is exposed.


## Activate a personal coupon (0.4)

`activate_shufersal_coupon` takes `promotion_code` from the account coupon list.
It requires exactly one unexpired non-prepaid account coupon, skips already-active
coupons, and verifies `activated: true` with a fresh account read after one POST.
An ambiguous or missing match is rejected. After a failure, read coupon status
before retrying: the activation may already have happened. There are no automatic
retries, redemption, purchases, or bulk activation.

Activation uses the fixed coupon endpoint and the authenticated browser session.
The unique coupon code stays internal; MCP returns the public promotion code and
verified state.

## Product images (0.4.1)

Product rows from search, category browsing, promotion products, cart reads and
order details include `imageUrl`: a public HTTPS Shufersal product image URL,
or `null` when unavailable. Catalog and order data prefer the medium product
image; HTML product rows use the image supplied by the site. Default placeholder
images are omitted. URLs are returned without downloading image files or changing
the browser's network permissions.

## Product availability (0.4.3)

Search and category products include `stockStatus` (the API stock code, or null)
and `availability`: `in_stock`, `out_of_stock`, or `unknown`. Missing or
unrecognized codes remain unknown; they are never treated as in stock.
Promotion products use explicit in-stock and visible out-of-stock HTML markers.
Missing or conflicting markers return `stockStatus: null` and `availability: "unknown"`.
A listing is an availability hint, not a reservation or a guarantee that the
requested quantity can be added. Cart stock/error verification still applies.
