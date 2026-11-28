/**
 * api/auth/gmail/recover.js — Vercel Serverless: Attempt Gmail token recovery
 * POST /api/auth/gmail/recover
 *
 * When the status endpoint returns { connected: false, reason: 'token_revoked' },
 * the frontend can call this endpoint to attempt a silent recovery before
 * prompting the user to re-authorise. Recovery succeeds if the stored refresh
 * token is still valid (e.g., 'revoked' was set due to a transient error).
 */

import { verifyToken } from '../../_utils/admin.js';
import { getGmailConnectionStatus } from '../../_utils/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;

    // getGmailConnectionStatus already attempts recovery internally when
    // revoked=true but a refreshToken exists. Re-calling it here gives the
    // freshest result after recovery has been attempted.
    const status = await getGmailConnectionStatus(uid);
    return res.status(200).json(status);
  } catch (err) {
    const statusCode = err.message?.includes('token') ? 401 : 500;
    return res.status(statusCode).json({ error: err.message, connected: false });
  }
}
