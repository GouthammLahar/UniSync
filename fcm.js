/**
 * fcm.js — Firebase Cloud Messaging integration for UniSync
 * Handles browser push notification permission, token registration, and cleanup.
 */

import { getMessaging, getToken, onMessage, deleteToken } from 'firebase/messaging';
import { getApp } from 'firebase/app';
import { saveFCMToken, deleteFCMToken } from './meetings-db.js?v=9';

// VAPID key — set via Vercel env var injected at build time, or fallback
// Replace YOUR_VAPID_KEY_HERE with the actual key from Firebase Console → Project Settings → Cloud Messaging
const VAPID_KEY = window.__FCM_VAPID_KEY__ || 'YOUR_VAPID_KEY_HERE';

let _messaging = null;

function getMessagingInstance() {
  if (!_messaging) {
    try {
      _messaging = getMessaging(getApp());
    } catch (e) {
      console.warn('FCM messaging not available:', e.message);
    }
  }
  return _messaging;
}

/**
 * Registers the service worker and requests push permission.
 * Saves the FCM token to Firestore for backend use.
 * @param {string} uid — current user's Firebase Auth UID
 * @returns {string|null} — FCM token or null
 */
export async function requestPushPermission(uid) {
  if (!('Notification' in window)) {
    console.warn('Browser does not support notifications');
    return null;
  }

  // Register service worker
  if (!('serviceWorker' in navigator)) {
    console.warn('Service workers not supported');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
    console.log('Service Worker registered:', registration.scope);

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.log('Push permission denied');
      return null;
    }

    const messaging = getMessagingInstance();
    if (!messaging) return null;

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration
    });

    if (token) {
      await saveFCMToken(uid, token);
      console.log('FCM token saved:', token.substring(0, 20) + '...');
      return token;
    }
    return null;
  } catch (err) {
    console.error('FCM setup error:', err);
    return null;
  }
}

/**
 * Disables push notifications for the user.
 */
export async function disablePushNotifications(uid) {
  try {
    const messaging = getMessagingInstance();
    if (messaging) await deleteToken(messaging);
    await deleteFCMToken(uid);
    console.log('FCM token deleted');
  } catch (err) {
    console.error('FCM disable error:', err);
  }
}

/**
 * Gets the current push permission state.
 * @returns {'granted'|'denied'|'default'|'unsupported'}
 */
export function getPushPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * Sets up an in-app foreground message listener.
 * When the app is open and a push arrives, this fires instead of the service worker.
 * @param {Function} onMessageCallback - called with { title, body, type, meetingId }
 * @returns unsubscribe function or null
 */
export function setupForegroundMessageListener(onMessageCallback) {
  const messaging = getMessagingInstance();
  if (!messaging) return null;

  return onMessage(messaging, payload => {
    console.log('Foreground FCM message:', payload);
    const { title, body, type, meetingId } = payload.data || {};
    if (onMessageCallback) {
      onMessageCallback({ title: title || payload.notification?.title, body: body || payload.notification?.body, type, meetingId });
    }
  });
}
