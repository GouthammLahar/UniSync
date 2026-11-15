/**
 * notifications.js — UniSync In-App Notification Bell Controller
 * Handles real-time Firestore notification listening, bell badge, dropdown rendering.
 */

import { listenToNotifications, markNotificationRead, markAllNotificationsRead } from './meetings-db.js?v=10';
import { auth } from './db.js?v=10';

let _unsubNotif = null;
let _currentNotifs = [];
let _switchViewFn = null;

/**
 * Initialises the notification bell for the given user.
 * @param {string} uid
 * @param {Function} switchViewFn — from app.js to navigate to meetings-view
 */
export function initNotificationBell(uid, switchViewFn) {
  _switchViewFn = switchViewFn;
  _wireNotifBell();

  if (_unsubNotif) _unsubNotif();
  _unsubNotif = listenToNotifications(uid, notifs => {
    _currentNotifs = notifs;
    _updateBadge(notifs);
    _renderDropdownIfOpen(notifs);
  });
}

export function cleanupNotificationBell() {
  if (_unsubNotif) { _unsubNotif(); _unsubNotif = null; }
  _currentNotifs = [];
  _updateBadge([]);
}

function _wireNotifBell() {
  const bellBtn     = document.getElementById('notif-bell-btn');
  const dropdown    = document.getElementById('notif-dropdown');
  const markAllBtn  = document.getElementById('mark-all-read-btn');

  if (!bellBtn || !dropdown) return;

  bellBtn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains('hidden');
    if (isOpen) {
      dropdown.classList.add('hidden');
    } else {
      dropdown.classList.remove('hidden');
      _renderDropdown(_currentNotifs);
    }
  });

  document.addEventListener('click', e => {
    const wrap = document.getElementById('notif-bell-wrap');
    if (wrap && !wrap.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

  markAllBtn?.addEventListener('click', async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    await markAllNotificationsRead(uid);
  });
}

function _updateBadge(notifs) {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const unread = notifs.filter(n => !n.read).length;
  badge.textContent = unread > 9 ? '9+' : unread;
  badge.classList.toggle('hidden', unread === 0);
}

function _renderDropdownIfOpen(notifs) {
  const dropdown = document.getElementById('notif-dropdown');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    _renderDropdown(notifs);
  }
}

function _renderDropdown(notifs) {
  const list = document.getElementById('notif-list');
  if (!list) return;

  if (notifs.length === 0) {
    list.innerHTML = `<div class="notif-empty">
      <span class="notif-empty-icon">🔔</span>
      <p>No notifications yet</p>
    </div>`;
    return;
  }

  list.innerHTML = notifs.map(n => _buildNotifItem(n)).join('');

  list.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', async () => {
      const id = item.dataset.notifId;
      const notif = _currentNotifs.find(n => n.id === id);
      if (!notif) return;
      if (!notif.read) await markNotificationRead(id);
      // Navigate to meetings
      if (_switchViewFn) {
        document.getElementById('notif-dropdown')?.classList.add('hidden');
        _switchViewFn('meetings-view');
      }
    });
  });
}

function _buildNotifItem(notif) {
  const icon = {
    meeting_invite:    '📩',
    meeting_accepted:  '✅',
    meeting_rejected:  '❌',
    meeting_confirmed: '🎉',
    meeting_cancelled: '🗑️',
    meeting_reminder:  '⏰'
  }[notif.type] || '🔔';

  const timeStr = notif.createdAt?.toDate
    ? _relativeTime(notif.createdAt.toDate())
    : 'just now';

  return `<div class="notif-item ${notif.read ? 'read' : 'unread'}" data-notif-id="${notif.id}">
    <span class="notif-icon">${icon}</span>
    <div class="notif-body">
      <p class="notif-title">${notif.title || 'Notification'}</p>
      <p class="notif-message">${notif.message || ''}</p>
      <span class="notif-time">${timeStr}</span>
    </div>
    ${!notif.read ? '<span class="notif-dot"></span>' : ''}
  </div>`;
}

function _relativeTime(date) {
  const diff = Date.now() - date.getTime();
  const mins  = Math.floor(diff / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
