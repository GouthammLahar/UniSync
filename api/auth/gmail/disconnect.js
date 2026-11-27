/**
 * api/auth/gmail/disconnect.js — Vercel Serverless: Disconnect and Revoke Gmail Token
 * POST /api/auth/gmail/disconnect
 * Requires: Authorization: Bearer <FirebaseIdToken>
 */

import { verifyToken, getAdminFirestore } from '../../_utils/admin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
    const credRef = db.collection('userCredentials').doc(uid);
    const docSnap = await credRef.get();

    if (docSnap.exists) {
      const data = docSnap.data();
      const tokenToRevoke = data?.gmail?.accessToken || data?.gmail?.refreshToken;

      // Attempt token revocation with Google OAuth2 revoke endpoint (non-blocking)
      if (tokenToRevoke) {
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
          });
        } catch (revokeErr) {
          console.warn('[api/auth/gmail/disconnect] Revoke request failed (token may already be invalid):', revokeErr.message);
        }
      }

      // Delete the gmail credential field in Firestore
      await credRef.update({
        gmail: FieldValue.delete()
      });
    }

    console.log(`[Gmail] User ${uid} disconnected Gmail integration.`);
    return res.status(200).json({ success: true, disconnected: true });
  } catch (err) {
    console.error('[api/auth/gmail/disconnect] Error:', err.message);
    const statusCode = err.message?.includes('token') ? 401 : 500;
    return res.status(statusCode).json({ error: err.message });
  }
}
