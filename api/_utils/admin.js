/**
 * api/_utils/admin.js — Firebase Admin SDK singleton for Vercel serverless functions.
 * Uses environment variables set in Vercel dashboard.
 */

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

let _adminApp = null;

export function getAdminApp() {
  if (_adminApp) return _adminApp;

  const apps = getApps();
  if (apps.length > 0) {
    _adminApp = apps[0];
    return _adminApp;
  }

  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n');

  _adminApp = initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_ADMIN_PROJECT_ID   || 'unisynclive',
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey
    })
  });

  return _adminApp;
}

export function getAdminFirestore() {
  getAdminApp();
  return getFirestore();
}

export function getAdminMessaging() {
  getAdminApp();
  return getMessaging();
}

/**
 * Verifies a Firebase ID token from request Authorization header.
 * @param {Request} req
 * @returns {Object} decodedToken with uid
 */
export async function verifyToken(req) {
  const { getAuth } = await import('firebase-admin/auth');
  getAdminApp();
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('No authorization token provided');
  return getAuth().verifyIdToken(token);
}

/**
 * Sends FCM notifications to multiple tokens.
 * @param {string[]} tokens
 * @param {Object} notification — { title, body }
 * @param {Object} data — key-value pairs
 */
export async function sendFCMToTokens(tokens, notification, data = {}) {
  if (!tokens || tokens.length === 0) return;
  const msg = getAdminMessaging();
  const stringData = {};
  Object.entries(data).forEach(([k, v]) => { stringData[k] = String(v || ''); });

  const results = await msg.sendEachForMulticast({
    tokens,
    notification,
    data: stringData,
    webpush: {
      notification: {
        ...notification,
        icon: '/logo.png',
        badge: '/logo.png'
      }
    }
  });
  console.log(`FCM sent: ${results.successCount} success, ${results.failureCount} failures`);
  return results;
}

/**
 * Gets FCM tokens for a list of user UIDs.
 */
export async function getTokensForUsers(uids) {
  const db = getAdminFirestore();
  const tokens = [];
  for (const uid of uids) {
    const snap = await db.doc(`fcmTokens/${uid}_web`).get();
    if (snap.exists) {
      const t = snap.data().token;
      if (t) tokens.push(t);
    }
  }
  return tokens;
}
