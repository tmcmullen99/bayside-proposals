// ═══════════════════════════════════════════════════════════════════════════
// Material picker.
//
// Loads:
//   1. belgard_materials (the 266-row catalog) — grouped by product_name
//   2. belgard_categories (filter chips)
//   3. proposal_materials (what's already selected on THIS proposal) — hydrated
//      with belgard + third_party data via Supabase's FK-join syntax
//   4. third_party_materials (available non-Belgard products — Trex, Tru-Scapes)
//
// Renders:
//   - Search input + category filter chips
//   - Selected tray (one chip per selected material with application-area select)
//   - Product grid (grouped cards — 30-40 unique products instead of 266 rows)
//   - Third-party modal triggered from a button at the bottom
//
// Persists every add/remove/update immediately to Supabase. Calls onSave()
// after each write so the editor coordinator can refresh the save indicator.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

const APPLICATION_AREAS = [
  'Driveway', 'Patio', 'Pool deck', 'Walkway', 'Accent path',
  'Wall', 'Border', 'Coping', 'Fire feature', 'Step', 'Other'
];

const ctx = {
  proposalId: null,
  container: null,
  onSave: null,
  catalog: [],
  products: {},
  categories: [],
  thirdParty: [],
  selected: [],
  filters: { search: '', category: null }
};

// ───────────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────────
export async function initMaterials({ proposalId, container, onSave }) {
  Object.assign(ctx, { proposalId, container, onSave, filters: { search: '', category: null } });
  container.innerHTML = `<div class="mp-loading">Loading materials…</div>`;

  try {
    await Promise.all([loadCatalog(), loadCategories(), loadSelected(), loadThirdParty()]);
    groupProducts();
    render();
  } catch (err) {
    container.innerHTML = `<div class="section-header"><h2>Materials</h2></div>
      <div class="error-box">Could not load catalog: ${escapeHtml(err.message)}</div>`;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Data loading
// ───────────────────────────────────────────────────────────────────────────
async function loadCatalog() {
  const { data, error } = await supabase
    .from('belgard_materials')
    .select('*')
    .order('product_name', { ascending: true });
  if (error) throw new Error(`belgard_materials: ${error.message}`);
  ctx.catalog = data || [];
}

async function loadCategories() {
  const { data, error } = await supabase
    .from('belgard_categories')
    .select('*')
    .order('display_order', { ascending: true });
  if (error) throw new Error(`belgard_categories: ${error.message}`);
  ctx.categories = data || [];
}

async function loadSelected() {
  const { data, error } = await supabase
    .from('proposal_materials')
    .select(`
      *,
      belgard:belgard_material_id (id, product_name, color, size_spec, swatch_url, cut_sheet_url, spec_pdf_url),
      third_party:third_party_material_id (id, manufacturer, product_name, category, image_url, catalog_url)
    `)
    .eq('proposal_id', ctx.proposalId)
    .order('display_order', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`proposal_materials: ${error.message}`);
  ctx.selected = data || [];
}

async function loadThirdParty() {
  const { data, error } = await supabase
    .from('third_party_materials')
    .select('*')
    .order('manufacturer', { ascending: true });
  if (error) throw new Error(`third_party_materials: ${error.message}`);
  ctx.thirdParty = data || [];
}

// ───────────────────────────────────────────────────────────────────────────
// Grouping catalog rows by product_name
// ───────────────────────────────────────────────────────────────────────────
function groupProducts() {
  ctx.products = {};
  for (const m of ctx.catalog) {
    const key = m.product_name || '(unnamed)';
    if (!ctx.products[key]) {
      ctx.products[key] = {
        product_name: key,
        collection: m.collection || '',
        category_id: m.category_id,
        representative_image: getImage(m),
        variants: []
      };
    } else if (!ctx.products[key].representative_image) {
      ctx.products[key].representative_image = getImage(m);
    }
    ctx.products[key].variants.push(m);
  }
}

function getImage(m) {
  // Priority: swatch_url → spec_pdf_url-thumb (unlikely) → null.
  // cut_sheet_url is a PDF so not usable as an <img>.
  return m.swatch_url || null;
}

// ───────────────────────────────────────────────────────────────────────────
// Filtering
// ───────────────────────────────────────────────────────────────────────────
function filteredProducts() {
  return Object.values(ctx.products)
    .filter(p => {
      if (ctx.filters.category && p.category_id !== ctx.filters.category) return false;
      if (ctx.filters.search) {
        const s = ctx.filters.search.toLowerCase();
        const inName = p.product_name.toLowerCase().includes(s);
        const inCollection = (p.collection || '').toLowerCase().includes(s);
        const inVariant = p.variants.some(v =>
          (v.color || '').toLowerCase().includes(s) ||
          (v.size_spec || '').toLowerCase().includes(s)
        );
        if (!inName && !inCollection && !inVariant) return false;
      }
      return true;
    })
    .sort((a, b) => a.product_name.localeCompare(b.product_name));
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────
function render() {
  ctx.container.innerHTML = `
    <div class="section-header">
      <span class="eyebrow">Section 03</span>
      <h2>Materials</h2>
      <p class="section-sub">Pick Belgard products from the catalog and add Trex, Tru-Scapes, or custom third-party materials. Selections save immediately.</p>
    </div>
    ${renderToolbar()}
    ${renderSelectedTray()}
    ${renderProductGrid()}
    ${renderThirdPartyCta()}
    <div id="mpModal" class="mp-modal-backdrop" role="dialog" aria-modal="true" style="display:none;"></div>
  `;
  attachEvents();
}

function renderToolbar() {
  const chips = [
    `<button class="mp-chip${!ctx.filters.category ? ' active' : ''}" data-category="">All</button>`,
    ...ctx.categories.map(c => {
      const active = ctx.filters.category === c.id ? ' active' : '';
      return `<button class="mp-chip${active}" data-category="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`;
    })
  ].join('');

  return `
    <div class="mp-toolbar">
      <input type="text" id="mpSearch" class="mp-search" placeholder="Search catalog by product, color, or size…" value="${escapeHtml(ctx.filters.search)}" autocomplete="off">
      <div class="mp-chips">${chips}</div>
    </div>
  `;
}

function renderSelectedTray() {
  if (ctx.selected.length === 0) {
    return `<div class="mp-selected-empty"><span class="eyebrow">Selected</span><span class="mp-selected-empty-text">None yet — pick from the catalog below.</span></div>`;
  }

  const items = ctx.selected.map(s => {
    const data = s.belgard || s.third_party || {};
    const isBelgard = s.material_source === 'belgard';
    const displayName = isBelgard
      ? `${data.product_name || '(unknown)'} · ${data.color || ''}${data.size_spec ? ' · ' + data.size_spec : ''}`
      : `${data.manufacturer || ''} · ${data.product_name || ''}`;

    const areaOpts = APPLICATION_AREAS.map(a =>
      `<option value="${a}"${s.application_area === a ? ' selected' : ''}>${a}</option>`
    ).join('');

    const img = (data.swatch_url || data.image_url) || null;
    const imgEl = img
      ? `<img src="${escapeHtml(img)}" alt="" class="mp-selected-thumb">`
      : `<div class="mp-selected-thumb mp-placeholder-thumb">${escapeHtml((data.product_name || '??').slice(0, 2).toUpperCase())}</div>`;

    return `
      <div class="mp-selected-item" data-id="${s.id}">
        ${imgEl}
        <div class="mp-selected-body">
          <div class="mp-selected-name">${escapeHtml(displayName)}</div>
          <div class="mp-selected-source">${isBelgard ? 'Belgard' : 'Third-party'}</div>
        </div>
        <select class="mp-selected-area" data-id="${s.id}" aria-label="Application area">
          <option value="">(application area)</option>
          ${areaOpts}
        </select>
        <button class="mp-selected-remove" data-id="${s.id}" aria-label="Remove material">×</button>
      </div>
    `;
  }).join('');

  return `
    <div class="mp-selected-tray">
      <div class="mp-selected-header">
        <span class="eyebrow">Selected · ${ctx.selected.length}</span>
      </div>
      <div class="mp-selected-list">${items}</div>
    </div>
  `;
}

function renderProductGrid() {
  const products = filteredProducts();
  if (products.length === 0) {
    return `<div class="mp-empty">No products match these filters.</div>`;
  }

  const total = Object.keys(ctx.products).length;
  const cards = products.map(p => {
    const selectedCount = p.variants.filter(v =>
      ctx.selected.some(s => s.belgard_material_id === v.id)
    ).length;

    const img = p.representative_image
      ? `<img src="${escapeHtml(p.representative_image)}" alt="${escapeHtml(p.product_name)}" loading="lazy">`
      : `<div class="mp-product-placeholder">${escapeHtml(p.product_name.slice(0, 3).toUpperCase())}</div>`;

    const countBadge = selectedCount > 0
      ? `<span class="mp-product-selected-badge">${selectedCount} added</span>`
      : '';

    return `
      <button class="mp-product-card" data-product="${escapeHtml(p.product_name)}">
        <div class="mp-product-image">${img}${countBadge}</div>
        <div class="mp-product-body">
          <div class="mp-product-name">${escapeHtml(p.product_name)}</div>
          <div class="mp-product-meta">${escapeHtml(p.collection || '—')} · ${p.variants.length} variant${p.variants.length === 1 ? '' : 's'}</div>
        </div>
      </button>
    `;
  }).join('');

  return `
    <div class="mp-grid-meta"><span>${products.length} of ${total} products</span></div>
    <div class="mp-product-grid">${cards}</div>
  `;
}

function renderThirdPartyCta() {
  return `
    <div class="mp-third-party-cta">
      <button id="mpAddThirdParty" class="btn">+ Add third-party material</button>
      <span class="hint">Trex Transcend Lineage, Tru-Scapes, or custom</span>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Event wiring
// ───────────────────────────────────────────────────────────────────────────
function attachEvents() {
  const c = ctx.container;

  const searchEl = c.querySelector('#mpSearch');
  if (searchEl) {
    let debounce;
    searchEl.addEventListener('input', (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        ctx.filters.search = e.target.value;
        rerenderGrid();
      }, 180);
    });
  }

  c.querySelectorAll('.mp-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      ctx.filters.category = chip.dataset.category || null;
      render();
    });
  });

  c.querySelectorAll('.mp-product-card').forEach(card => {
    card.addEventListener('click', () => openProductModal(card.dataset.product));
  });

  c.querySelectorAll('.mp-selected-area').forEach(sel => {
    sel.addEventListener('change', async () => {
      await updateApplicationArea(sel.dataset.id, sel.value || null);
    });
  });

  c.querySelectorAll('.mp-selected-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this material from the proposal?')) return;
      await removeMaterial(btn.dataset.id);
    });
  });

  c.querySelector('#mpAddThirdParty')?.addEventListener('click', openThirdPartyModal);
}

function rerenderGrid() {
  // Replace just the toolbar+grid+meta in place, leave the selected tray alone.
  const c = ctx.container;
  const gridMeta = c.querySelector('.mp-grid-meta');
  const grid = c.querySelector('.mp-product-grid');
  const empty = c.querySelector('.mp-empty');
  const newGridHtml = renderProductGrid();
  if (grid) grid.outerHTML = newGridHtml;
  else if (empty) empty.outerHTML = newGridHtml;
  if (gridMeta) gridMeta.remove();
  // Re-attach product card clicks
  c.querySelectorAll('.mp-product-card').forEach(card => {
    card.addEventListener('click', () => openProductModal(card.dataset.product));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Product modal — shows variants when a product card is clicked
// ───────────────────────────────────────────────────────────────────────────
function openProductModal(productName) {
  const product = ctx.products[productName];
  if (!product) return;
  const modal = ctx.container.querySelector('#mpModal');

  const variants = product.variants.slice().sort((a, b) => {
    const ca = (a.color || '').localeCompare(b.color || '');
    if (ca !== 0) return ca;
    return (a.size_spec || '').localeCompare(b.size_spec || '');
  });

  const variantsHtml = variants.map(v => {
    const alreadySelected = ctx.selected.some(s => s.belgard_material_id === v.id);
    const img = v.swatch_url;
    const imgEl = img
      ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">`
      : `<div class="mp-variant-placeholder">${escapeHtml((v.color || '??').slice(0, 2))}</div>`;

    const cutSheet = v.cut_sheet_url || v.spec_pdf_url;
    const cutSheetLink = cutSheet
      ? `<a href="${escapeHtml(cutSheet)}" target="_blank" rel="noopener" class="mp-variant-spec">Cut-sheet ↗</a>`
      : '';

    return `
      <div class="mp-variant ${alreadySelected ? 'added' : ''}">
        <div class="mp-variant-img">${imgEl}</div>
        <div class="mp-variant-body">
          <div class="mp-variant-color">${escapeHtml(v.color || 'Default')}</div>
          ${v.size_spec ? `<div class="mp-variant-size">${escapeHtml(v.size_spec)}</div>` : ''}
          ${cutSheetLink}
        </div>
        <button class="mp-variant-add ${alreadySelected ? 'is-added' : ''}" data-belgard-id="${escapeHtml(v.id)}" ${alreadySelected ? 'disabled' : ''}>
          ${alreadySelected ? '✓ Added' : '+ Add'}
        </button>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="mp-modal" role="document">
      <button class="mp-modal-close" aria-label="Close">×</button>
      <div class="mp-modal-header">
        <span class="eyebrow">${escapeHtml(product.collection || 'Belgard')}</span>
        <h3>${escapeHtml(product.product_name)}</h3>
        <p class="mp-modal-sub">${variants.length} variant${variants.length === 1 ? '' : 's'} available</p>
      </div>
      <div class="mp-variant-grid">${variantsHtml}</div>
    </div>
  `;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  modal.querySelector('.mp-modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  modal.querySelectorAll('.mp-variant-add').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Adding…';
      const ok = await addBelgardMaterial(btn.dataset.belgardId);
      if (ok) openProductModal(productName); // refresh modal to show "Added" state
      else {
        btn.disabled = false;
        btn.textContent = '+ Add';
      }
    });
  });
}

function closeModal() {
  const modal = ctx.container.querySelector('#mpModal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.innerHTML = '';
  document.body.style.overflow = '';
}

// ───────────────────────────────────────────────────────────────────────────
// Third-party modal
// ───────────────────────────────────────────────────────────────────────────
function openThirdPartyModal() {
  const modal = ctx.container.querySelector('#mpModal');

  const cards = ctx.thirdParty.map(tp => {
    const alreadySelected = ctx.selected.some(s => s.third_party_material_id === tp.id);
    const img = tp.image_url;
    const imgEl = img
      ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">`
      : `<div class="mp-variant-placeholder">${escapeHtml(tp.manufacturer.slice(0, 2))}</div>`;

    return `
      <div class="mp-tp-card ${alreadySelected ? 'added' : ''}">
        <div class="mp-tp-img">${imgEl}</div>
        <div class="mp-tp-body">
          <div class="mp-tp-mfr">${escapeHtml(tp.manufacturer)}</div>
          <div class="mp-tp-name">${escapeHtml(tp.product_name)}</div>
          <div class="mp-tp-category"><span class="mp-pill">${escapeHtml(tp.category)}</span></div>
        </div>
        <button class="mp-tp-add ${alreadySelected ? 'is-added' : ''}" data-tp-id="${escapeHtml(tp.id)}" ${alreadySelected ? 'disabled' : ''}>
          ${alreadySelected ? '✓ Added' : '+ Add'}
        </button>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="mp-modal" role="document">
      <button class="mp-modal-close" aria-label="Close">×</button>
      <div class="mp-modal-header">
        <span class="eyebrow">Third-party</span>
        <h3>Add non-Belgard material</h3>
        <p class="mp-modal-sub">Trex, Tru-Scapes, or enter a custom material below.</p>
      </div>
      <div class="mp-tp-list">${cards}</div>
      <details class="mp-tp-custom">
        <summary>+ Add a new custom material</summary>
        <div class="mp-tp-form">
          <div class="field-row">
            <div class="field"><label>Manufacturer</label><input type="text" id="tpMfr" placeholder="e.g. Lutron"></div>
            <div class="field"><label>Category</label>
              <select id="tpCat">
                <option value="decking">Decking</option>
                <option value="lighting" selected>Lighting</option>
                <option value="fencing">Fencing</option>
                <option value="furniture">Furniture</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div class="field"><label>Product name</label><input type="text" id="tpName" placeholder="e.g. Caséta Smart Dimmer"></div>
          <div class="field"><label>Description (optional)</label><input type="text" id="tpDesc"></div>
          <div class="field"><label>Catalog or cut-sheet URL (optional)</label><input type="text" id="tpCatalog" placeholder="https://…"></div>
          <div class="field"><label>Image URL (optional)</label><input type="text" id="tpImage" placeholder="https://…"></div>
          <button class="btn primary" id="tpSaveCustom">Save and add to proposal</button>
          <div id="tpCustomError" class="error-box" style="display:none;"></div>
        </div>
      </details>
    </div>
  `;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  modal.querySelector('.mp-modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  modal.querySelectorAll('.mp-tp-add').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Adding…';
      const ok = await addThirdPartyMaterial(btn.dataset.tpId);
      if (ok) openThirdPartyModal();
      else {
        btn.disabled = false;
        btn.textContent = '+ Add';
      }
    });
  });

  modal.querySelector('#tpSaveCustom')?.addEventListener('click', async () => {
    const errBox = modal.querySelector('#tpCustomError');
    errBox.style.display = 'none';

    const mfr = modal.querySelector('#tpMfr').value.trim();
    const name = modal.querySelector('#tpName').value.trim();
    const cat = modal.querySelector('#tpCat').value;
    const desc = modal.querySelector('#tpDesc').value.trim() || null;
    const catalog = modal.querySelector('#tpCatalog').value.trim() || null;
    const image = modal.querySelector('#tpImage').value.trim() || null;

    if (!mfr || !name) {
      errBox.textContent = 'Manufacturer and product name are required.';
      errBox.style.display = 'block';
      return;
    }

    const { data: newTp, error } = await supabase
      .from('third_party_materials')
      .insert({ manufacturer: mfr, product_name: name, category: cat, description: desc, catalog_url: catalog, image_url: image })
      .select('*')
      .single();

    if (error) {
      errBox.textContent = 'Could not save: ' + error.message;
      errBox.style.display = 'block';
      return;
    }

    ctx.thirdParty.push(newTp);
    const ok = await addThirdPartyMaterial(newTp.id);
    if (ok) openThirdPartyModal();
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Write actions (Supabase mutations)
// ───────────────────────────────────────────────────────────────────────────
async function addBelgardMaterial(belgardMaterialId) {
  const { data, error } = await supabase
    .from('proposal_materials')
    .insert({
      proposal_id: ctx.proposalId,
      material_source: 'belgard',
      belgard_material_id: belgardMaterialId,
      display_order: ctx.selected.length
    })
    .select(`
      *,
      belgard:belgard_material_id (id, product_name, color, size_spec, swatch_url, cut_sheet_url, spec_pdf_url)
    `)
    .single();

  if (error) { alert('Failed to add material: ' + error.message); return false; }
  ctx.selected.push(data);
  render();
  ctx.onSave?.();
  return true;
}

async function addThirdPartyMaterial(thirdPartyId) {
  const { data, error } = await supabase
    .from('proposal_materials')
    .insert({
      proposal_id: ctx.proposalId,
      material_source: 'third_party',
      third_party_material_id: thirdPartyId,
      display_order: ctx.selected.length
    })
    .select(`
      *,
      third_party:third_party_material_id (id, manufacturer, product_name, category, image_url, catalog_url)
    `)
    .single();

  if (error) { alert('Failed to add third-party material: ' + error.message); return false; }
  ctx.selected.push(data);
  render();
  ctx.onSave?.();
  return true;
}

async function removeMaterial(proposalMaterialId) {
  const { error } = await supabase.from('proposal_materials').delete().eq('id', proposalMaterialId);
  if (error) { alert('Failed to remove material: ' + error.message); return; }
  ctx.selected = ctx.selected.filter(s => s.id !== proposalMaterialId);
  render();
  ctx.onSave?.();
}

async function updateApplicationArea(proposalMaterialId, area) {
  const { error } = await supabase
    .from('proposal_materials')
    .update({ application_area: area })
    .eq('id', proposalMaterialId);
  if (error) { alert('Failed to update area: ' + error.message); return; }
  const item = ctx.selected.find(s => s.id === proposalMaterialId);
  if (item) item.application_area = area;
  ctx.onSave?.();
}

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
