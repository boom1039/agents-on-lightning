export function buildProofLedgerPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agents on Lightning Proof Ledger</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #050607;
      --panel: #101316;
      --panel-2: #151a1f;
      --line: #2f3a43;
      --text: #e7edf2;
      --muted: #92a0aa;
      --good: #89d185;
      --warn: #e8c46c;
      --bad: #ec8b8b;
      --blue: #7eb6ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      letter-spacing: 0;
    }
    main { max-width: 1280px; margin: 0 auto; padding: 16px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: end; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
    h1 { font-size: 20px; margin: 0 0 6px; font-weight: 700; }
    h2 { font-size: 13px; margin: 0; color: var(--text); }
    p { color: var(--muted); margin: 0; line-height: 1.45; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
    .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 6px; min-width: 0; }
    .panel header { border-bottom: 1px solid var(--line); padding: 8px 10px; align-items: center; }
    .panel .body { padding: 10px; }
    .wide { grid-column: span 2; }
    .full { grid-column: 1 / -1; }
    .metric { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
    .metric:last-child { border-bottom: 0; }
    .label { color: var(--muted); white-space: nowrap; }
    .value { color: var(--text); text-align: right; overflow-wrap: anywhere; }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .mono-block {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      color: var(--muted);
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      max-height: 300px;
      overflow: auto;
    }
    .small { font-size: 12px; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; color: var(--muted); }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
      .wide, .full { grid-column: auto; }
      header { display: block; }
      .actions { margin-top: 10px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Agents on Lightning Proof Ledger</h1>
        <p>Signed Proof of Liabilities and Proof of Reserves for agent custody accounting.</p>
      </div>
      <nav class="actions">
        <a href="/llms.txt">llms.txt</a>
        <a href="/.well-known/proof-ledger.json">proof ledger JSON</a>
        <a href="/.well-known/proof-ledger-public-key.json">public key</a>
      </nav>
    </header>

    <section class="grid">
      <article class="panel">
        <header><h2>Chain</h2></header>
        <div class="body" id="chain"></div>
      </article>
      <article class="panel">
        <header><h2>Liabilities</h2></header>
        <div class="body" id="liabilities"></div>
      </article>
      <article class="panel">
        <header><h2>Reserves</h2></header>
        <div class="body" id="reserves"></div>
      </article>
      <article class="panel">
        <header><h2>Issuer</h2></header>
        <div class="body" id="issuer"></div>
      </article>
      <article class="panel wide">
        <header><h2>Latest Liability Checkpoint</h2></header>
        <div class="body" id="liability-proof"></div>
      </article>
      <article class="panel wide">
        <header><h2>Latest Reserve Snapshot</h2></header>
        <div class="body" id="reserve-proof"></div>
      </article>
      <article class="panel full">
        <header><h2>Verification Data</h2></header>
        <div class="body">
          <p class="small">Agents can keep proof ids, hashes, signatures, and the public key outside the platform. The JSON below is the current public checkpoint surface, not a private wallet view.</p>
          <pre class="mono-block" id="raw">Loading...</pre>
        </div>
      </article>
    </section>
  </main>
  <script>
    const fmtSats = (n) => Number(n || 0).toLocaleString() + ' sats';
    const short = (v) => v ? String(v).slice(0, 18) + (String(v).length > 18 ? '...' : '') : 'none';
    const date = (ms) => ms ? new Date(ms).toLocaleString() : 'none';
    const cls = (ok) => ok ? 'good' : 'bad';
    function row(label, value, className = '') {
      return '<div class="metric"><span class="label">' + label + '</span><span class="value ' + className + '">' + value + '</span></div>';
    }
    function rows(entries) {
      return entries.map(([label, value, className]) => row(label, value, className || '')).join('');
    }
    function proofRows(proof) {
      if (!proof) return '<p>No signed proof published yet.</p>';
      return rows([
        ['proof id', proof.proof_id],
        ['type', proof.proof_record_type],
        ['event', proof.money_event_type],
        ['sequence', proof.global_sequence],
        ['hash', short(proof.proof_hash)],
        ['previous hash', short(proof.previous_global_proof_hash)],
        ['created', date(proof.created_at_ms)]
      ]) + '<pre class="mono-block">' + JSON.stringify(proof.public_safe_refs || {}, null, 2) + '</pre>';
    }
    async function load() {
      try {
        const res = await fetch('/.well-known/proof-ledger.json', { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || 'Proof Ledger unavailable');
        const liabilities = data.proof_of_liabilities?.live_derived_liability_totals || {};
        const reserveProof = data.proof_of_reserves?.latest_signed_reserve_snapshot;
        const reserveRefs = reserveProof?.public_safe_refs || {};
        document.getElementById('chain').innerHTML = rows([
          ['status', data.status],
          ['latest sequence', data.latest_global_sequence],
          ['chain valid', String(Boolean(data.global_chain?.valid)), cls(Boolean(data.global_chain?.valid))],
          ['checked rows', data.global_chain?.checked || 0],
          ['latest hash', short(data.latest_global_proof_hash)]
        ]);
        document.getElementById('liabilities').innerHTML = rows([
          ['status', data.proof_of_liabilities?.status || 'unknown'],
          ['total tracked', fmtSats(liabilities.total_tracked_sats)],
          ['wallet ecash', fmtSats(liabilities.wallet_ecash_sats)],
          ['wallet hub', fmtSats(liabilities.wallet_hub_sats)],
          ['capital available', fmtSats(liabilities.capital_available_sats)],
          ['capital locked', fmtSats(liabilities.capital_locked_sats)]
        ]);
        document.getElementById('reserves').innerHTML = rows([
          ['status', data.proof_of_reserves?.status || 'unknown'],
          ['total reserve', fmtSats(reserveRefs.total_reserve_sats)],
          ['sufficient', String(Boolean(reserveRefs.reserve_sufficient)), reserveRefs.reserve_sufficient ? 'good' : 'warn'],
          ['snapshot proof', reserveProof?.proof_id || 'none'],
          ['limitation', data.proof_of_reserves?.limitation || 'none']
        ]);
        document.getElementById('issuer').innerHTML = rows([
          ['key id', short(data.public_key?.signing_key_id)],
          ['domains', (data.public_key?.issuer_domains || []).join(', ')],
          ['canonicalization', data.public_key?.canonicalization_version || 'unknown']
        ]);
        document.getElementById('liability-proof').innerHTML = proofRows(data.proof_of_liabilities?.latest_signed_liability_checkpoint);
        document.getElementById('reserve-proof').innerHTML = proofRows(reserveProof);
        document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        document.getElementById('raw').textContent = err.message;
      }
    }
    load();
  </script>
</body>
</html>`;
}
