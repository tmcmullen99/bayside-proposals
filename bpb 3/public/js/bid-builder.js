// ═══════════════════════════════════════════════════════════════════════════
// Bid Builder — SPRINT 8B part 2.
//
// The manual alternative to the Bid PDF parser: compose the scope of work
// straight from the company's rate card (service_items) plus free-typed
// lines. Emits the SAME artifacts the PDF path produces — proposal_sections
// rows (section_type 'bid_section') with contractor-convention line-item
// strings ("DEMO: Demolition & excavation | QTY: 850 sqft | …") — so
// publish.js renders both paths identically and the client portal can't
// tell the difference.
//
// One scope source at a time: saving here replaces existing bid sections,
// exactly like committing a Bid PDF does. The UI says so out loud.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

let ctx = null;

export async function initBidBuilder({ proposalId, container, onSave }) {
  ctx = {
    proposalId,
    container,
    onSave: onSave || (() => {}),
    services: [],
    rows: [],
    sectionName: 'Scope of work',
    existingSections: 0,
  };
  injectStylesOnce();
  container.innerHTML = `<div class="bb-wrap"><div class="bb-loading">Loading your rate card…</div></div>`;

  try {
    const [{ data: services, error: sErr }, { count }] = await Promise.all([
      supabase.from('service_items')
        .select('id, name, category, unit, rate')
        .eq('is_active', true)
        .order('sort_order'),
      supabase.from('proposal_sections')
        .select('id', { count: 'exact', head: true })
        .eq('proposal_id', proposalId)
        .eq('section_type', 'bid_section'),
    ]);
    if (sErr) throw sErr;
    ctx.services = services || [];
    ctx.existingSections = count || 0;
  } catch (err) {
    container.innerHTML = `<div class="bb-wrap"><div class="error-box">Could not load your rate card: ${esc(err.message)}</div></div>`;
    return;
  }

  ctx.rows = [newRow()];
  render();
}

function newRow() {
  return { serviceId: '', description: '', qty: '', unit: 'sqft', rate: '' };
}

// ───────────────────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────────────────
function render() {
  const { container, services, rows, existingSections } = ctx;
  const total = grandTotal();

  container.innerHTML = `
    <div class="bb-wrap">
      <div class="section-header">
        <h2>Bid builder</h2>
        <p class="hint">Build the scope straight from <strong>your rate card</strong> — no PDF needed. Pick a service, enter the quantity, and pricing follows your rates. Manage the rate card itself in <a href="/onboarding.html">workspace setup</a>.</p>
      </div>

      ${existingSections > 0 ? `
        <div class="bb-note">This proposal already has ${existingSections} scope section${existingSections === 1 ? '' : 's'} (from a Bid PDF or a previous build). <strong>Saving replaces them</strong> — one source of truth for the scope.</div>` : ''}

      <div class="bb-card">
        <label class="bb-label" for="bbSectionName">Section title (clients see this)</label>
        <input type="text" id="bbSectionName" value="${esc(ctx.sectionName)}" maxlength="80">

        <div class="bb-rows" id="bbRows">
          ${rows.map((r, i) => rowHtml(r, i, services)).join('')}
        </div>

        <button type="button" class="bb-add" id="bbAdd">+ Add line item</button>

        <div class="bb-total">
          <span>Project total</span>
          <b id="bbTotal">${money(total)}</b>
        </div>

        <button type="button" class="bb-save" id="bbSave" ${rows.some(rowValid) ? '' : 'disabled'}>
          Save scope to proposal →
        </button>
        <div class="bb-msg" id="bbMsg"></div>
      </div>
    </div>`;

  attach();
}

function rowHtml(r, i, services) {
  const amount = rowAmount(r);
  const opts = ['<option value="">— pick from rate card —</option>']
    .concat(services.map(s =>
      `<option value="${esc(s.id)}" ${r.serviceId === s.id ? 'selected' : ''}>${esc(s.name)} · $${Number(s.rate)}/${esc(s.unit)}</option>`))
    .concat([`<option value="__custom" ${r.serviceId === '__custom' ? 'selected' : ''}>✏️ Custom line…</option>`])
    .join('');
  return `
    <div class="bb-row" data-i="${i}">
      <div class="bb-row-top">
        <select class="bb-svc" data-i="${i}">${opts}</select>
        <button type="button" class="bb-del" data-i="${i}" title="Remove">✕</button>
      </div>
      ${r.serviceId === '__custom' ? `
        <input type="text" class="bb-desc" data-i="${i}" placeholder="Describe the work (e.g. Outdoor kitchen rough-in)" value="${esc(r.description)}">` : ''}
      <div class="bb-row-nums">
        <label>Qty <input type="number" class="bb-qty" data-i="${i}" min="0" step="0.5" value="${esc(r.qty)}" placeholder="0"></label>
        <label>Unit
          <select class="bb-unit" data-i="${i}" ${r.serviceId && r.serviceId !== '__custom' ? 'disabled' : ''}>
            ${['sqft','lnft','each','hour','load','day','flat'].map(u => `<option value="${u}" ${r.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
        </label>
        <label>$/unit <input type="number" class="bb-rate" data-i="${i}" min="0" step="0.25" value="${esc(r.rate)}" placeholder="0.00"></label>
        <span class="bb-amount">${amount > 0 ? money(amount) : '—'}</span>
      </div>
    </div>`;
}

// ───────────────────────────────────────────────────────────────────────────
// Events
// ───────────────────────────────────────────────────────────────────────────
function attach() {
  const c = ctx.container;

  c.querySelector('#bbSectionName').addEventListener('input', (e) => { ctx.sectionName = e.target.value; });

  c.querySelectorAll('.bb-svc').forEach(sel => sel.addEventListener('change', () => {
    const i = Number(sel.dataset.i);
    const r = ctx.rows[i];
    r.serviceId = sel.value;
    if (sel.value && sel.value !== '__custom') {
      const s = ctx.services.find(x => x.id === sel.value);
      if (s) { r.description = s.name; r.unit = s.unit; r.rate = Number(s.rate); }
    } else if (sel.value === '__custom') {
      r.description = ''; r.rate = r.rate || '';
    }
    render();
  }));

  c.querySelectorAll('.bb-desc').forEach(inp => inp.addEventListener('input', () => {
    ctx.rows[Number(inp.dataset.i)].description = inp.value;
  }));
  c.querySelectorAll('.bb-qty').forEach(inp => inp.addEventListener('input', () => {
    ctx.rows[Number(inp.dataset.i)].qty = inp.value;
    softTotals();
  }));
  c.querySelectorAll('.bb-rate').forEach(inp => inp.addEventListener('input', () => {
    ctx.rows[Number(inp.dataset.i)].rate = inp.value;
    softTotals();
  }));
  c.querySelectorAll('.bb-unit').forEach(sel => sel.addEventListener('change', () => {
    ctx.rows[Number(sel.dataset.i)].unit = sel.value;
  }));
  c.querySelectorAll('.bb-del').forEach(btn => btn.addEventListener('click', () => {
    ctx.rows.splice(Number(btn.dataset.i), 1);
    if (!ctx.rows.length) ctx.rows.push(newRow());
    render();
  }));
  c.querySelector('#bbAdd').addEventListener('click', () => { ctx.rows.push(newRow()); render(); });
  c.querySelector('#bbSave').addEventListener('click', save);
}

// update amounts/total without a full re-render (keeps focus in inputs)
function softTotals() {
  const c = ctx.container;
  c.querySelectorAll('.bb-row').forEach(rowEl => {
    const i = Number(rowEl.dataset.i);
    const amt = rowAmount(ctx.rows[i]);
    rowEl.querySelector('.bb-amount').textContent = amt > 0 ? money(amt) : '—';
  });
  c.querySelector('#bbTotal').textContent = money(grandTotal());
  c.querySelector('#bbSave').disabled = !ctx.rows.some(rowValid);
}

// ───────────────────────────────────────────────────────────────────────────
// Math + persistence
// ───────────────────────────────────────────────────────────────────────────
function rowAmount(r) {
  const q = parseFloat(r.qty), rt = parseFloat(r.rate);
  if (r.unit === 'flat') return isFinite(rt) ? rt : 0;
  return (isFinite(q) && isFinite(rt)) ? q * rt : 0;
}
function rowValid(r) {
  return (r.description || r.serviceId) && rowAmount(r) > 0;
}
function grandTotal() {
  return ctx.rows.reduce((s, r) => s + rowAmount(r), 0);
}

function itemString(r) {
  const svc = ctx.services.find(x => x.id === r.serviceId);
  const type = (svc ? svc.category : 'scope').toUpperCase();
  const name = r.description || (svc ? svc.name : 'Line item');
  const qtyPart = r.unit === 'flat'
    ? 'QTY: flat'
    : `QTY: ${parseFloat(r.qty) || 0} ${r.unit}`;
  return `${type}: ${name} | ${qtyPart} | RATE: $${(parseFloat(r.rate) || 0).toFixed(2)}/${r.unit} | AMOUNT: ${money(rowAmount(r))}`;
}

async function save() {
  const btn = ctx.container.querySelector('#bbSave');
  const msg = ctx.container.querySelector('#bbMsg');
  const valid = ctx.rows.filter(rowValid);
  if (!valid.length) return;

  btn.disabled = true; btn.textContent = 'Saving…';
  const total = grandTotal();

  try {
    // 1. proposal totals (same columns the PDF path writes)
    const { error: pErr } = await supabase.from('proposals')
      .update({ bid_subtotal: total, bid_total_amount: total })
      .eq('id', ctx.proposalId);
    if (pErr) throw pErr;

    // 2. replace bid sections (one source of truth for the scope)
    const { error: dErr } = await supabase.from('proposal_sections')
      .delete()
      .eq('proposal_id', ctx.proposalId)
      .eq('section_type', 'bid_section');
    if (dErr) throw dErr;

    const { error: iErr } = await supabase.from('proposal_sections').insert({
      proposal_id: ctx.proposalId,
      section_type: 'bid_section',
      name: (ctx.sectionName || 'Scope of work').trim() || 'Scope of work',
      display_order: 0,
      total_amount: total,
      line_items: valid.map(itemString),
    });
    if (iErr) throw iErr;

    ctx.existingSections = 1;
    msg.textContent = `✓ Scope saved — ${valid.length} line item${valid.length === 1 ? '' : 's'}, ${money(total)}. Preview it in section 06.`;
    msg.className = 'bb-msg ok';
    ctx.onSave();
  } catch (err) {
    msg.textContent = 'Could not save: ' + err.message;
    msg.className = 'bb-msg err';
  }
  btn.disabled = false; btn.textContent = 'Save scope to proposal →';
  setTimeout(() => { msg.className = 'bb-msg'; }, 6000);
}

// ───────────────────────────────────────────────────────────────────────────
// Utils + styles
// ───────────────────────────────────────────────────────────────────────────
function money(n) {
  return '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let stylesInjected = false;
function injectStylesOnce() {
  if (stylesInjected) return;
  stylesInjected = true;
  const st = document.createElement('style');
  st.textContent = `
    .bb-wrap { max-width: 780px; }
    .bb-loading { color:#6f6a60; font-size:14px; padding:20px 0; }
    .bb-note { background:#fbf2dc; border:1px solid #ecd9a8; color:#7d5c31; border-radius:10px; padding:10px 14px; font-size:13px; margin:0 0 14px; }
    .bb-card { background:#fff; border:1px solid #e5e0d6; border-radius:14px; padding:18px; }
    .bb-label { display:block; font-size:12px; font-weight:600; margin-bottom:5px; color:#23282f; }
    .bb-card > input[type=text] { width:100%; font:600 15px 'Onest',sans-serif; border:1.5px solid #e5e0d6; border-radius:10px; padding:10px 12px; margin-bottom:14px; }
    .bb-row { border:1px solid #efe8d7; border-radius:12px; padding:12px; margin-bottom:10px; background:#faf8f3; }
    .bb-row-top { display:flex; gap:8px; margin-bottom:8px; }
    .bb-svc { flex:1; font:500 13.5px 'Onest',sans-serif; border:1.5px solid #e5e0d6; border-radius:9px; padding:9px 10px; background:#fff; min-width:0; }
    .bb-del { border:1px solid #e5e0d6; background:#fff; color:#6f6a60; border-radius:9px; width:38px; cursor:pointer; font-size:13px; flex-shrink:0; }
    .bb-del:hover { color:#b91c1c; border-color:#e6b8b8; }
    .bb-desc { width:100%; font:500 13.5px 'Onest',sans-serif; border:1.5px solid #e5e0d6; border-radius:9px; padding:9px 10px; margin-bottom:8px; }
    .bb-row-nums { display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; }
    .bb-row-nums label { font-size:10.5px; font-weight:600; color:#6f6a60; display:flex; flex-direction:column; gap:3px; }
    .bb-row-nums input, .bb-row-nums select { font:600 14px 'Onest',sans-serif; border:1.5px solid #e5e0d6; border-radius:9px; padding:8px 9px; width:96px; background:#fff; }
    .bb-amount { margin-left:auto; font-size:16px; font-weight:700; color:#7d5c31; padding-bottom:6px; }
    .bb-add { display:block; width:100%; border:2px dashed #e5e0d6; background:#fff; color:#7d5c31; font:600 13px 'Onest',sans-serif; border-radius:10px; padding:11px; cursor:pointer; margin:4px 0 14px; }
    .bb-add:hover { border-color:#9c7440; background:#faf6ee; }
    .bb-total { display:flex; align-items:baseline; justify-content:space-between; border-top:2px solid #f1e7d3; padding-top:12px; margin-bottom:14px; }
    .bb-total span { font-size:13px; font-weight:600; color:#6f6a60; }
    .bb-total b { font-size:24px; letter-spacing:-.01em; color:#33281c; }
    .bb-save { width:100%; background:#9c7440; color:#fff; border:0; border-radius:10px; padding:13px; font:700 14.5px 'Onest',sans-serif; cursor:pointer; }
    .bb-save:hover { background:#7d5c31; }
    .bb-save:disabled { opacity:.5; cursor:default; }
    .bb-msg { display:none; font-size:13px; font-weight:600; margin-top:10px; }
    .bb-msg.ok { display:block; color:#2f7a43; }
    .bb-msg.err { display:block; color:#b91c1c; }
    @media (max-width:700px) {
      .bb-row-nums input, .bb-row-nums select { width:84px; font-size:16px; }
      .bb-amount { width:100%; text-align:right; margin-left:0; }
    }
  `;
  document.head.appendChild(st);
}
