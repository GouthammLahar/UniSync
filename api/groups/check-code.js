/**
 * api/groups/check-code.js — Vercel Serverless: Secure joining code availability check
 * POST /api/groups/check-code
 * Body: { code: string }
 * Returns: { available: boolean }
 *
 * Privacy guarantee:
 * Does NOT expose groupId, adminUid, or group metadata to the client.
 */

import { verifyToken, getAdminFirestore } from '../_utils/admin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Authenticate caller
    await verifyToken(req);

    const { code } = req.body || {};
    const normalised = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (!normalised || normalised.length < 4 || normalised.length > 12) {
      return res.status(400).json({ error: 'Code must be 4–12 alphanumeric characters' });
    }

    const db = getAdminFirestore();

    // 1. Check groupCodes registry
    const codeDoc = await db.collection('groupCodes').doc(normalised).get();
    if (codeDoc.exists) {
      return res.status(200).json({ available: false });
    }

    // 2. Check legacy groups where code matches normalised
    const legacySnap = await db.collection('groups').where('code', '==', normalised).limit(1).get();
    if (!legacySnap.empty) {
      return res.status(200).json({ available: false });
    }

    // 3. Check legacy hyphenated format (e.g. "CLA-1234") if matching CLA + 4 digits
    if (/^CLA\d{4}$/.test(normalised)) {
      const hyphenCode = `CLA-${normalised.slice(3)}`;
      const legacyHyphenSnap = await db.collection('groups').where('code', '==', hyphenCode).limit(1).get();
      if (!legacyHyphenSnap.empty) {
        return res.status(200).json({ available: false });
      }
    }

    return res.status(200).json({ available: true });
  } catch (err) {
    console.error('[API Check Code Error]:', err?.message || err);
    return res.status(err.code === 'NO_TOKEN' ? 401 : 500).json({ error: err.message || 'Server error' });
  }
}
