/* ═══════════════════════════════════════════════════════════════════════════
   account-chat.js — Sprint 10d

   Homeowner chat module loaded by /account/index.html. Mounts an inline
   chat panel that lets the homeowner read and send messages with their
   assigned Bayside designer.

   Per-client threading (Sprint 10a model): one thread per client, all
   their proposals share it. Reads/writes client_messages directly via
   Supabase RLS — homeowner can only see their own client's messages.

   Staff senders are shown as "Bayside Pavers" — homeowner doesn't need
   to know which specific designer or master is replying. This also
   sidesteps any question about whether homeowner sessions can read
   the profiles table.

   Realtime: subscribes to client_messages INSERTs filtered by client_id
   so designer replies appear instantly while homeowner is on the page.

   File uploads (PDF + images) are deferred to Sprint 10e.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL  = 'https://gfgbypcnxkschnfsitfb.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmZ2J5cGNueGtzY2huZnNpdGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MTkzMTUsImV4cCI6MjA5MjI5NTMxNX0.EAwmiNR5OWcaI8Sr36MVn7FuMhYoZvfngse7y0ZOgvA';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

let _client = null;
let _userId = null;
let _messages = [];
let _channel = null;

// ─── Bootstrap ─────────────────────────────────────────────────────────────
(async function init() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
    return;
  }

  const mount = document.getElementById('ho-chat-section');
  if (!mount) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    // index.html's own script will redirect to signin.html — silent no-op here
    return;
  }
  _userId = session.user.id;

  const { data: client, error } = await supabase
    .from('clients')
    .select('id, name, email')
    .eq('user_id', _userId)
    .maybeSingle();

  if (error || !client) {
    // Not a homeowner account, or RLS blocked. index.html shows its own error.
    return;
  }
  _client = client;

  injectStyles();
  renderShell(mount);
  await loadMessages();
  subscribeRealtime();
})();

// ─── Load messages ─────────────────────────────────────────────────────────
async function loadMessages() {
  const { data, error } = await supabase
    .from('client_messages')
    .select('id, sender_user_id, sender_role, body, created_at')
    .eq('client_id', _client.id)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[account-chat] load failed:', error);
    showInlineError('Could not load messages: ' + error.message);
    return;
  }
  _messages = data || [];
  renderMessages();
}

// ─── Render ────────────────────────────────────────────────────────────────
function renderShell(mount) {
  mount.innerHTML = `
    <div class="ho-section-head">
      <h2>Messages</h2>
      <span class="ho-section-meta" id="hochat-status"></span>
    </div>
    <p class="ho-section-sub">
      Direct line to your designer at Bayside Pavers. Questions, requests,
      or photos — send them here. We aim to respond within one business day.
    </p>
    <div class="hochat-card">
      <div class="hochat-messages" id="hochat-messages">
        <div class="hochat-loading">Loading messages…</div>
      </div>
      <div class="hochat-composer">
        <textarea id="hochat-input" rows="2"
          placeholder="Send a message — Enter to send, Shift+Enter for new line"></textarea>
        <button type="button" id="hochat-send">Send</button>
      </div>
    </div>
  `;

  document.getElementById('hochat-send').addEventListener('click', handleSend);
  const input = document.getElementById('hochat-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
}

function renderMessages() {
  const messagesEl = document.getElementById('hochat-messages');
  const statusEl = document.getElementById('hochat-status');
  if (!messagesEl) return;

  if (_messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="hochat-empty">
        <div class="hochat-empty-icon">💬</div>
        <div class="hochat-empty-title">No messages yet</div>
        <div class="hochat-empty-sub">Send the first message to start a conversation with your designer.</div>
      </div>
    `;
    if (statusEl) statusEl.textContent = '';
    return;
  }

  messagesEl.innerHTML = _messages.map(renderOne).join('');
  scrollToBottom();

  if (statusEl) {
    const last = _messages[_messages.length - 1];
    statusEl.textContent = `Last activity ${formatRelative(last.created_at)}`;
  }
}

function renderOne(message) {
  const isOutbound = message.sender_user_id === _userId;
  const senderName = isOutbound ? 'You' : 'Bayside Pavers';
  const time = formatTime(message.created_at);
  const bodyHtml = escapeHtml(message.body || '').replace(/\n/g, '<br>');
  return `
    <div class="hochat-msg ${isOutbound ? 'hochat-msg-out' : 'hochat-msg-in'}" data-message-id="${escapeAttr(message.id)}">
      <div class="hochat-msg-meta">
        <span class="hochat-msg-sender">${escapeHtml(senderName)}</span>
        <span class="hochat-msg-time">${escapeHtml(time)}</span>
      </div>
      <div class="hochat-msg-body">${bodyHtml}</div>
    </div>
  `;
}

// ─── Send + realtime ───────────────────────────────────────────────────────
async function handleSend() {
  const input = document.getElementById('hochat-input');
  const sendBtn = document.getElementById('hochat-send');
  const body = input.value.trim();
  if (!body) return;

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  const { error } = await supabase
    .from('client_messages')
    .insert({
      client_id: _client.id,
      sender_user_id: _userId,
      sender_role: 'homeowner',
      body,
    });

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';

  if (error) {
    console.error('[account-chat] insert failed:', error);
    showInlineError('Could not send: ' + error.message);
    return;
  }

  input.value = '';
  input.focus();
  // Realtime delivers the message back; renderer adds it to the thread.
}

function subscribeRealtime() {
  if (_channel) supabase.removeChannel(_channel);
  _channel = supabase
    .channel(`account_chat_${_client.id}_${Date.now()}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'client_messages',
      filter: `client_id=eq.${_client.id}`,
    }, (payload) => {
      const message = payload.new;
      if (_messages.some(m => m.id === message.id)) return;
      _messages.push(message);
      appendMessage(message);
    })
    .subscribe();
}

function appendMessage(message) {
  const messagesEl = document.getElementById('hochat-messages');
  if (!messagesEl) return;
  if (messagesEl.querySelector(`[data-message-id="${message.id}"]`)) return;
  const empty = messagesEl.querySelector('.hochat-empty');
  if (empty) empty.remove();
  const wasNearBottom = isScrolledNearBottom();
  messagesEl.insertAdjacentHTML('beforeend', renderOne(message));
  if (wasNearBottom) scrollToBottom();

  const statusEl = document.getElementById('hochat-status');
  if (statusEl) statusEl.textContent = `Last activity ${formatRelative(message.created_at)}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function isScrolledNearBottom() {
  const m = document.getElementById('hochat-messages');
  if (!m) return true;
  return (m.scrollHeight - m.scrollTop - m.clientHeight) < 80;
}
function scrollToBottom() {
  const m = document.getElementById('hochat-messages');
  if (m) m.scrollTop = m.scrollHeight;
}

function showInlineError(msg) {
  const messagesEl = document.getElementById('hochat-messages');
  if (!messagesEl) return;
  const errEl = document.createElement('div');
  errEl.className = 'hochat-error';
  errEl.textContent = msg;
  messagesEl.appendChild(errEl);
  scrollToBottom();
  setTimeout(() => errEl.remove(), 6000);
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  if (d > sevenDaysAgo) {
    return d.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function injectStyles() {
  if (document.getElementById('hochat-styles')) return;
  const style = document.createElement('style');
  style.id = 'hochat-styles';
  style.textContent = `
    /* Inherits CSS variables from :root in /account/index.html (--bp-*) */
    .hochat-card {
      background: #fff;
      border: 1px solid var(--bp-border);
      border-radius: 12px;
      overflow: hidden;
      display: flex; flex-direction: column;
    }
    .hochat-messages {
      max-height: 460px;
      min-height: 220px;
      overflow-y: auto;
      padding: 22px 24px;
      background: var(--bp-bg);
      display: flex; flex-direction: column; gap: 12px;
    }
    .hochat-loading {
      color: var(--bp-muted); font-size: 13px;
      text-align: center; padding: 40px 0;
    }
    .hochat-empty {
      text-align: center; padding: 40px 20px;
      color: var(--bp-muted);
    }
    .hochat-empty-icon { font-size: 32px; margin-bottom: 10px; opacity: 0.5; }
    .hochat-empty-title {
      font-size: 14px; font-weight: 600;
      color: var(--bp-text); margin-bottom: 4px;
    }
    .hochat-empty-sub {
      font-size: 13px; line-height: 1.5;
      max-width: 340px; margin: 0 auto;
    }
    .hochat-error {
      background: #fef2f2; color: var(--bp-err);
      border: 1px solid #fecaca;
      border-radius: 8px; padding: 10px 14px;
      font-size: 13px; line-height: 1.5;
    }
    .hochat-msg {
      display: flex; flex-direction: column;
      gap: 4px; max-width: 85%;
    }
    .hochat-msg-in { align-self: flex-start; }
    .hochat-msg-out { align-self: flex-end; align-items: flex-end; }
    .hochat-msg-meta {
      font-size: 11px; color: var(--bp-muted);
      display: flex; gap: 8px; align-items: center;
    }
    .hochat-msg-sender { font-weight: 600; color: var(--bp-charcoal); }
    .hochat-msg-time { color: #aaa; }
    .hochat-msg-body {
      padding: 10px 14px; border-radius: 12px;
      font-size: 14px; line-height: 1.5;
      white-space: pre-wrap; word-wrap: break-word;
    }
    .hochat-msg-in .hochat-msg-body {
      background: #fff; color: var(--bp-text);
      border: 1px solid var(--bp-border);
      border-bottom-left-radius: 4px;
    }
    .hochat-msg-out .hochat-msg-body {
      background: var(--bp-green); color: #fff;
      border-bottom-right-radius: 4px;
    }
    .hochat-composer {
      background: #fff;
      border-top: 1px solid var(--bp-border);
      padding: 14px 18px 16px;
      display: flex; gap: 10px; align-items: flex-end;
    }
    .hochat-composer textarea {
      flex: 1; font-family: inherit; font-size: 14px;
      padding: 10px 12px;
      border: 1px solid var(--bp-border);
      border-radius: 8px;
      background: #fff; color: var(--bp-text);
      resize: none; min-height: 44px; max-height: 120px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .hochat-composer textarea:focus {
      outline: none; border-color: var(--bp-green);
      box-shadow: 0 0 0 3px rgba(93, 126, 105, 0.16);
    }
    .hochat-composer button {
      background: var(--bp-green); color: #fff;
      border: 0; padding: 10px 18px;
      border-radius: 8px;
      font: inherit; font-size: 14px; font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .hochat-composer button:hover:not(:disabled) {
      background: var(--bp-green-dk);
    }
    .hochat-composer button:disabled {
      opacity: 0.5; cursor: not-allowed;
    }
  `;
  document.head.appendChild(style);
}
