# Orders stuck on 3D Secure (requires_action)

A buyer never finished the 3D Secure step, so the Stripe PaymentIntent is frozen on `requires_action` and the WooCommerce order sits on Pending with stock held. This reconciler sweeps waiting PaymentIntents, completes the ones that paid later, and fails the old ones that never finished so the held stock is released.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/orders-stuck-requires-action-3ds/

## Run it

```bash
export DRY_RUN="true"
export THRESHOLD_HOURS="6"   # give slow buyers time before failing

python orders-stuck-requires-action-3ds/python/resolve_3ds.py
node   orders-stuck-requires-action-3ds/node/resolve-3ds.js
```

## Test

```bash
pytest orders-stuck-requires-action-3ds/python
node --test orders-stuck-requires-action-3ds/node
```
