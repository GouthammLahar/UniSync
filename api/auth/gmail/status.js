/**
 * api/auth/gmail/status.js — Vercel Serverless: Check Gmail Connection Status
 * GET /api/auth/gmail/status
 * Requires: Authorization: Bearer <FirebaseIdToken>
 */

import { verifyToken } from '../../_utils/admin.js';
import { getGmailConnectionStatus } from '../../_utils/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;

    const status = await getGmailConnectionStatus(uid);
    return res.status(200).json(status);
  } catch (err) {
    const statusCode = err.message?.includes('token') ? 401 : 500;
    return res.status(statusCode).json({ error: err.message, connected: false });
  }
}
