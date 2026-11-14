/**
 * api/notifications/register-token.js — Vercel Serverless: Register FCM token
 * POST /api/notifications/register-token
 * Body: { token }
 */

import { verifyToken, getAdminFirestore } from '../_utils/admin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;
    const { token } = req.body;

    if (!token) return res.status(400).json({ error: 'Token required' });

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;

    await db.doc(`fcmTokens/${uid}_web`).set({
      userId: uid,
      token,
      platform: 'web',
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(err.message.includes('token') ? 401 : 500).json({ error: err.message });
  }
}
