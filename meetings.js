/**
 * meetings.js — UniSync Meeting Scheduler UI Controller
 * Handles all meeting UI: creation modal, tabs, respond, cancel, real-time updates.
 */

import {
  createMeeting, getMeetingsForUser, respondToMeeting, cancelMeeting,
  listenToUserMeetings, notifyMeetingParticipants, createNotification
} from './meetings-db.js?v=10';
import { findCommonFreeSlots, formatTime12, formatDuration, DAY_ORDER } from './schedule-utils.js?v=10';
import { auth } from './db.js?v=10';

/* ── State ── */
let _unsubMeetings = null;
let _allMeetings   = [];
let _activeTab     = 'upcoming';
let _getGroupStudentsFn = null;  // Injected from app.js
let _getActiveGroupId   = null;
let _getActiveGroupMeta = null;
let _showToast          = null;

/* ── Bootstrap ── */

/* ── Gmail Connection State ── */
let _gmailStatus = { connected: false, email: null };

async function _checkGmailOAuthParams() {
  const params = new URLSearchParams(window.location.search);
  const gmailParam = params.get('gmail');
  if (!gmailParam) return;

  if (gmailParam === 'connected') {
    _showToast?.('✅ Gmail connected! Invitations will now be sent from your address.', 'success');
  } else if (gmailParam === 'denied' || gmailParam === 'error') {
    const reason = params.get('reason') || 'Authorization was cancelled';
    _showToast?.(`Gmail connection cancelled: ${reason}`, 'warning');
  }

  // Clean URL parameters without reloading
  params.delete('gmail');
  params.delete('reason');
  const newQuery = params.toString() ? `?${params.toString()}` : '';
  const newUrl = `${window.location.pathname}${newQuery}${window.location.hash}`;
  window.history.replaceState({}, document.title, newUrl);
}

export async function refreshGmailStatus() {
  const btn = document.getElementById('gmail-connect-btn');
  const btnText = document.getElementById('gmail-connect-btn-text');
  const user = auth.currentUser;
  if (!user) return;

  try {
    const token = await user.getIdToken();
    const res = await fetch('/api/auth/gmail/status', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Status error');
    const data = await res.json();
    _gmailStatus = data;

    if (btn && btnText) {
      if (data.connected) {
        btn.classList.add('connected');
        btnText.textContent = 'Gmail Connected';
        btn.title = `Connected as ${data.email || 'your Gmail'}. Click to disconnect.`;
      } else {
        btn.classList.remove('connected');
        btnText.textContent = 'Connect Gmail';
        btn.title = 'Connect Gmail to send meeting invitations from your address.';
      }
    }
    _updateModalGmailIndicator();
  } catch (err) {
    console.warn('[Meetings] Failed to check Gmail status:', err.message);
  }
}

function _updateModalGmailIndicator() {
  const indicator = document.getElementById('meeting-gmail-indicator');
  if (!indicator) return;

  if (_gmailStatus.connected) {
    indicator.innerHTML = `<span style="color:#15803D;">✉️ Invitations will be sent directly from your connected Gmail (<strong>${_gmailStatus.email || 'your address'}</strong>).</span>`;
  } else {
    indicator.innerHTML = `<span>ℹ️ Invitations will be delivered via in-app & push notifications. <a href="#" id="modal-connect-gmail-link" style="color:var(--primary); font-weight:600; text-decoration:underline;">Connect Gmail</a> to send emails from your address.</span>`;
    document.getElementById('modal-connect-gmail-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      _handleConnectGmail();
    });
  }
}

function _wireGmailConnectBtn() {
  const btn = document.getElementById('gmail-connect-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      if (_gmailStatus.connected) {
        const confirmDisconnect = confirm(`Disconnect your Gmail account (${_gmailStatus.email || 'connected'})?\n\nUniSync will no longer send meeting emails on your behalf.`);
        if (!confirmDisconnect) return;

        btn.disabled = true;
        try {
          const token = await auth.currentUser?.getIdToken();
          const res = await fetch('/api/auth/gmail/disconnect', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (res.ok) {
            _showToast?.('Gmail account disconnected.', 'info');
            await refreshGmailStatus();
          } else {
            throw new Error('Failed to disconnect');
          }
        } catch (err) {
          _showToast?.('Error disconnecting Gmail: ' + err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      } else {
        await _handleConnectGmail();
      }
    });
  }
}

async function _handleConnectGmail() {
  const btn = document.getElementById('gmail-connect-btn');
  const btnText = document.getElementById('gmail-connect-btn-text');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Connecting…';

  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('You must be signed in.');

    const res = await fetch('/api/auth/gmail/url', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (!res.ok || !data.url) {
      throw new Error(data.message || data.error || 'Failed to initiate Google authorization.');
    }

    // Redirect user to Google OAuth consent screen
    window.location.href = data.url;
  } catch (err) {
    console.error('[Connect Gmail Error]:', err);
    _showToast?.(err.message, 'error');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Connect Gmail';
  }
}

/**
 * Called once from app.js after login.
 * @param {Object} deps — { getAllGroupStudents, getActiveGroupId, getActiveGroupMeta, showToast }
 */
export function initMeetingsModule(deps) {
  _getGroupStudentsFn = deps.getAllGroupStudents;
  _getActiveGroupId   = deps.getActiveGroupId;
  _getActiveGroupMeta = deps.getActiveGroupMeta;
  _showToast          = deps.showToast;

  _checkGmailOAuthParams();
  _wireGmailConnectBtn();
  _wireMeetingCreationModal();
  _wireTabButtons();
  _wireScheduleMeetingBtn();
}

/**
 * Called when user navigates to meetings-view. Subscribes to live data.
 */
export function enterMeetingsView() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  if (_unsubMeetings) _unsubMeetings();
  _unsubMeetings = listenToUserMeetings(uid, meetings => {
    _allMeetings = meetings;
    _renderActiveTab();
  });

  _renderActiveTab();
  refreshGmailStatus();
}

/**
 * Called on logout — cleans up listeners.
 */
export function cleanupMeetingsModule() {
  if (_unsubMeetings) { _unsubMeetings(); _unsubMeetings = null; }
  _allMeetings = [];
}

/* ── Tab Wiring ── */

function _wireTabButtons() {
  document.querySelectorAll('.meeting-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.meeting-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeTab = btn.dataset.tab;

      // Switch tab panels
      document.querySelectorAll('.meetings-tab-panel').forEach(p => p.classList.remove('active'));
      const panelId = `meetings-${_activeTab === 'invitations' ? 'invitations' : _activeTab}-panel`;
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.add('active');

      _renderActiveTab();
    });
  });
}

function _renderActiveTab() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const now = new Date();

  const upcoming  = _allMeetings.filter(m => m.status !== 'cancelled' && _isFutureMeeting(m, now) && m.responses?.[uid] !== 'pending' && m.organizerUid !== uid);
  const pending   = _allMeetings.filter(m => m.responses?.[uid] === 'pending' && m.organizerUid !== uid && m.status !== 'cancelled');
  const created   = _allMeetings.filter(m => m.organizerUid === uid);
  const past      = _allMeetings.filter(m => !_isFutureMeeting(m, now) || m.status === 'cancelled');

  // Update badge on invitations tab
  const invBadge = document.getElementById('meeting-invitations-badge');
  if (invBadge) {
    invBadge.textContent = pending.length;
    invBadge.classList.toggle('hidden', pending.length === 0);
  }

  // Show correct panel
  document.querySelectorAll('.meetings-tab-panel').forEach(p => p.classList.remove('active'));
  const panelMap = { upcoming: 'meetings-upcoming-panel', invitations: 'meetings-invitations-panel', created: 'meetings-created-panel', past: 'meetings-past-panel' };
  const activePanel = document.getElementById(panelMap[_activeTab]);
  if (activePanel) activePanel.classList.add('active');

  switch (_activeTab) {
    case 'upcoming':    _renderMeetingList('meetings-upcoming-list',  upcoming,  'upcoming', uid);  break;
    case 'invitations': _renderMeetingList('meetings-invitations-list', pending, 'invitation', uid); break;
    case 'created':     _renderMeetingList('meetings-created-list',   created,   'created', uid);   break;
    case 'past':        _renderMeetingList('meetings-past-list',      past,      'past', uid);       break;
  }
}

function _isFutureMeeting(meeting, now) {
  if (!meeting.date || !meeting.startTime) return true;
  const [y, mo, d] = meeting.date.split('-').map(Number);
  const [h, m] = meeting.startTime.split(':').map(Number);
  const meetingDate = new Date(y, mo - 1, d, h, m);
  return meetingDate > now;
}

/* ── Render Functions ── */

function _renderMeetingList(containerId, meetings, type, currentUid) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (meetings.length === 0) {
    container.innerHTML = `<div class="meetings-empty-state">
      <div class="meetings-empty-icon">${type === 'invitation' ? '📬' : type === 'created' ? '📅' : type === 'past' ? '🗓️' : '🗓️'}</div>
      <p class="meetings-empty-title">${_emptyTitle(type)}</p>
      <p class="meetings-empty-sub">${_emptySub(type)}</p>
    </div>`;
    return;
  }

  // Sort by date+time
  meetings.sort((a, b) => {
    const da = new Date(`${a.date}T${a.startTime || '00:00'}`);
    const db = new Date(`${b.date}T${b.startTime || '00:00'}`);
    return da - db;
  });

  container.innerHTML = meetings.map(m => _buildMeetingCard(m, type, currentUid)).join('');

  // Wire action buttons
  container.querySelectorAll('[data-accept-meeting]').forEach(btn => {
    btn.addEventListener('click', () => _handleRespond(btn.dataset.acceptMeeting, 'accepted'));
  });
  container.querySelectorAll('[data-reject-meeting]').forEach(btn => {
    btn.addEventListener('click', () => _handleRespond(btn.dataset.rejectMeeting, 'rejected'));
  });
  container.querySelectorAll('[data-cancel-meeting]').forEach(btn => {
    btn.addEventListener('click', () => _handleCancel(btn.dataset.cancelMeeting));
  });
}

function _emptyTitle(type) {
  const map = { upcoming: 'No upcoming meetings', invitation: 'No pending invitations', created: "You haven't created any meetings", past: 'No past meetings' };
  return map[type] || 'Nothing here yet';
}
function _emptySub(type) {
  const map = { upcoming: 'Accept invitations to see them here.', invitation: 'You\'re all caught up! 🎉', created: 'Click "Schedule Meeting" to create one.', past: 'Completed meetings will appear here.' };
  return map[type] || '';
}

function _buildMeetingCard(m, type, currentUid) {
  const statusClass = { pending: 'status-pending', confirmed: 'status-confirmed', cancelled: 'status-cancelled', completed: 'status-completed' }[m.status] || 'status-pending';
  const statusLabel = { pending: 'Awaiting responses', confirmed: '✅ Confirmed', cancelled: '❌ Cancelled', completed: 'Completed' }[m.status] || m.status;

  const dateStr = m.date ? new Date(m.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const timeStr = m.startTime ? `${formatTime12(m.startTime)} – ${formatTime12(m.endTime)}` : '—';

  const participants = m.participants || [];
  const responses    = m.responses   || {};
  const accepted     = participants.filter(p => responses[p] === 'accepted').length;
  const total        = participants.length;

  const participantNames = m.participantNames || {};
  const nameList = participants.map(p => participantNames[p] || 'Member').join(', ');

  const locationHtml = m.location ? `<span class="meeting-card-loc">📍 ${m.location}</span>` : '';
  const descHtml     = m.description ? `<p class="meeting-card-desc">${m.description}</p>` : '';

  let actionsHtml = '';
  if (type === 'invitation') {
    actionsHtml = `<div class="meeting-card-actions">
      <button class="btn-accept" data-accept-meeting="${m.id}">✅ Accept</button>
      <button class="btn-reject" data-reject-meeting="${m.id}">❌ Decline</button>
    </div>`;
  } else if (type === 'created' && m.status !== 'cancelled') {
    // Show participant response breakdown
    const responseRows = participants.map(p => {
      const name = participantNames[p] || p.substring(0, 8);
      const resp = responses[p] || 'pending';
      const icon = resp === 'accepted' ? '✅' : resp === 'rejected' ? '❌' : '⏳';
      return `<span class="participant-response-pill ${resp}">${icon} ${name}</span>`;
    }).join('');
    actionsHtml = `
      <div class="participant-response-wrap">${responseRows}</div>
      <div class="meeting-card-actions">
        <button class="btn-cancel-meeting" data-cancel-meeting="${m.id}">🗑 Cancel Meeting</button>
      </div>`;
  }

  return `<div class="meeting-card ${statusClass}">
    <div class="meeting-card-header">
      <div>
        <h3 class="meeting-card-title">${m.title}</h3>
        <div class="meeting-card-meta">
          <span>📅 ${dateStr}</span>
          <span>🕐 ${timeStr}</span>
          ${locationHtml}
        </div>
      </div>
      <span class="meeting-status-badge ${statusClass}">${statusLabel}</span>
    </div>
    ${descHtml}
    <div class="meeting-card-footer">
      <span class="meeting-organizer">👤 ${m.organizerName || 'Organizer'}${type !== 'created' ? '' : ' (You)'}</span>
      <span class="meeting-participants">👥 ${accepted}/${total} accepted</span>
      ${m.groupName ? `<span class="meeting-group">🏫 ${m.groupName}</span>` : ''}
    </div>
    <div class="meeting-participants-names">${nameList}</div>
    ${actionsHtml}
  </div>`;
}

/* ── Meeting API Helper ── */

async function _callMeetingApi(endpoint, body) {
  try {
    const user = auth.currentUser;
    if (!user) return;
    const token = await user.getIdToken();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn(`[Meeting API] ${endpoint} returned ${res.status}:`, data);
    }
  } catch (err) {
    console.warn(`[Meeting API] Failed to call ${endpoint}:`, err.message);
  }
}

/* ── Meeting Response Handler ── */

async function _handleRespond(meetingId, response) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    const { allAccepted, newStatus } = await respondToMeeting(meetingId, uid, response);
    _showToast?.(response === 'accepted' ? '✅ Meeting accepted!' : '❌ Meeting declined.', response === 'accepted' ? 'success' : 'info');

    // Notify organizer
    const meeting = _allMeetings.find(m => m.id === meetingId);
    if (meeting) {
      const myName = auth.currentUser?.displayName || 'Someone';
      const notifType = response === 'accepted' ? 'meeting_accepted' : 'meeting_rejected';
      const title = response === 'accepted' ? `${myName} accepted "${meeting.title}"` : `${myName} declined "${meeting.title}"`;
      await createNotification(meeting.organizerUid, uid, notifType, title, `Response for meeting on ${meeting.date}`, meetingId);

      if (allAccepted) {
        // Notify all participants meeting is confirmed
        await notifyMeetingParticipants(meetingId, meeting, 'meeting_confirmed',
          `"${meeting.title}" is confirmed!`,
          `All participants accepted. See you on ${meeting.date} at ${formatTime12(meeting.startTime)}.`
        );
      }
    }

    // Trigger server-side notifications (FCM push + Resend email notifications)
    _callMeetingApi('/api/meetings/respond', { meetingId, response });
  } catch (err) {
    console.error('respondToMeeting failed:', err);
    _showToast?.('Failed to respond: ' + err.message, 'error');
  }
}

/* ── Cancel Meeting ── */

async function _handleCancel(meetingId) {
  if (!confirm('Are you sure you want to cancel this meeting? All participants will be notified.')) return;
  const uid = auth.currentUser?.uid;
  try {
    await cancelMeeting(meetingId, uid);
    const meeting = _allMeetings.find(m => m.id === meetingId);
    if (meeting) {
      await notifyMeetingParticipants(meetingId, meeting, 'meeting_cancelled',
        `"${meeting.title}" has been cancelled`,
        `The meeting scheduled on ${meeting.date} was cancelled by the organizer.`
      );
    }

    // Trigger server-side notifications (FCM push + Resend email notifications)
    _callMeetingApi('/api/meetings/cancel', { meetingId });

    _showToast?.('Meeting cancelled.', 'info');
  } catch (err) {
    _showToast?.('Failed to cancel: ' + err.message, 'error');
  }
}

/* ── Meeting Creation Modal ── */

function _wireScheduleMeetingBtn() {
  const btn = document.getElementById('schedule-meeting-btn');
  if (btn) btn.addEventListener('click', openMeetingCreationModal);
}

export function openMeetingCreationModal() {
  const modal = document.getElementById('meeting-creation-modal');
  if (!modal) return;
  _resetMeetingModal();
  _updateModalGmailIndicator();
  modal.classList.remove('hidden');
  modal.classList.add('open');
  _goToStep(1);
}

function _closeMeetingModal() {
  const modal = document.getElementById('meeting-creation-modal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('open'); }
}

function _resetMeetingModal() {
  const byId = id => document.getElementById(id);
  if (byId('meeting-title-input'))    byId('meeting-title-input').value = '';
  if (byId('meeting-desc-input'))     byId('meeting-desc-input').value = '';
  if (byId('meeting-duration-select')) byId('meeting-duration-select').value = '60';
  if (byId('meeting-location-input')) byId('meeting-location-input').value = '';
  if (byId('meeting-notes-input'))    byId('meeting-notes-input').value = '';
  if (byId('meeting-type-select'))    byId('meeting-type-select').value = 'group';
  if (byId('meeting-slots-list'))     byId('meeting-slots-list').innerHTML = '';
  if (byId('meeting-slots-day-select')) byId('meeting-slots-day-select').value = 'Monday';
  _selectedSlot = null;
  _selectedParticipantUids = [];
  _renderParticipantSelector();
}

let _selectedSlot = null;
let _selectedParticipantUids = [];

function _wireMeetingCreationModal() {
  // Close button
  document.getElementById('meeting-modal-close')?.addEventListener('click', _closeMeetingModal);
  document.getElementById('meeting-creation-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('meeting-creation-modal')) _closeMeetingModal();
  });

  // Step 1 → Find Slots
  document.getElementById('meeting-find-slots-btn')?.addEventListener('click', _handleFindSlots);

  // Step 2 → Back
  document.getElementById('meeting-back-btn')?.addEventListener('click', () => _goToStep(1));

  // Step 2 → Confirm
  document.getElementById('meeting-confirm-btn')?.addEventListener('click', _handleCreateMeeting);

  // Meeting type change → update participant selector
  document.getElementById('meeting-type-select')?.addEventListener('change', _renderParticipantSelector);

  // Wire day select to refetch slots
  document.getElementById('meeting-slots-day-select')?.addEventListener('change', () => {
    if (_selectedParticipantUids.length > 0) _handleFindSlots();
  });
}

function _goToStep(step) {
  document.querySelectorAll('.meeting-modal-step').forEach((el, i) => {
    el.classList.toggle('active', i + 1 === step);
  });
  if (step === 2) {
    _updateModalGmailIndicator();
  }
}

async function _renderParticipantSelector() {
  const type = document.getElementById('meeting-type-select')?.value;
  const container = document.getElementById('meeting-participant-selector');
  if (!container) return;

  const groupId = _getActiveGroupId?.();
  if (!groupId) {
    container.innerHTML = '<p class="helper-text">Join a squad first to schedule meetings.</p>';
    return;
  }

  if (type === 'group') {
    // Load all group members
    try {
      container.innerHTML = '<p class="helper-text loading-dots">Loading squad members…</p>';
      const students = await _getGroupStudentsFn?.(groupId) || [];
      const uid = auth.currentUser?.uid;
      const others = students.filter(s => s.id !== uid);

      if (others.length === 0) {
        container.innerHTML = '<p class="helper-text">No other members in this squad yet.</p>';
        return;
      }

      container.innerHTML = `<div class="participant-checkboxes">
        ${others.map(s => `
          <label class="participant-checkbox-label">
            <input type="checkbox" class="participant-checkbox" value="${s.id}" data-name="${s.name || 'Member'}">
            <span class="participant-avatar-sm">${(s.name || 'M')[0].toUpperCase()}</span>
            ${s.name || 'Member'}
          </label>
        `).join('')}
      </div>`;

      container.querySelectorAll('.participant-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
          _selectedParticipantUids = [...container.querySelectorAll('.participant-checkbox:checked')].map(c => c.value);
        });
      });
    } catch (err) {
      container.innerHTML = `<p class="helper-text error-text">Failed to load members: ${err.message}</p>`;
    }
  } else {
    container.innerHTML = '<p class="helper-text">Friend meetings coming soon. Use Group Meeting for now.</p>';
  }
}

async function _handleFindSlots() {
  const title    = document.getElementById('meeting-title-input')?.value.trim();
  const duration = parseInt(document.getElementById('meeting-duration-select')?.value || '60');
  const day      = document.getElementById('meeting-slots-day-select')?.value || 'Monday';
  const groupId  = _getActiveGroupId?.();

  if (!title) { _showToast?.('Please enter a meeting title.', 'warning'); return; }
  if (_selectedParticipantUids.length === 0) { _showToast?.('Select at least one participant.', 'warning'); return; }
  if (!groupId) { _showToast?.('No active squad.', 'warning'); return; }

  const findBtn = document.getElementById('meeting-find-slots-btn');
  if (findBtn) { findBtn.disabled = true; findBtn.textContent = 'Finding slots…'; }

  try {
    const allStudents = await _getGroupStudentsFn?.(groupId) || [];
    const uid = auth.currentUser?.uid;

    // Include organizer + selected participants
    const participantSet = new Set([uid, ..._selectedParticipantUids]);
    const selectedStudents = allStudents.filter(s => participantSet.has(s.id));

    const slots = findCommonFreeSlots(selectedStudents, day, { minDuration: duration });

    _renderAvailableSlots(slots, duration, day, selectedStudents);
    _goToStep(2);
  } catch (err) {
    console.error('findCommonFreeSlots failed:', err);
    _showToast?.('Failed to find slots: ' + err.message, 'error');
  } finally {
    if (findBtn) { findBtn.disabled = false; findBtn.textContent = '🔍 Find Available Slots'; }
  }
}

function _renderAvailableSlots(slots, duration, day, participants) {
  const container = document.getElementById('meeting-slots-list');
  const infoEl    = document.getElementById('meeting-slots-info');
  if (!container) return;

  if (infoEl) infoEl.textContent = `${participants.length} participant(s) · ${day} · ${duration} min meeting`;

  if (slots.length === 0) {
    container.innerHTML = `<div class="slots-empty">
      <p>😔 No common free slots found for ${day}.</p>
      <p>Try a different day or shorter duration.</p>
    </div>`;
    _selectedSlot = null;
    return;
  }

  container.innerHTML = slots.map((s, i) => {
    const start12 = formatTime12(s.startTime);
    const end12   = formatTime12(minutesToTimeStr(s.startMins + duration));
    const avail12 = formatTime12(s.endTime);
    return `<div class="slot-card" data-index="${i}" data-start="${s.startTime}" data-end="${minutesToTimeStr(s.startMins + duration)}" data-day="${day}">
      <div class="slot-card-time">${start12} → ${end12}</div>
      <div class="slot-card-meta">Available until ${avail12} · Free for ${formatDuration(s.durationMins)}</div>
    </div>`;
  }).join('');

  // Wire slot selection
  container.querySelectorAll('.slot-card').forEach(card => {
    card.addEventListener('click', () => {
      container.querySelectorAll('.slot-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      _selectedSlot = {
        date: _getNextOccurrenceDate(card.dataset.day),
        startTime: card.dataset.start,
        endTime: card.dataset.end,
        day: card.dataset.day
      };
      document.getElementById('meeting-confirm-btn').disabled = false;
    });
  });
  _selectedSlot = null;
  document.getElementById('meeting-confirm-btn').disabled = true;
}

function minutesToTimeStr(mins) {
  const safeMins = Math.max(0, Math.min(1439, Math.round(mins)));
  const h = Math.floor(safeMins / 60);
  const m = safeMins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function _getNextOccurrenceDate(dayName) {
  const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const target = dayMap[dayName] ?? 1;
  const today  = new Date();
  const diff   = (target - today.getDay() + 7) % 7 || 7;
  const next   = new Date(today);
  next.setDate(today.getDate() + diff);
  return next.toISOString().split('T')[0];
}

async function _handleCreateMeeting() {
  if (!_selectedSlot) { _showToast?.('Please select a time slot.', 'warning'); return; }

  const title    = document.getElementById('meeting-title-input')?.value.trim();
  const desc     = document.getElementById('meeting-desc-input')?.value.trim();
  const duration = parseInt(document.getElementById('meeting-duration-select')?.value || '60');
  const location = document.getElementById('meeting-location-input')?.value.trim();
  const notes    = document.getElementById('meeting-notes-input')?.value.trim();
  const type     = document.getElementById('meeting-type-select')?.value || 'group';

  const uid      = auth.currentUser?.uid;
  const groupId  = _getActiveGroupId?.();
  const groupMeta= _getActiveGroupMeta?.();

  if (!title) { _showToast?.('Title is required.', 'warning'); return; }

  const confirmBtn = document.getElementById('meeting-confirm-btn');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Sending invites…'; }

  try {
    // Fetch participant names for the notification
    const allStudents = await _getGroupStudentsFn?.(groupId) || [];
    const participantUids = [uid, ..._selectedParticipantUids];
    const participantNames = {};
    allStudents.forEach(s => {
      if (participantUids.includes(s.id)) participantNames[s.id] = s.name;
    });
    participantNames[uid] = auth.currentUser?.displayName || 'Organizer';

    const meetingData = {
      title,
      description: desc,
      organizerName: auth.currentUser?.displayName || 'Organizer',
      groupId,
      groupName: groupMeta?.name || '',
      participants: participantUids,
      participantNames,
      date: _selectedSlot.date,
      startTime: _selectedSlot.startTime,
      endTime: _selectedSlot.endTime,
      durationMins: duration,
      location,
      notes,
      meetingType: type
    };

    const meetingId = await createMeeting(meetingData);

    // Create in-app notifications for each participant
    const others = _selectedParticipantUids;
    for (const pid of others) {
      await createNotification(
        pid, uid, 'meeting_invite',
        `Meeting invite: "${title}"`,
        `${auth.currentUser?.displayName || 'Someone'} invited you to a meeting on ${_selectedSlot.date} at ${formatTime12(_selectedSlot.startTime)}.`,
        meetingId
      );
    }

    // Trigger server-side notifications (FCM push + Resend email notifications)
    _callMeetingApi('/api/meetings/create', { meetingId, meetingData });

    _closeMeetingModal();
    _showToast?.(`✅ Meeting "${title}" created! Invites sent.`, 'success');
  } catch (err) {
    console.error('createMeeting failed:', err);
    _showToast?.('Failed to create meeting: ' + err.message, 'error');
  } finally {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '✅ Send Invitations'; }
  }
}
