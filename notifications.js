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

  // Toggle notification dropdown
  bellBtn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains('hidden');
    if (isOpen) {
      _closeDropdown(dropdown, bellBtn);
    } else {
      // Close user account dropdown if open to prevent overlapping
      const userDropdown = document.getElementById('user-dropdown-panel');
      const userMenuWrap = document.getElementById('nav-user-menu-wrap');
      if (userDropdown) userDropdown.classList.add('hidden');
      if (userMenuWrap) userMenuWrap.classList.remove('open');

      _openDropdown(dropdown, bellBtn);
      _renderDropdown(_currentNotifs);
    }
  });

  // Clicking outside closes the dropdown
  document.addEventListener('click', e => {
    const wrap = document.getElementById('notif-bell-wrap');
    if (wrap && !wrap.contains(e.target)) {
      _closeDropdown(dropdown, bellBtn);
    }
  });

  // Pressing Escape closes the dropdown
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !dropdown.classList.contains('hidden')) {
      _closeDropdown(dropdown, bellBtn);
    }
  });

  // Prevent clicks inside the dropdown panel from accidentally closing it
  dropdown.addEventListener('click', e => {
    e.stopPropagation();
  });

  // Mark all notifications as read
  markAllBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    try {
      markAllBtn.disabled = true;
      await markAllNotificationsRead(uid);
    } catch (err) {
      console.error('Failed to mark all notifications read:', err);
    } finally {
      markAllBtn.disabled = false;
    }
  });
}

function _openDropdown(dropdown, bellBtn) {
  dropdown.classList.remove('hidden');
  bellBtn?.setAttribute('aria-expanded', 'true');
}

function _closeDropdown(dropdown, bellBtn) {
  dropdown.classList.add('hidden');
  bellBtn?.setAttribute('aria-expanded', 'false');
}

function _updateBadge(notifs) {
  const badge = document.getElementById('notif-badge');
  const unread = notifs.filter(n => !n.read).length;
  if (badge) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('hidden', unread === 0);
  }

  const countPill = document.getElementById('notif-dropdown-count');
  if (countPill) {
    countPill.textContent = unread > 0 ? `${unread} new` : '';
    countPill.classList.toggle('hidden', unread === 0);
  }

  const markAllBtn = document.getElementById('mark-all-read-btn');
  if (markAllBtn) {
    markAllBtn.disabled = unread === 0;
    markAllBtn.style.opacity = unread === 0 ? '0.45' : '1';
    markAllBtn.style.pointerEvents = unread === 0 ? 'none' : 'auto';
  }
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

  _updateBadge(notifs);

  if (notifs.length === 0) {
    list.innerHTML = `
      <div class="notif-empty">
        <div class="notif-empty-icon-wrap" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          </svg>
        </div>
        <p class="notif-empty-title">All caught up!</p>
        <p class="notif-empty-sub">You have no unread notifications or upcoming meeting alerts.</p>
      </div>`;
    return;
  }

  list.innerHTML = notifs.map(n => _buildNotifItem(n)).join('');

  list.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', async () => {
      const id = item.dataset.notifId;
      const notif = _currentNotifs.find(n => n.id === id);
      if (!notif) return;
      if (!notif.read) {
        try {
          await markNotificationRead(id);
        } catch (err) {
          console.error('Failed to mark notification read:', err);
        }
      }
      // Close dropdown and navigate to meetings view
      const dropdown = document.getElementById('notif-dropdown');
      const bellBtn = document.getElementById('notif-bell-btn');
      if (dropdown) _closeDropdown(dropdown, bellBtn);
      if (_switchViewFn) {
        _switchViewFn('meetings-view');
      }
    });

    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        item.click();
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

  return `
    <div class="notif-item ${notif.read ? 'read' : 'unread'}" data-notif-id="${notif.id}" role="button" tabindex="0">
      <div class="notif-icon-wrap" aria-hidden="true">${icon}</div>
      <div class="notif-body">
        <div class="notif-header-row">
          <h4 class="notif-title">${_escapeHtml(notif.title || 'Notification')}</h4>
          <span class="notif-time">${timeStr}</span>
        </div>
        <p class="notif-message">${_escapeHtml(notif.message || '')}</p>
      </div>
      ${!notif.read ? '<span class="notif-dot" title="Unread notification"></span>' : ''}
    </div>`;
}

function _escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
