/**
 * firebase-messaging-sw.js — UniSync Service Worker & FCM Handler
 * Must be served from the root path (/).
 * Handles:
 *  1. Background Push Notifications (Firebase Cloud Messaging)
 *  2. Safe Cache Management & Versioning for PWA Assets
 *  3. Seamless Background Update Activation via SKIP_WAITING
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Cache version identifier — update when static assets or core shell changes
const CACHE_NAME = 'unisync-core-v1.3.0';

// Essential offline app shell assets
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.png',
  '/logo-icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

// ── 1. INSTALL LIFECYCLE ────────────────────────────────────────────────────
self.addEventListener('install', event => {
  // Precache core static shell during installation
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(err => {
        console.warn('[SW] Precache asset fetch failure:', err);
      });
    })
  );
  // Do NOT self.skipWaiting() here automatically so existing active user sessions
  // are never interrupted until the user clicks "Update Now" or reopens the app.
});

// ── 2. ACTIVATE LIFECYCLE ───────────────────────────────────────────────────
self.addEventListener('activate', event => {
  // Safe Cache Cleanup: Purge outdated caches while preserving IndexedDB / user data
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME && key.startsWith('unisync-')) {
            console.log('[SW] Deleting obsolete cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ── 3. FETCH STRATEGY ───────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Strictly skip non-GET requests, Firebase APIs, Firestore, Analytics, and API routes
  if (
    req.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/_vercel/') ||
    url.pathname.startsWith('/__/') ||
    url.pathname.includes('firestore.googleapis.com') ||
    url.pathname.includes('identitytoolkit.googleapis.com') ||
    url.pathname.includes('securetoken.googleapis.com') ||
    url.pathname.includes('fcm.googleapis.com')
  ) {
    return;
  }

  // Network-first for HTML navigation requests (ensures new deployments load immediately)
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for fingerprinted / versioned assets (/assets/*, fonts, images)
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.svg'))) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return res;
      });
    })
  );
});

// ── 4. MESSAGE LISTENER (SKIP_WAITING TRIGGER) ──────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING received. Activating new worker...');
    self.skipWaiting();
  }
});

// ── 5. FIREBASE CLOUD MESSAGING CONFIG ──────────────────────────────────────
firebase.initializeApp({
  apiKey: "AIzaSyA5RHWOTmIJtPuadbOzNCpMjc29xZ2w8lM",
  authDomain: "unisynclive.firebaseapp.com",
  projectId: "unisynclive",
  storageBucket: "unisynclive.firebasestorage.app",
  messagingSenderId: "214136330464",
  appId: "1:214136330464:web:8f6c75a8e8b1ecb2e71885"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage(payload => {
  console.log('[firebase-messaging-sw.js] Background message:', payload);

  const notifTitle = payload.notification?.title || payload.data?.title || 'UniSync Meeting';
  const notifBody  = payload.notification?.body  || payload.data?.body  || 'You have a new meeting notification.';
  const data       = payload.data || {};

  const options = {
    body: notifBody,
    icon: '/logo.png',
    badge: '/logo.png',
    tag: data.meetingId || 'unisync-meeting',
    data: data,
    actions: data.type === 'meeting_invite' ? [
      { action: 'accept',   title: '✅ Accept'  },
      { action: 'decline',  title: '❌ Decline' }
    ] : [],
    vibrate: [200, 100, 200]
  };

  self.registration.showNotification(notifTitle, options);
});

// Handle notification click — open UniSync and navigate to meetings
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const meetingId = event.notification.data?.meetingId;
  const urlToOpen = meetingId
    ? `${self.location.origin}/?meetingId=${meetingId}#meetings`
    : `${self.location.origin}/`;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'NAVIGATE_MEETINGS', meetingId });
          return client.focus();
        }
      }
      return clients.openWindow(urlToOpen);
    })
  );
});
