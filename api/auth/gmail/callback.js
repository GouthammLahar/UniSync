/**
 * api/auth/gmail/callback.js — Vercel Serverless: Google OAuth Callback for Gmail
 * GET /api/auth/gmail/callback?code=...&state=...
 */

import { getAuth } from 'firebase-admin/auth';
import { getAdminApp, getAdminFirestore } from '../../_utils/admin.js';
import { verifySignedState, getRedirectUri } from '../../_utils/gmail.js';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://unisynclive.vercel.app';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state, error } = req.query;

  if (error) {
    console.warn('[Gmail OAuth Callback] User or Google returned error:', error);
    return res.redirect(`${APP_URL}/?gmail=denied&reason=${encodeURIComponent(error)}#meetings`);
  }

  if (!code || !state) {
    return res.redirect(`${APP_URL}/?gmail=error&reason=missing_params#meetings`);
  }

  // Verify signed state and extract Firebase UID
  const uid = verifySignedState(state);
  if (!uid) {
    console.warn('[Gmail OAuth Callback] Invalid or expired state token');
    return res.redirect(`${APP_URL}/?gmail=error&reason=invalid_state#meetings`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.redirect(`${APP_URL}/?gmail=error&reason=server_misconfigured#meetings`);
  }

  try {
    const redirectUri = getRedirectUri(req);

    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('[Gmail OAuth Callback] Token exchange failed:', tokenData);
      return res.redirect(`${APP_URL}/?gmail=error&reason=${encodeURIComponent(tokenData.error || 'token_exchange_failed')}#meetings`);
    }

    const { access_token, refresh_token, expires_in, scope } = tokenData;
    const now = Date.now();
    const expiryDate = now + (expires_in * 1000);

    // Retrieve user details from Firebase Admin Auth
    getAdminApp();
    const auth = getAuth();
    const userRecord = await auth.getUser(uid).catch(() => null);
    const senderEmail = userRecord?.email || '';

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
    const credRef = db.collection('userCredentials').doc(uid);
    const existingSnap = await credRef.get();
    const existingData = existingSnap.exists ? existingSnap.data() : {};

    // Preserve existing refresh token if Google didn't reissue one on repeat authorization
    const finalRefreshToken = refresh_token || existingData?.gmail?.refreshToken;

    if (!finalRefreshToken) {
      console.warn('[Gmail OAuth Callback] No refresh token received or existing for uid:', uid);
      return res.redirect(`${APP_URL}/?gmail=error&reason=no_refresh_token#meetings`);
    }

    await credRef.set({
      gmail: {
        refreshToken: finalRefreshToken,
        accessToken: access_token,
        expiryDate,
        connectedAt: FieldValue.serverTimestamp(),
        scope: scope || 'https://www.googleapis.com/auth/gmail.send',
        revoked: false,
        senderEmail
      }
    }, { merge: true });

    console.log(`[Gmail OAuth Callback] Successfully connected Gmail for uid: ${uid} (${senderEmail})`);
    return res.redirect(`${APP_URL}/?gmail=connected#meetings`);
  } catch (err) {
    console.error('[Gmail OAuth Callback] Exception:', err.message);
    return res.redirect(`${APP_URL}/?gmail=error&reason=${encodeURIComponent(err.message)}#meetings`);
  }
}
