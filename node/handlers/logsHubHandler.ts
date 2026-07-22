import { ServiceContext } from '@vtex/api'
import { Clients } from '../clients'

// GET /_v/mdm-seller/logs — human-friendly index of every diagnostic and
// data endpoint, so nobody has to remember URLs. Links are relative where
// they target this app (work on any workspace/host) and absolute for the
// marketplace app and the MDM backend.
const MARKETPLACE_HOST = 'https://tradeasiab2b.myvtex.com'
const MARKETPLACE_DEV_HOST = 'https://devadnan--tradeasiab2b.myvtex.com'
const MDM_LOGS_PREVIEW = 'https://tradeasia.exchange/logs-preview/900fcec1f25aa85f513960a312dc019a'

export async function logsHub(ctx: ServiceContext<Clients>) {
  ctx.status = 200
  ctx.set('Content-Type', 'text/html; charset=utf-8')
  ctx.set('Cache-Control', 'no-store')

  ctx.body = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>MDM Seller — Logs &amp; Diagnostics</title>
<style>
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #142032; margin: 0; background: #f4f6f9; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #667; font-size: 13px; margin-bottom: 24px; }
  .card { background: #fff; border: 1px solid #e0e4e8; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: #6b7c93; margin: 0 0 10px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 6px 0; border-bottom: 1px solid #f0f2f5; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  li:last-child { border-bottom: none; }
  a { color: #2953b0; text-decoration: none; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
  a:hover { text-decoration: underline; }
  .desc { color: #667; font-size: 12px; }
  form { display: inline-flex; gap: 6px; align-items: center; }
  input { border: 1px solid #ccd3dc; border-radius: 4px; padding: 3px 8px; font-size: 13px; width: 90px; }
  button { border: 1px solid #2953b0; background: #fff; color: #2953b0; border-radius: 4px; padding: 3px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .ext { color: #8a5a00; font-size: 10px; border: 1px solid #e2c46b; background: #fff9e6; border-radius: 3px; padding: 0 5px; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; background: #f0f2f5; padding: 1px 5px; border-radius: 3px; }
  .m { font-size: 10px; font-weight: 700; border-radius: 3px; padding: 1px 5px; color: #fff; }
  .m.get { background: #0b6b5b; } .m.post { background: #1d4ed8; } .m.del { background: #b4232a; }
</style>
</head>
<body>
<div class="wrap">
  <h1>MDM Seller — Logs &amp; Diagnostics</h1>
  <div class="sub">Account: <code>${ctx.vtex.account}</code> · Workspace: <code>${ctx.vtex.workspace}</code> · All pages return JSON unless marked</div>

  <div class="card">
    <h2>Product Capture &amp; MDM Sync</h2>
    <ul>
      <li><a href="capture-events">capture-events</a><span class="desc">broadcaster events received + capture/flush outcome per event</span></li>
      <li><a href="my-products">my-products</a><span class="desc">captured seller products with state (pending_approval / flush_failed + MDM error)</span></li>
      <li><a href="debug-admin-token">debug-admin-token</a><span class="desc">is an admin session present on this request? expiry countdown — the credential /capture uses</span></li>
      <li>
        <form action="capture" method="get">
          <a href="capture?productId=1">capture</a>
          <input name="productId" placeholder="productId" required>
          <button type="submit">Run</button>
        </form>
        <span class="desc">manually capture + flush one product (open from a logged-in admin tab)</span>
      </li>
    </ul>
  </div>

  <div class="card">
    <h2>Seller-Scoped MDM Data</h2>
    <ul>
      <li><a href="products">products</a><span class="desc">this seller's product feed from MDM (backs the Documents picker)</span></li>
      <li><a href="countries">countries</a><span class="desc">country list for the origins multi-select</span></li>
    </ul>
  </div>

  <div class="card">
    <h2>Documents API (used by the Documents admin page)</h2>
    <ul>
      <li><span class="m get">GET</span><a href="documents?vtexProductId=43">documents?vtexProductId=…</a><span class="desc">list this seller's documents for a linked product</span></li>
      <li><span class="m post">POST</span><a>documents?vtexProductId=…</a><span class="desc">multipart PDF upload (file, type, grade, origins) — seller id injected server-side</span></li>
      <li><span class="m post">POST</span><a>documents/delete</a><span class="desc">body {documentId} — delete own document (MDM enforces ownership)</span></li>
    </ul>
  </div>

  <div class="card">
    <h2>Subscriptions</h2>
    <ul>
      <li><a href="subscription/status">subscription/status</a><span class="desc">current Stripe subscription status</span></li>
      <li><a href="mdm-subscription">mdm-subscription</a><span class="desc">subscription as MDM sees it</span></li>
      <li><a href="mdm-plans">mdm-plans</a><span class="desc">available plans</span></li>
      <li><a href="mdm-invoices">mdm-invoices</a><span class="desc">invoice history</span></li>
      <li><span class="m post">POST</span><a>subscription/checkout</a><span class="desc">create a Stripe checkout session</span></li>
      <li><span class="m post">POST</span><a>subscription/embed/init</a><span class="desc">init embedded Stripe checkout</span></li>
      <li><span class="m post">POST</span><a>subscription/mdm-checkout</a><span class="desc">init MDM-side subscription checkout</span></li>
      <li><span class="m post">POST</span><a>subscription/webhook</a><span class="desc">Stripe webhook receiver (Stripe calls this, not you)</span></li>
    </ul>
  </div>

  <div class="card">
    <h2>Config (dev only)</h2>
    <ul>
      <li>
        <form action="dev/settings" method="get">
          <a>dev/settings</a>
          <input name="secret" placeholder="secret" type="password" required>
          <button type="submit">View</button>
        </form>
        <span class="desc">saved dev config — sensitive values masked; POST to update, DELETE to remove keys</span>
      </li>
    </ul>
  </div>

  <div class="card">
    <h2>Marketplace App <span class="ext">other host</span></h2>
    <ul>
      <li><a href="${MARKETPLACE_HOST}/_v/chemtradeasia-mdm/logs">logs</a> <a href="${MARKETPLACE_DEV_HOST}/_v/chemtradeasia-mdm/logs" class="ext">dev ws</a><span class="desc">the marketplace app's own hub like this one</span></li>
      <li><a href="${MARKETPLACE_HOST}/_v/chemtradeasia-mdm/sync-events">sync-events</a> <a href="${MARKETPLACE_DEV_HOST}/_v/chemtradeasia-mdm/sync-events" class="ext">dev ws</a><span class="desc">catalog→MDM sync events on the marketplace (master; “dev ws” = devadnan workspace)</span></li>
      <li>
        <form action="${MARKETPLACE_HOST}/_v/chemtradeasia-mdm/sync-product" method="get">
          <a>sync-product</a>
          <input name="productId" placeholder="productId" required>
          <button type="submit">Run</button>
        </form>
        <span class="desc">manual marketplace sync (&amp;skuId= and &amp;seed=1 also supported)</span>
      </li>
      <li>
        <form action="${MARKETPLACE_HOST}/_v/chemtradeasia-mdm/sync-all" method="get">
          <a>sync-all</a>
          <input name="from" placeholder="from" value="1" required>
          <input name="to" placeholder="to" value="50" required>
          <button type="submit">Sweep</button>
        </form>
        <span class="desc">backfill sweep over a product-id range (max 50 per call)</span>
      </li>
    </ul>
  </div>

  <div class="card">
    <h2>MDM Backend <span class="ext">external</span></h2>
    <ul>
      <li><a href="${MDM_LOGS_PREVIEW}">logs-preview</a><span class="desc">real-time MDM server errors (Laravel log tail) — first stop for any "Server error."</span></li>
    </ul>
  </div>
</div>
</body>
</html>`
}
