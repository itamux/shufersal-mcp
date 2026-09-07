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

## Active orders, shortages, and edit previews (0.6)

Five additional tools support order care without starting an edit. SMS inspection
uses an optional private replacement link:

| Tool | Behavior |
| --- | --- |
| `get_shufersal_active_orders` | List only the account's active orders, with `limit`/`offset` pagination. |
| `get_shufersal_order_shortages` | Read website shortages and compare a linked editing cart; optionally reconcile a private `replacement_url` as an independent view. |
| `get_shufersal_replacement_request` | Read the private SMS replacement request directly, without rendering the app or submitting choices. |
| `preview_shufersal_order_edit` | Preview absolute quantity changes against a fresh order, checking `expected_quantity`; zero removes a product and expected zero denotes an addition. |
| `find_shufersal_order_replacements` | Search the full catalog for alternatives to a selected order product, using a required query and the catalog's existing filters, sorting, and pagination. |

Order history and details now expose `editability` from the explicit site
`isUpdatable` flag: `allowed`, `not_allowed`, or `unknown`. Active membership comes
from the account's active-order list, not from the draft cart or an inferred
status name. Available consignment delivery-window text is projected without
addresses or tracking links. `editDeadline` remains null; a reported edit flag
is not a guarantee that an edit will still be accepted later.

Shortage reports identify their sources. They include stock and calculation
flags found only in the editing cart, and report additions, missing rows, and
quantity differences separately. Those differences may be intentional edits.
Order stock flags missing from the response remain unknown. Reports always
include source coverage and `complete: false`: SMS data is included only when a link is supplied or a sanitized snapshot is
available in this process, and an empty issue list does not guarantee fulfillment. An ordinary
empty cart is never compared with a placed order. The editing-cart association
is checked against fresh server-rendered state before and after the read; a
changed or unverifiable context causes that cart snapshot to be discarded.

Replacement candidates exclude the original product, explicit out-of-stock
products, and duplicates. Unknown stock is omitted unless `include_unknown` is
true. Results cover one catalog page; pagination totals refer to the original
catalog search. Product price, unit description, and promotion fields remain
available for comparison, but dietary equivalence and availability for this
order's delivery are not inferred. No replacement is applied.

Edit previews return `applied: false`, `canApply: false`, a quantity diff, and
`revisedTotal: null`. Closed orders, an explicit denial of editability, ambiguous
changes, and stale expected quantities are rejected. The preview never applies changes.
Use the session-bound tools below for an editing basket. Order submission and SMS
replacement submission remain unavailable until their native flows are verified.

The read-only order-care operations do not restore the shopping cart. The browser
blocks automatic restore requests except for the server's explicit draft-cart
initialization, which is also skipped when an order is being edited. Existing
draft-cart writes still reject order-edit sessions. Tests use intercepted
synthetic HTML/JSON, including a context change, partial coverage, and a shortage
absent from the order response. No live order or replacement submission is used in tests.


## Session-bound order editing

| Tool | Behavior |
| --- | --- |
| `start_shufersal_order_edit` | Back up and open an active, explicitly editable order. Requires `order_number` and `acknowledge_repricing_and_sms_reset: true` after user approval. Optional `replacement_url` captures fresh SMS choices; failure stops the start. |
| `get_shufersal_order_edit` | Read `edit_id`, current cart, `cartRevision`, stock/calculation flags, original-order comparison, and backup location. Reconcile uncertain outcomes without replaying writes. |
| `set_shufersal_order_edit_item` | Set an absolute quantity using `edit_id`, latest `cart_revision`, `product_code`, current `selling_method`, `expected_quantity`, and `quantity`. Zero removes; expected zero adds. |
| `discard_shufersal_order_edit` | Discard unsaved changes with `edit_id`, latest `cart_revision`, and `confirm_discard: true`. Verify that the placed order remains unchanged. |

**There is no save/submit tool yet.** These tools prepare or discard an editing
basket and always return `submitted: false`. They cannot complete an order
update. Do not tell the customer an order was updated based on an editing-cart
quantity. Do not start an edit unless this limitation fits the user's request.

Before starting, the server initializes the ordinary cart and refuses a nonempty
cart or an existing edit; it never clears or merges those to make room. It saves
the original order, empty draft cart, and sanitized SMS snapshot (or explicit
missing coverage) before the state-changing start request. A second read rejects
changes made during backup. SMS tokens, credentials, addresses, and payment data
are excluded. SMS choices may be invalidated by website editing; that interaction
has not been verified live. Never silently reapply choices.

Set `SHUFERSAL_BACKUP_DIR` to a durable, private directory, especially in a
container. The default is `~/.local/state/shufersal-mcp/backups`. Directory mode
must be `0700`; each UUID-named JSON file is created exclusively with mode `0600`,
flushed and read back with a SHA-256 checksum. Responses return its path and hash.
Backups remain after discard or process exit; owners manage their retention.
Files preserve product codes, quantities, methods and displayed prices for
manual recovery, not automatic resubmission or restoration.

One edit belongs to one server process and its original browser session. Calls
are serialized. Authentication loss, a disconnected browser, another order
association, or a merge prompt stops editing without login or cart restore.
Restarting the MCP loses edit ownership, but retains backup files on durable
storage. A separate login cannot be assumed to see the same editing basket.
Inspect the website and backup after session loss; never start another edit as
an automatic recovery action. The server does not silently discard on shutdown.

Every item change checks the latest cart revision, original order, current site
editability, and session association. It verifies the requested quantity and
unchanged other rows after writing. Read an uncertain edit before another write;
failed requests are never automatically replayed. If an uncertain start/discard
is followed by an empty cart read, `no_edit_observed` retains the recovery lock:
a delayed request could still complete. An uncertain discard also stays locked
when the old editing basket remains visible (`canChange: false`). Inspect the website before deliberately
restarting the MCP; an empty read alone never unlocks a new edit. All operations fail closed if
these checks cannot be completed. Other clients can still change the account
between checks: the service exposes no transaction/version token for an atomic
conditional write, so avoid concurrent editing from another client.

Use selling methods from the editing cart; packaged produce can expose different
methods in order details and the edit UI. `BY_PACKAGE` accepts whole quantities
in the edit tool. Comparison output preserves differences without calling them
shortages: order rows may include delivery/service charges absent from the cart.
Revised prices, promotions and delivery availability need a final check before
any future save implementation.

Native start (`GET /cart/cartFromOrder/<id>`) and discard (`POST /cart/remove`)
were observed in the website's open/exit flow. Their network permissions are
armed for exactly one matching request. Order cancellation (`DELETE` on the
order), checkout and SMS submissions remain blocked. The native open/discard
flow was tested on an eligible order without changing its items; automated tool
coverage uses intercepted browser fixtures, not a live order submission.


## Independent website and SMS replacement views

The SMS page is a separate service at `services.shufersal.co.il`. Its public
client identifies `POST /CorrelateServer/api/Correlate/GetOrder` as the read
operation. The MCP sends only the link token, a null order number, and production
environment `0` to that fixed endpoint. Only the exact HTTPS SMS host/path and
one token are accepted; redirects, alternate environments, and arbitrary URLs
are rejected. The browser's origin allowlist is not expanded.

The app is never loaded for inspection: its public code can automatically invoke
`SetOrder` when no alternative choices are offered. `SetOrder`, `SetOrderBasket`,
`SetOrderBasketSilent`, and inventory/submission operations are not implemented.
Public contract reference: [app.389cdd14.js](https://services.shufersal.co.il/cfcalternative/js/app.389cdd14.js).

`get_shufersal_replacement_request` takes `replacement_url`. It returns original
products, alternatives, raw coordination/status codes, service-reported selection
state, expiry/read-only state, and a sanitized snapshot. Promotion-gift choices
and final-basket data are not projected; this coverage limit is explicit. Selected alternatives
are not proof of final basket confirmation or fulfillment; terminal service
statuses are not treated as submission receipts. Account identifiers other than
the order number, token fields, and raw error messages are excluded. Responses
are bounded to 2 MiB and reads time out after 20 seconds.

Both `get_shufersal_order_shortages` and `preview_shufersal_order_edit` accept an
optional `replacement_url`. A fresh response must identify the requested order
before it is associated with website data. Expired or failed reads cannot establish
a new association. Reports retain the `websiteOrder` and `replacementRequest`
views separately, and distinguish:

- `sms_replacement_reported`: the service reports a selection; an unavailable
  original on the website does not prove that selection failed.
- `sms_choice_previously_recorded`: a cached selection that was not freshly verified.
- `conflicting_information`: ambiguous mappings/selections or previously recorded
  choices that disappeared or changed. No cause is inferred.
- `unresolved_in_checked_sources`: no associated choice in the checked data; partial
  coverage is still explicit and no fulfillment guarantee is made.

The user reports that editing a website order can invalidate SMS replacements.
This interaction has not been directly verified. Edit previews therefore include
`replacementGuard`: the recorded choices, their snapshot identifier, source
freshness, the invalidation risk, and the required checks before and after any
future edit. A future start-edit action must explain that risk and obtain explicit
approval, preserve the choices, then re-read both views after saving. Nothing is
silently reapplied. Native edit actions remain unavailable.

Snapshots retain sanitized service data for up to 50 orders in MCP process memory
only. Later reads report removed or changed choices; failed or expired reads retain
prior choices as stale. Restarting/closing the server clears this history. Links
and tokens are not retained by the MCP reader or included in results; clients
should also avoid logging private tool arguments. This is not durable storage or
a cross-device synchronization service.
