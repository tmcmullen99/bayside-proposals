// ═══════════════════════════════════════════════════════════════════════════
// POST /api/submit-redesign — Phase 6 Sprint 2 (client redesign autonomy)
//
// Accepts a client's design change submission. Two modalities supported in
// the same endpoint:
//   1. Digital markup: SVG string drawn over the site map
//   2. Photo of paper markup: file upload (jpg/png, ≤10MB)
// Either or both can be present. A bare text note alone also works.
//
// Body: multipart/form-data
//   slug                 string (required) — proposal slug
//   markup_svg           string (optional) — serialized SVG of digital strokes
//   photo                File   (optional) — image of paper markup
//   homeowner_note       string (optional) — text note, ≤4000 chars
//   site_map_url         string (required) — snapshot of backdrop URL at submit time
//   site_map_width       number (optional) — backdrop natural width in px
//   site_map_height      number (optional) — backdrop natural height in px
//
// Auth: homeowner JWT in Authorization: Bearer header.
//
// Behavior:
//   - Verifies caller owns this proposal via client_proposals
//   - Auto-supersedes any prior submitted/reviewed redesigns for the same
//     client+proposal so the queue stays clean (designer only sees the latest)
//   - Uploads photo to client-redesign-uploads bucket via service role
//   - Inserts proposal_redesign_requests row
//   - Emails designer with link to admin queue
//
// Returns: { ok:true, request_id, email_sent, email_error }
// ═══════════════════════════════════════════════════════════════════════════

const PUBLIC_BASE_URL = 'https://portal-baysidepavers.com';

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const SUPABASE_URL   = env.SUPABASE_URL;
    const SERVICE_ROLE   = env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND_API_KEY = env.RESEND_API_KEY;
    const RESEND_FROM    = env.RESEND_FROM || 'Bayside Pavers <tim@mcmullen.properties>';
    const DESIGNER_EMAIL = env.DESIGNER_NOTIFICATION_EMAIL || 'tim@mcmullen.properties';
    if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: 'Server not configured' });

    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return json(401, { error: 'Missing auth token' });

    // Resolve caller
    const userResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': SERVICE_ROLE },
    });
    if (!userResp.ok) return json(401, { error: 'Invalid auth token' });
    const callerUser = await userResp.json();
    if (!callerUser || !callerUser.id) return json(401, { error: 'Invalid auth token' });

    // Parse multipart body
    const form = await request.formData().catch(() => null);
    if (!form) return json(400, { error: 'Expected multipart/form-data body' });

    const slug = String(form.get('slug') || '').trim();
    const markup_svg = form.get('markup_svg') ? String(form.get('markup_svg')) : null;
    const homeowner_note = form.get('homeowner_note') ? String(form.get('homeowner_note')).slice(0, 4000) : null;
    const site_map_url = form.get('site_map_url') ? String(form.get('site_map_url')) : null;
    const site_map_width = form.get('site_map_width') ? parseInt(form.get('site_map_width'), 10) : null;
    const site_map_height = form.get('site_map_height') ? parseInt(form.get('site_map_height'), 10) : null;
    const photo = form.get('photo'); // File or null

    if (!slug) return json(400, { error: 'slug is required' });

    // At least one of markup_svg, photo, homeowner_note must be present
    const hasContent = (markup_svg && markup_svg.trim().length > 0) || (photo && photo.size > 0) || (homeowner_note && homeowner_note.trim().length > 0);
    if (!hasContent) return json(400, { error: 'Submission needs at least a markup, photo, or note' });

    // Bound markup size to 200KB
    if (markup_svg && markup_svg.length > 200_000) {
      return json(400, { error: 'Markup too large (>200KB). Try a simpler drawing.' });
    }

    // Validate photo if present
    if (photo && photo.size > 0) {
      if (photo.size > 10 * 1024 * 1024) {
        return json(400, { error: 'Photo too large (>10MB). Try a smaller one.' });
      }
      const acceptable = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      if (!acceptable.includes(photo.type)) {
        return json(400, { error: 'Photo must be JPEG, PNG, or WebP. Convert HEIC first.' });
      }
    }

    const sb = (path, init) =>
      fetch(SUPABASE_URL + '/rest/v1/' + path, {
        ...init,
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': 'Bearer ' + SERVICE_ROLE,
          ...((init && init.headers) || {}),
        },
      });

    // Resolve slug → proposal_id, published_proposal_id, address
    const ppResp = await sb(
      'published_proposals?slug=eq.' + encodeURIComponent(slug) +
      '&select=id,proposal_id,project_address&limit=1'
    );
    if (!ppResp.ok) return json(502, { error: 'Slug lookup failed' });
    const ppRows = await ppResp.json();
    if (!ppRows.length) return json(404, { error: 'Proposal not found' });
    const { id: published_proposal_id, proposal_id, project_address } = ppRows[0];

    // Ownership check
    const cpResp = await sb(
      'client_proposals?proposal_id=eq.' + encodeURIComponent(proposal_id) +
      '&select=client:clients(id,name,email,user_id)&limit=20'
    );
    if (!cpResp.ok) return json(502, { error: 'Ownership lookup failed' });
    const cpRows = await cpResp.json();
    const matchedRow = cpRows.find((r) => r.client && r.client.user_id === callerUser.id);
    if (!matchedRow) return json(403, { error: 'Not your proposal' });
    const client = matchedRow.client;

    // Auto-supersede any prior pending redesigns from same client+proposal
    const supersedeResp = await sb(
      'proposal_redesign_requests?proposal_id=eq.' + proposal_id +
      '&client_id=eq.' + client.id +
      '&status=in.(submitted,reviewed)',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'superseded' }),
      }
    );
    if (!supersedeResp.ok) {
      // Non-fatal. Continue.
      console.warn('[submit-redesign] supersede failed', await supersedeResp.text());
    }

    // Pre-allocate the new request id so the photo path is deterministic
    const requestId = crypto.randomUUID();

    // Upload photo if present
    let photo_url = null;
    if (photo && photo.size > 0) {
      const ext = photo.type === 'image/png' ? 'png' : (photo.type === 'image/webp' ? 'webp' : 'jpg');
      const objectPath = requestId + '/markup.' + ext;
      const photoBuf = await photo.arrayBuffer();
      const upResp = await fetch(
        SUPABASE_URL + '/storage/v1/object/client-redesign-uploads/' + objectPath,
        {
          method: 'POST',
          headers: {
            'Content-Type': photo.type,
            'Authorization': 'Bearer ' + SERVICE_ROLE,
            'apikey': SERVICE_ROLE,
            'x-upsert': 'true',
          },
          body: photoBuf,
        }
      );
      if (!upResp.ok) {
        return json(502, { error: 'Photo upload failed: ' + (await upResp.text()).slice(0, 240) });
      }
      photo_url = SUPABASE_URL + '/storage/v1/object/public/client-redesign-uploads/' + objectPath;
    }

    // Insert request row
    const insRow = {
      id: requestId,
      proposal_id,
      published_proposal_id,
      client_id: client.id,
      status: 'submitted',
      markup_svg: (markup_svg && markup_svg.trim()) || null,
      photo_url,
      homeowner_note,
      site_map_url_at_submit: site_map_url,
      site_map_width_at_submit: Number.isFinite(site_map_width) ? site_map_width : null,
      site_map_height_at_submit: Number.isFinite(site_map_height) ? site_map_height : null,
    };
    const insResp = await sb('proposal_redesign_requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(insRow),
    });
    if (!insResp.ok) {
      return json(502, { error: 'Could not save request: ' + (await insResp.text()).slice(0, 240) });
    }
    const insertedRows = await insResp.json();
    const inserted = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;

    // Send designer email
    let emailSent = false;
    let emailError = null;
    if (RESEND_API_KEY) {
      try {
        const adminUrl = PUBLIC_BASE_URL + '/admin/client-redesigns.html';
        const proposalUrl = PUBLIC_BASE_URL + '/p/' + slug;
        const hasMarkup = !!inserted.markup_svg;
        const hasPhoto = !!inserted.photo_url;
        const submissionType = hasMarkup ? 'digital markup' : (hasPhoto ? 'photo of paper markup' : 'note only');
        const subject = (client.name || 'Homeowner') + ' submitted a design change request on ' + (project_address || 'their proposal');

        const emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: RESEND_FROM,
            to: [DESIGNER_EMAIL],
            reply_to: client.email,
            subject,
            html: buildEmailHtml({
              clientName: client.name,
              clientEmail: client.email,
              projectAddress: project_address,
              submissionType,
              homeownerNote: homeowner_note,
              hasMarkup,
              hasPhoto,
              adminUrl,
              proposalUrl,
            }),
            text: buildEmailText({
              clientName: client.name,
              projectAddress: project_address,
              submissionType,
              homeownerNote: homeowner_note,
              hasMarkup,
              hasPhoto,
              adminUrl,
              proposalUrl,
            }),
          }),
        });
        if (emailResp.ok) {
          emailSent = true;
        } else {
          emailError = 'Resend ' + emailResp.status + ': ' + (await emailResp.text()).slice(0, 240);
        }
      } catch (err) {
        emailError = 'Resend fetch failed: ' + ((err && err.message) || 'unknown');
      }
    } else {
      emailError = 'RESEND_API_KEY not configured';
    }

    return json(200, {
      ok: true,
      request_id: inserted.id,
      email_sent: emailSent,
      email_error: emailError,
    });

  } catch (err) {
    return json(500, { error: (err && err.message) || 'Unexpected server error' });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function buildEmailHtml({ clientName, clientEmail, projectAddress, submissionType, homeownerNote, hasMarkup, hasPhoto, adminUrl, proposalUrl }) {
  const noteHtml = homeownerNote
    ? '<div style="background:#dad7c5;border-left:3px solid #5d7e69;padding:14px 16px;margin-bottom:24px;border-radius:4px;font-size:14px;color:#353535;line-height:1.55;font-style:italic;">"' + escapeHtml(homeownerNote) + '"</div>'
    : '';
  const contents = [
    hasMarkup ? '✏️ Digital markup drawn on site map' : null,
    hasPhoto ? '📷 Photo of paper markup uploaded' : null,
    homeownerNote ? '📝 Text note included' : null,
  ].filter(Boolean);
  const contentsHtml = '<ul style="margin:0;padding-left:20px;color:#58595b;font-size:13px;line-height:1.7;">' +
    contents.map(c => '<li>' + escapeHtml(c) + '</li>').join('') + '</ul>';

  return '<!DOCTYPE html>\n' +
'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Design change request</title></head>' +
'<body style="margin:0;padding:0;background:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1f2125;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f7f4;padding:40px 20px;">' +
'<tr><td align="center">' +
'<table role="presentation" cellpadding="0" cellspacing="0" width="640" style="max-width:640px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">' +
'<tr><td style="background:#5d7e69;padding:28px 36px;">' +
'<h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;">Design change request</h1>' +
'<p style="margin:6px 0 0;color:#dad7c5;font-size:13px;">From ' + escapeHtml(clientName || 'a homeowner') + (projectAddress ? ' · ' + escapeHtml(projectAddress) : '') + '</p>' +
'</td></tr>' +
'<tr><td style="padding:28px 36px 8px;">' +
noteHtml +
'<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#999;font-weight:700;margin-bottom:8px;">What\'s in this submission</div>' +
contentsHtml +
'<p style="margin:24px 0 8px;color:#58595b;font-size:14px;line-height:1.55;">' +
escapeHtml(clientName || 'They') + ' is asking for changes that go beyond material swaps — ' +
'open the admin queue to view the markup or photo and decide on next steps.' +
'</p>' +
'<div style="text-align:center;margin:24px 0 0;">' +
'<a href="' + escapeHtml(adminUrl) + '" style="display:inline-block;background:#5d7e69;color:#fff;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:14px;font-weight:600;">Review in admin queue</a>' +
'</div>' +
'<p style="margin:12px 0 0;text-align:center;font-size:12px;">' +
'<a href="' + escapeHtml(proposalUrl) + '" style="color:#5d7e69;text-decoration:none;">or view the proposal page →</a>' +
'</p>' +
'<p style="margin:24px 0 0;font-size:12px;color:#a0a09c;line-height:1.5;">' +
'Reply to this email to respond directly to ' + escapeHtml(clientName || 'the homeowner') + '. ' +
'After updating the proposal, mark this request addressed in the admin queue.' +
'</p>' +
'</td></tr>' +
'<tr><td style="padding:20px 36px;background:#f7f7f4;border-top:1px solid #e4e4df;text-align:center;">' +
'<p style="margin:0;font-size:12px;color:#70726f;">Bayside Pavers Builder · ' + escapeHtml(PUBLIC_BASE_URL) + '</p>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

function buildEmailText({ clientName, projectAddress, submissionType, homeownerNote, hasMarkup, hasPhoto, adminUrl, proposalUrl }) {
  const lines = [
    'Design change request',
    '',
    'From: ' + (clientName || 'a homeowner') + (projectAddress ? ' (' + projectAddress + ')' : ''),
    'Submission type: ' + submissionType,
    '',
  ];
  if (homeownerNote) {
    lines.push('Note from homeowner:', '"' + homeownerNote + '"', '');
  }
  lines.push('Contents:');
  if (hasMarkup) lines.push('  - Digital markup drawn on site map');
  if (hasPhoto) lines.push('  - Photo of paper markup uploaded');
  if (homeownerNote) lines.push('  - Text note included');
  lines.push('', 'Review: ' + adminUrl, 'Proposal page: ' + proposalUrl, '');
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
