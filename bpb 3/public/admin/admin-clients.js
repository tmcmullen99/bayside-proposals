<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clients · Bayside Proposal Builder</title>
  <link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --green: #5d7e69;
      --green-dark: #4a6654;
      --green-soft: #e8eee9;
      --charcoal: #353535;
      --tan: #dad7c5;
      --cream: #faf8f3;
      --navy: #1a1f2e;
      --border: #e5e5e5;
      --muted: #666;
      --danger: #b04040;
      --warn-soft: #fff4d4;
      --warn-text: #7a5a10;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Onest', -apple-system, BlinkMacSystemFont, sans-serif;
      color: var(--charcoal);
      background: #fafafa;
      line-height: 1.6;
      font-size: 15px;
      min-height: 100vh;
    }
    a { color: var(--green-dark); }

    .admin-header {
      background: #fff;
      border-bottom: 1px solid var(--border);
      padding: 18px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .admin-header h1 {
      font-size: 18px;
      font-weight: 600;
      color: var(--navy);
    }
    .admin-header nav { display: flex; align-items: center; gap: 16px; }
    .admin-header nav a {
      font-size: 13px;
      text-decoration: none;
      color: var(--muted);
    }
    .admin-header nav a:hover { color: var(--green-dark); }
    .admin-header nav a.active { color: var(--green-dark); font-weight: 600; }
    .admin-header .signout {
      font-size: 12px;
      color: var(--muted);
      cursor: pointer;
      background: none;
      border: none;
      font-family: inherit;
      padding: 6px 10px;
      border-radius: 5px;
    }
    .admin-header .signout:hover {
      background: #f0f0f0;
      color: var(--navy);
    }

    .shell {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px;
    }

    .intro { margin-bottom: 28px; }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--green);
      font-weight: 600;
      margin-bottom: 8px;
    }
    .intro h2 {
      font-size: 28px;
      font-weight: 600;
      color: var(--navy);
      margin-bottom: 10px;
      letter-spacing: -0.01em;
    }
    .intro p {
      color: var(--muted);
      max-width: 720px;
      font-size: 15px;
    }

    .status {
      padding: 14px 18px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 20px;
      display: none;
      line-height: 1.5;
    }
    .status.visible { display: block; }
    .status.success { background: var(--green-soft); color: var(--green-dark); }
    .status.error { background: #fbe6e6; color: var(--danger); }
    .status.info { background: #eef3f8; color: #2b4a73; }

    /* Toolbar */
    .toolbar {
      display: flex;
      gap: 12px;
      align-items: center;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }
    .search-input {
      flex: 1;
      min-width: 240px;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 7px;
      font-family: inherit;
      font-size: 14px;
      background: #fff;
    }
    .search-input:focus { outline: none; border-color: var(--green); }
    .counter {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--muted);
    }

    .btn {
      padding: 10px 18px;
      background: var(--green);
      color: #fff;
      border: none;
      border-radius: 7px;
      font-family: inherit;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.15s ease;
      text-decoration: none;
      display: inline-block;
      white-space: nowrap;
    }
    .btn:hover { background: var(--green-dark); }
    .btn:disabled { background: #aaa; cursor: not-allowed; }
    .btn-secondary {
      background: #fff;
      color: var(--charcoal);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { background: var(--cream); border-color: var(--green); }
    .btn-small { padding: 7px 12px; font-size: 12px; }
    .btn-danger {
      background: #fff;
      color: var(--danger);
      border: 1px solid #f0c0c0;
    }
    .btn-danger:hover { background: #fbe6e6; }

    /* Add client form */
    .add-form {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 22px 24px;
      margin-bottom: 18px;
      display: none;
    }
    .add-form.visible { display: block; }
    .add-form h3 {
      font-size: 15px;
      color: var(--navy);
      margin-bottom: 14px;
      font-weight: 600;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-bottom: 14px;
    }
    .form-row { display: flex; flex-direction: column; gap: 4px; }
    .form-row.full { grid-column: 1 / -1; }
    .form-row label {
      font-size: 12px;
      font-weight: 500;
      color: var(--charcoal);
    }
    .form-row input, .form-row textarea, .form-row select {
      padding: 9px 11px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      background: #fff;
    }
    .form-row input:focus, .form-row textarea:focus, .form-row select:focus {
      outline: none; border-color: var(--green);
    }
    .form-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    /* Client list */
    .clients-list {
      display: grid;
      gap: 10px;
    }
    .client-card {
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }
    .client-row {
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .client-row:hover { background: var(--cream); }
    .client-info { flex: 1; min-width: 220px; }
    .client-name {
      font-size: 15px;
      font-weight: 600;
      color: var(--navy);
      margin-bottom: 2px;
    }
    .client-meta {
      font-size: 12px;
      color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .client-badges {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 11px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .badge.linked { background: var(--green-soft); color: var(--green-dark); }
    .badge.unlinked { background: #f0f0f0; color: var(--muted); }
    .badge.proposals { background: #eef3f8; color: #2b4a73; }

    .client-expand {
      display: none;
      padding: 18px 24px;
      border-top: 1px solid var(--border);
      background: #fcfcfc;
    }
    .client-card.expanded .client-expand { display: block; }
    .client-card.expanded .client-chevron { transform: rotate(90deg); }
    .client-chevron {
      color: var(--muted);
      font-size: 16px;
      transition: transform 0.15s ease;
      width: 18px;
      text-align: center;
    }

    .expand-section { margin-bottom: 18px; }
    .expand-section:last-child { margin-bottom: 0; }
    .expand-section h4 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      margin-bottom: 10px;
      font-weight: 600;
    }

    .proposal-row {
      padding: 10px 12px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 7px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      flex-wrap: wrap;
    }
    .proposal-row-info { flex: 1; min-width: 180px; }
    .proposal-row-address {
      font-weight: 600;
      color: var(--navy);
      margin-bottom: 2px;
    }
    .proposal-row-meta {
      font-size: 11px;
      color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
    }

    .assign-row {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px;
      background: var(--cream);
      border-radius: 7px;
    }
    .assign-row select {
      flex: 1;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 5px;
      font-family: inherit;
      font-size: 13px;
      background: #fff;
    }

    .actions-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    /* Loading */
    .loading {
      text-align: center;
      padding: 60px 20px;
      color: var(--muted);
    }
    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border);
      border-top-color: var(--green);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .empty {
      background: #fff;
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 40px 20px;
      text-align: center;
      color: var(--muted);
    }
    .empty-icon { font-size: 32px; margin-bottom: 10px; line-height: 1; }
    .empty h3 { color: var(--navy); font-size: 16px; margin-bottom: 6px; font-weight: 600; }
    .empty p { font-size: 13px; }
  </style>
</head>
<body>

<header class="admin-header">
  <h1>Bayside Proposal Builder · Admin</h1>
  <nav>
    <a href="/admin/index.html">Dashboard</a>
    <a href="/admin/clients.html" class="active">Clients</a>
    <a href="/admin/belgard-sync.html">Catalog sync</a>
    <a href="/admin/material-swatches-bulk.html">Swatches</a>
    <a href="/">← Back to editor</a>
    <button class="signout" id="signOutBtn" title="Sign out">Sign out</button>
  </nav>
</header>

<main class="shell">
  <div class="intro">
    <div class="eyebrow">Admin · Client Platform</div>
    <h2>Clients</h2>
    <p>
      Manage homeowner client accounts. Each client can have one or more proposals
      assigned to them. Click <strong>Send login link</strong> to email a magic-link
      invitation — once they log in, they'll see their assigned proposals in the
      client portal.
    </p>
  </div>

  <div id="status" class="status"></div>

  <div class="toolbar">
    <input type="search" id="searchInput" class="search-input" placeholder="Search by name, email, address…">
    <span class="counter" id="counter">—</span>
    <button class="btn" id="addClientBtn">+ Add client</button>
  </div>

  <div id="addForm" class="add-form">
    <h3>Add a new client</h3>
    <div class="form-grid">
      <div class="form-row">
        <label for="newName">Full name *</label>
        <input type="text" id="newName" placeholder="Jane Homeowner">
      </div>
      <div class="form-row">
        <label for="newEmail">Email *</label>
        <input type="email" id="newEmail" placeholder="jane@example.com">
      </div>
      <div class="form-row">
        <label for="newPhone">Phone</label>
        <input type="tel" id="newPhone" placeholder="(408) 555-1212">
      </div>
      <div class="form-row">
        <label for="newAddress">Project address</label>
        <input type="text" id="newAddress" placeholder="762 El Sombroso, Los Gatos CA">
      </div>
      <div class="form-row full">
        <label for="newNotes">Notes (internal)</label>
        <textarea id="newNotes" rows="2" placeholder="Anything worth remembering about this client…"></textarea>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelAddBtn">Cancel</button>
      <button class="btn" id="saveClientBtn">Save client</button>
    </div>
  </div>

  <div id="loadingState" class="loading">
    <div class="loading-spinner"></div>
    <div>Loading clients…</div>
  </div>

  <div id="clientsList" class="clients-list" style="display:none;"></div>

  <div id="emptyState" class="empty" style="display:none;">
    <div class="empty-icon">👤</div>
    <h3>No clients yet</h3>
    <p>Click "+ Add client" above to create your first client account.</p>
  </div>
</main>

<script type="module" src="/admin/admin-clients.js"></script>

</body>
</html>
