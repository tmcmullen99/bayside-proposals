/**
 * BPB Phase 1A — Site Map Backdrop Upload
 *
 * POST /api/site-map-backdrop-upload
 *
 * Accepts a multipart/form-data upload with:
 *   - proposal_id (form field, UUID)
 *   - file (form field, PNG or JPEG, max 10MB)
 *
 * Behavior:
 *   1. Validates the auth header (must be Tim's user JWT)
 *   2. Reads the image, computes its native pixel dimensions
 *   3. Uploads to Supabase Storage bucket "site-plans" at
 *      `${proposal_id}/backdrop.${ext}` (overwrites any existing backdrop)
 *   4. Updates the `proposals` row: site_plan_backdrop_url, _width, _height
 *   5. Returns { url, width, height }
 *
 * Used by: /admin/site-map.html (the labeling UI)
 */

const TIM_USER_ID = '7a3930d1-f05a-49b1-a37f-d73329f37153';

// CORS headers for the admin UI
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Read the PNG/JPEG header to extract image dimensions WITHOUT decoding the
 * full image. Avoids loading 10MB into memory just to get width/height.
 *
 * PNG: 8-byte signature, then IHDR chunk at offset 16 has width(4) + height(4)
 *   big-endian.
 * JPEG: walk markers until SOFn (0xC0..0xCF except C4/C8/CC) — 5 bytes in is
 *   height(2) + width(2) big-endian.
 */
function getImageDimensions(bytes, mimeType) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (mimeType === 'image/png') {
    // PNG signature is 8 bytes: 89 50 4E 47 0D 0A 1A 0A
    if (view.getUint32(0) !== 0x89504e47) {
      throw new Error('Not a valid PNG');
    }
    // IHDR width is at offset 16, height at offset 20
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return { width, height };
  }

  if (mimeType === 'image/jpeg') {
    // JPEG starts with FF D8
    if (view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) {
      throw new Error('Not a valid JPEG');
    }
    let i = 2;
    while (i < view.byteLength) {
      // Each marker starts with 0xFF
      if (view.getUint8(i) !== 0xff) {
        throw new Error('Bad JPEG marker at offset ' + i);
      }
      const marker = view.getUint8(i + 1);
      // SOFn markers (Start Of Frame): 0xC0..0xCF except 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        // SOF: skip 2 (marker) + 2 (length) + 1 (precision) = offset+5 has height
        const height = view.getUint16(i + 5);
        const width = view.getUint16(i + 7);
        return { width, height };
      }
      // Otherwise skip this segment: length is at i+2 (big-endian, includes itself)
      const segmentLength = view.getUint16(i + 2);
      i += 2 + segmentLength;
    }
    throw new Error('No SOF marker found in JPEG');
  }

  throw new Error('Unsupported image type: ' + mimeType);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1) Auth: require user JWT in Authorization header, verify it matches Tim
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Missing Authorization Bearer token' }, 401);
    }
    const userJwt = authHeader.slice(7);

    // Verify the JWT by calling Supabase auth.getUser endpoint
    const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${userJwt}`,
        apikey: env.SUPABASE_ANON_KEY,
      },
    });
    if (!userResp.ok) {
      return jsonResponse({ error: 'Invalid auth token' }, 401);
    }
    const user = await userResp.json();
    if (user.id !== TIM_USER_ID) {
      return jsonResponse({ error: 'Forbidden: admin only' }, 403);
    }

    // 2) Parse multipart form
    const formData = await request.formData();
    const proposalId = formData.get('proposal_id');
    const file = formData.get('file');

    if (!proposalId || typeof proposalId !== 'string') {
      return jsonResponse({ error: 'Missing proposal_id' }, 400);
    }
    if (!file || typeof file === 'string') {
      return jsonResponse({ error: 'Missing file' }, 400);
    }

    // 3) Validate file type and size
    const mimeType = file.type;
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
      return jsonResponse({ error: 'File must be PNG or JPEG' }, 400);
    }
    if (file.size > 10 * 1024 * 1024) {
      return jsonResponse({ error: 'File exceeds 10MB limit' }, 400);
    }

    // 4) Read bytes once, extract dimensions
    const bytes = new Uint8Array(await file.arrayBuffer());
    let width, height;
    try {
      ({ width, height } = getImageDimensions(bytes, mimeType));
    } catch (err) {
      return jsonResponse({ error: 'Could not parse image: ' + err.message }, 400);
    }

    // 5) Upload to Supabase Storage at site-plans/{proposal_id}/backdrop.{ext}
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const objectPath = `${proposalId}/backdrop.${ext}`;

    // Use service role to upload (bypasses RLS, server-side only).
    // The user JWT was verified above so we know the caller is Tim.
    const uploadResp = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/site-plans/${objectPath}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': mimeType,
          'x-upsert': 'true',
          'Cache-Control': 'no-cache',
        },
        body: bytes,
      }
    );
    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      return jsonResponse(
        { error: 'Storage upload failed', detail: errText, status: uploadResp.status },
        502
      );
    }

    // 6) Construct the public URL
    // Append a cache-buster timestamp so the admin UI sees the new image immediately
    // after re-upload (browsers aggressively cache the same path).
    const cacheBust = Date.now();
    const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/site-plans/${objectPath}?v=${cacheBust}`;

    // 7) Update the proposals row
    const updateResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/proposals?id=eq.${proposalId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          site_plan_backdrop_url: publicUrl,
          site_plan_backdrop_width: width,
          site_plan_backdrop_height: height,
        }),
      }
    );
    if (!updateResp.ok) {
      const errText = await updateResp.text();
      return jsonResponse(
        { error: 'Proposal update failed', detail: errText, status: updateResp.status },
        502
      );
    }

    return jsonResponse({
      url: publicUrl,
      width,
      height,
      proposal_id: proposalId,
    });
  } catch (err) {
    return jsonResponse({ error: 'Server error: ' + err.message }, 500);
  }
}
