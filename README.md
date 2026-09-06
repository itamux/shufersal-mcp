# Shufersal MCP — itamux fork

Headless product search, cart management, and online order history. Based on
[matipojo/shufersal-mcp](https://github.com/matipojo/shufersal-mcp), with the
hardened ACS adapter replacing the original browser/tool implementation.

## Tools

| Tool | Behavior |
| --- | --- |
| `open_shufersal` | Open the site and check authentication. |
| `login_shufersal` | Log in once or reuse the gateway session. |
| `search_shufersal` | Find up to 15 products, prices, and selling-method codes. |
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
export SHUFERSAL_EMAIL=PH_shufersal_email
export SHUFERSAL_PASSWORD=PH_shufersal_password
npm start
```

**This distribution requires Claw Patrol-governed egress and its trusted CA.**
Those two environment values must be the exact placeholders above; real values
are rejected. Build and approve `gateway-plugin/` in Claw Patrol, configure its
`shufersal_login` credential for the exact Shufersal HTTPS host, and inject the
email/password pair into the gateway's primary credential slot from your secret
store. For ACS, Infisical's separate email/password entries are resolved and
combined only in gateway memory by the existing value-fill launcher.

The plugin's outbound network capability is required for login. It keeps session
cookies in memory, loads trusted system PEM roots for macOS Seatbelt, and attaches
cookies only to upstream requests. Never disable TLS verification or Chromium's
sandbox. No persistent browser profile, cookie export, or remember-me option.

MCP transport is stdio (`node server.js`). Only the fixed Shufersal HTTPS origin
is allowed. Each cart POST must match one armed request; the gateway separately
validates its endpoint, fields, quantity, CSRF header and dispatch marker. A new
gateway process needs a new login. Verification challenges fail without bypasses.

## Tests

```sh
npm test
npm run test:browser
cd gateway-plugin && go test -race ./...
```

Browser tests intercept all requests with local fixtures; they do not touch a
real account. Live verification should separately check reads, then add/update/
remove one temporary item and restore the original cart. Never infer successful
cart changes from returned HTML or HTTP 200 alone.

Upstream author: Mati Horowitz. License: MIT (retained from upstream metadata).
