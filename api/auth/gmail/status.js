/**
 * api/auth/gmail/status.js — Vercel Serverless: Check Gmail Connection Status
 *
 * GET  /api/auth/gmail/status  — Check if the current user has connected Gmail.
 * POST /api/auth/gmail/status  — Trigger a silent token-recovery attempt, then
 *                                return the refreshed connection status.
 *                                (Previously served by /api/auth/gmail/recover)
 *
 * Both methods require: Authorization: Bearer <FirebaseIdToken>
 */

import { verifyToken } from '../../_utils/admin.js';
import { getGmailConnectionStatus } from '../../_utils/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;

    // getGmailConnectionStatus already performs auto-recovery internally when
    // revoked=true but a valid refreshToken still exists in Firestore.
    // Calling it on both GET and POST is intentional: the POST path is used
    // by the frontend specifically to trigger that recovery attempt.
    const status = await getGmailConnectionStatus(uid);
    return res.status(200).json(status);
  } catch (err) {
    const statusCode = err.message?.includes('token') ? 401 : 500;
    return res.status(statusCode).json({ error: err.message, connected: false });
  }
}
