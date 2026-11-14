/**
 * api/notifications/test.js — Vercel Serverless: Send a test push notification to current user
 * POST /api/notifications/test
 */

import { verifyToken, getAdminFirestore, sendFCMToTokens, getTokensForUsers } from '../_utils/admin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;

    const tokens = await getTokensForUsers([uid]);
    if (tokens.length === 0) {
      return res.status(400).json({ error: 'No FCM token registered for this user. Enable push notifications first.' });
    }

    await sendFCMToTokens(tokens,
      { title: '🧪 UniSync Test Notification', body: 'Push notifications are working correctly!' },
      { type: 'test' }
    );

    return res.status(200).json({ success: true, tokensFound: tokens.length });
  } catch (err) {
    return res.status(err.message.includes('token') ? 401 : 500).json({ error: err.message });
  }
}
