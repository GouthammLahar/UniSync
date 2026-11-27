/**
 * api/auth/gmail/url.js — Vercel Serverless: Generate Google OAuth URL for Gmail Sending
 * GET /api/auth/gmail/url
 * Requires: Authorization: Bearer <FirebaseIdToken>
 */

import { verifyToken } from '../../_utils/admin.js';
import { createSignedState, getRedirectUri } from '../../_utils/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res.status(503).json({
        error: 'GOOGLE_OAUTH_NOT_CONFIGURED',
        message: 'Google Client ID is not configured on the server. Please set GOOGLE_CLIENT_ID in environment variables.'
      });
    }

    const redirectUri = getRedirectUri(req);
    const state = createSignedState(uid);

    // Minimal scope strictly for sending meeting emails
    const scope = 'https://www.googleapis.com/auth/gmail.send';

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    return res.status(200).json({
      success: true,
      url: authUrl.toString()
    });
  } catch (err) {
    console.error('[api/auth/gmail/url] Error:', err.message);
    const status = err.message?.includes('token') ? 401 : 500;
    return res.status(status).json({ error: err.message });
  }
}
