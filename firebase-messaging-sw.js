/**
 * firebase-messaging-sw.js — UniSync FCM Service Worker
 * Must be served from the root path (/).
 * Handles background push notifications when the app tab is closed or not focused.
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Install and activate lifecycle handlers for PWA installability
self.addEventListener('install', event => {
  // Activate immediately without waiting
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  // Take control of all clients as soon as possible
  event.waitUntil(self.clients.claim());
});

// Firebase config — must match config.js
// These values are safe to include in the service worker (they are client-side Firebase config, not secrets)
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
