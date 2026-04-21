// Editor (stub) — loads proposal by ?id= and shows the metadata.
// Full editor (sections, material picker, PDF parse, HTML export) ships next turn.
import { supabase } from './supabase-client.js';

const content = document.getElementById('content');
const errorBox = document.getElementById('errorBox');

function getId() {
  return new URLSearchParams(window.location.search).get('id');
}

async function loadProposal() {
  const id = getId();
  if (!id) {
    errorBox.innerHTML = '<div class="error-box">No proposal id in URL. <a href="/dashboard">Back to dashboard</a></div>';
    content.innerHTML = '';
    return;
  }

  const { data, error } = await supabase
    .from('proposals')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    errorBox.innerHTML = `<div class="error-box">Could not load proposal: ${escapeHtml(error.message)}</div>`;
    content.innerHTML = '';
    return;
  }

  render(data);
}

function render(p) {
  const title = p.client_name || 'Untitled draft';
  const addr = [p.project_address, p.project_city, p.project_state, p.project_zip].filter(Boolean).join(', ') || '—';

  content.innerHTML = `
    <span class="eyebrow">Proposal · ${p.status}</span>
    <h1 class="mt-2">${escapeHtml(title)}</h1>

    <dl class="kv">
      <dt>ID</dt><dd class="font-mono" style="font-size: 12px;">${p.id}</dd>
      <dt>Type</dt><dd>${p.proposal_type || '—'}</dd>
      <dt>Address</dt><dd>${escapeHtml(addr)}</dd>
      <dt>Client email</dt><dd>${escapeHtml(p.client_email || '—')}</dd>
      <dt>Client phone</dt><dd>${escapeHtml(p.client_phone || '—')}</dd>
      <dt>Estimate #</dt><dd>${escapeHtml(p.bayside_estimate_number || '—')}</dd>
      <dt>Total amount</dt><dd class="tnum">${p.bid_total_amount ? '$' + Number(p.bid_total_amount).toLocaleString() : '—'}</dd>
      <dt>Created</dt><dd>${formatDate(p.created_at)}</dd>
      <dt>Updated</dt><dd>${formatDate(p.updated_at)}</dd>
    </dl>

    <hr class="rule">

    <div style="padding: 32px; background: var(--surface); border: 0.5px solid var(--rule); border-radius: 4px;">
      <span class="eyebrow">Next turn</span>
      <h3 class="mt-2 mb-4">Full editor shipping in the next message.</h3>
      <p style="font-size: 13px; color: var(--text-muted); line-height: 1.6; margin: 0;">
        The editor will have six sections: project info, bid PDF upload + parse, material picker (querying the Belgard catalog),
        site plan upload, photos, and preview + HTML export. For now, this page exists to prove the
        end-to-end Supabase write worked — this proposal was created by the dashboard, stored in the
        <code>proposals</code> table, and loaded back here by id.
      </p>
      <div class="flex gap-3 mt-6">
        <a href="/dashboard" class="btn">← Back to dashboard</a>
        <button id="deleteBtn" class="btn ghost" style="color: var(--accent-red);">Delete this draft</button>
      </div>
    </div>
  `;

  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete this draft proposal? This cannot be undone.')) return;
    const { error } = await supabase.from('proposals').delete().eq('id', p.id);
    if (error) {
      errorBox.innerHTML = `<div class="error-box">Delete failed: ${escapeHtml(error.message)}</div>`;
      return;
    }
    window.location.href = '/dashboard';
  });
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

loadProposal();
