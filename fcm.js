/**
 * fcm.js — Firebase Cloud Messaging integration for UniSync
 * Handles browser push notification permission, token registration, and cleanup.
 */

import { getMessaging, getToken, onMessage, deleteToken } from 'firebase/messaging';
import { getApp } from 'firebase/app';
import { saveFCMToken, deleteFCMToken } from './meetings-db.js?v=10';

// VAPID key — set via Vercel env var injected at build time, or fallback
// Replace YOUR_VAPID_KEY_HERE with the actual key from Firebase Console → Project Settings → Cloud Messaging
const VAPID_KEY = window.__FCM_VAPID_KEY__ || 'BPOJdGHkf4v_GLWRLMRH4zrocNmgH0Y7XwZAHjM-xa1iQy3DEylBsZhvG6Chhl4zYkarlIYVnUzDqFltN7D-ggY';

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

let _registrationPromise = null;
let _refreshing = false;

/**
 * Registers the service worker with root scope '/' if supported.
 * Safe to call on app load; does not request push notification permission.
 * Includes lifecycle listeners to detect pending updates and surface the update UI.
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return null;
  }

  // Prevent multiple concurrent registrations
  if (_registrationPromise) {
    return _registrationPromise;
  }

  _registrationPromise = (async () => {
    try {
      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
      console.log('[SW] Service Worker registered:', registration.scope);

      // Listen for controllerchange to reload safely exactly once
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (_refreshing) return;
        _refreshing = true;
        console.log('[SW] New controller active. Reloading application...');
        window.location.reload();
      });

      // If a service worker is already waiting (e.g. from previous visit or tab)
      if (registration.waiting) {
        notifyUpdateAvailable(registration.waiting);
      }

      // Check on updatefound event
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          // When the new worker is installed and waiting
          if (newWorker.state === 'installed') {
            if (navigator.serviceWorker.controller) {
              // Existing installation updated: notify user
              notifyUpdateAvailable(newWorker);
            } else {
              // First-time install: do not show update prompt
              console.log('[SW] First-time install completed. Content cached for offline use.');
            }
          }
        });
      });

      // Periodically check for updates (every 60 minutes) and on window focus
      if (window.location.hostname !== 'localhost') {
        setInterval(() => {
          registration.update().catch(e => console.warn('[SW] Periodic update check failed:', e));
        }, 60 * 60 * 1000);
      }

      window.addEventListener('focus', () => {
        registration.update().catch(e => console.warn('[SW] Focus update check failed:', e));
      });

      return registration;
    } catch (err) {
      console.error('[SW] Service Worker registration failed:', err);
      return null;
    }
  })();

  return _registrationPromise;
}

/**
 * Displays an elegant non-intrusive banner notifying the user an update is ready.
 * Includes "Update Now" and "Later" buttons matching UniSync's design system.
 * @param {ServiceWorker} worker - The waiting service worker instance
 */
function notifyUpdateAvailable(worker) {
  // Prevent duplicate banners
  if (document.getElementById('unisync-update-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'unisync-update-banner';
  banner.className = 'pwa-update-banner';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `
    <div class="pwa-update-content">
      <div class="pwa-update-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
        </svg>
      </div>
      <div class="pwa-update-text">
        <strong>New version available</strong>
        <span>Update UniSync for the latest features & schedule sync improvements.</span>
      </div>
    </div>
    <div class="pwa-update-actions">
      <button type="button" class="btn-update-now" id="pwa-update-now-btn">Update Now</button>
      <button type="button" class="btn-update-later" id="pwa-update-later-btn">Later</button>
    </div>
  `;

  document.body.appendChild(banner);

  const updateNowBtn = document.getElementById('pwa-update-now-btn');
  const updateLaterBtn = document.getElementById('pwa-update-later-btn');

  if (updateNowBtn) {
    updateNowBtn.addEventListener('click', () => {
      updateNowBtn.disabled = true;
      updateNowBtn.innerText = 'Updating…';

      // Tell waiting service worker to skip waiting
      if (worker && worker.state !== 'redundant') {
        worker.postMessage({ type: 'SKIP_WAITING' });
      } else {
        navigator.serviceWorker.getRegistration().then(reg => {
          if (reg?.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          } else {
            window.location.reload();
          }
        });
      }
    });
  }

  if (updateLaterBtn) {
    updateLaterBtn.addEventListener('click', () => {
      banner.classList.add('dismissed');
      setTimeout(() => banner.remove(), 300);
    });
  }
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

  try {
    const registration = await registerServiceWorker();
    if (!registration) {
      console.warn('Service workers not supported or registration failed');
      return null;
    }

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
