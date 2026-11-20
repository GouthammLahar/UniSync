/**
 * meeting-voting.js — UniSync Meeting Voting UI Controller
 *
 * Integrates into the EXISTING meetings.js / meetings-view.
 * - Extends meeting creation modal (Step 1) with voting-options fields
 * - Renders voting panels inside each meeting card
 * - Handles all creator and participant actions
 *
 * Imported and initialised from meetings.js.
 */

import {
  createVotingMeeting,
  castVote,
  listenToVotes,
  closeVoting,
  confirmMeeting,
  cancelVotingMeeting,
  tallyVotes,
  isDeadlinePassed
} from './meeting-voting-db.js?v=10';
import { Timestamp } from 'firebase/firestore';
import { formatTime12, formatDuration } from './schedule-utils.js?v=10';
import { auth } from './db.js?v=10';

/* ── Active vote listeners (meetingId → unsubscribe fn) ── */
const _voteListeners = new Map();

/** Call on logout / view cleanup to detach all vote listeners. */
export function cleanupVoteListeners() {
  _voteListeners.forEach(unsub => unsub());
  _voteListeners.clear();
}

/* =========================================================
   CREATION MODAL EXTENSION
   Injects voting fields into the existing meeting creation modal.
========================================================= */

/**
 * Injects the voting options section and deadline picker into the
 * existing meeting creation modal STEP 1.
 * Called once from meetings.js initMeetingsModule().
 */
export function injectVotingCreationFields() {
  // Guard — only inject once
  if (document.getElementById('meeting-voting-fields')) return;

  // Find the notes/location area in step 1 as an anchor
  const modalStep1 = document.querySelector('.meeting-modal-step');
  if (!modalStep1) return;

  const votingSection = document.createElement('div');
  votingSection.id = 'meeting-voting-fields';
  votingSection.className = 'meeting-voting-section';
  votingSection.innerHTML = `
    <div class="voting-fields-header">
      <label class="meeting-voting-toggle-label">
        <input type="checkbox" id="meeting-use-voting" />
        <span>Propose multiple time options (voting)</span>
      </label>
    </div>

    <div id="meeting-voting-options-wrap" class="hidden">
      <div id="meeting-voting-options-list" class="voting-options-list"></div>
      <button type="button" id="meeting-add-option-btn" class="btn-secondary btn-sm voting-add-btn">
        + Add Time Option
      </button>

      <div class="form-group" style="margin-top:14px;">
        <label for="meeting-voting-deadline">Voting Deadline (optional)</label>
        <input type="datetime-local" id="meeting-voting-deadline" />
      </div>
    </div>
  `;

  // Append before the last action area
  const findSlotsBtn = modalStep1.querySelector('#meeting-find-slots-btn');
  if (findSlotsBtn) {
    findSlotsBtn.parentNode.insertBefore(votingSection, findSlotsBtn);
  } else {
    modalStep1.appendChild(votingSection);
  }

  // Wire toggle
  document.getElementById('meeting-use-voting')?.addEventListener('change', e => {
    const wrap = document.getElementById('meeting-voting-options-wrap');
    if (wrap) wrap.classList.toggle('hidden', !e.target.checked);
    if (e.target.checked) _ensureAtLeastOneVotingOption();
  });

  // Wire add option
  document.getElementById('meeting-add-option-btn')?.addEventListener('click', _addVotingOptionRow);
}

function _ensureAtLeastOneVotingOption() {
  const list = document.getElementById('meeting-voting-options-list');
  if (list && list.children.length === 0) _addVotingOptionRow();
}

function _addVotingOptionRow() {
  const list = document.getElementById('meeting-voting-options-list');
  if (!list) return;
  const idx  = list.children.length;

  const row = document.createElement('div');
  row.className = 'voting-option-row';
  row.dataset.idx = idx;
  row.innerHTML = `
    <span class="voting-option-num">${idx + 1}</span>
    <div class="voting-option-fields">
      <div class="voting-option-row-inner">
        <div class="form-group">
          <label>Date</label>
          <input type="date" class="voting-opt-date" placeholder="YYYY-MM-DD" />
        </div>
        <div class="form-group">
          <label>Start</label>
          <input type="time" class="voting-opt-start" value="09:00" />
        </div>
        <div class="form-group">
          <label>End</label>
          <input type="time" class="voting-opt-end" value="10:00" />
        </div>
      </div>
    </div>
    <button type="button" class="voting-opt-remove-btn" title="Remove option">✕</button>
  `;
  row.querySelector('.voting-opt-remove-btn').addEventListener('click', () => {
    row.remove();
    _renumberOptionRows();
  });
  list.appendChild(row);
}

function _renumberOptionRows() {
  document.querySelectorAll('.voting-option-row').forEach((row, i) => {
    const num = row.querySelector('.voting-option-num');
    if (num) num.textContent = i + 1;
  });
}

/** Reads voting options from the creation modal form. */
export function readVotingOptions() {
  const useVoting = document.getElementById('meeting-use-voting')?.checked;
  if (!useVoting) return { isVoting: false, options: [], deadline: null };

  const rows = document.querySelectorAll('.voting-option-row');
  const options = [];
  rows.forEach(row => {
    const date  = row.querySelector('.voting-opt-date')?.value  || null;
    const start = row.querySelector('.voting-opt-start')?.value || null;
    const end   = row.querySelector('.voting-opt-end')?.value   || null;
    if (date || start) {
      const label = `${date || '?'} ${start ? formatTime12(start) : ''} – ${end ? formatTime12(end) : ''}`.trim();
      options.push({ date, startTime: start, endTime: end, label });
    }
  });

  const deadlineInput = document.getElementById('meeting-voting-deadline')?.value;
  let deadline = null;
  if (deadlineInput && deadlineInput.trim()) {
    const d = new Date(deadlineInput);
    if (isNaN(d.getTime())) {
      throw new Error('Please enter a valid voting deadline date and time.');
    }
    if (d.getTime() <= Date.now()) {
      throw new Error('Voting deadline must be set in the future.');
    }
    deadline = Timestamp.fromDate(d);
  }

  return { isVoting: true, options, deadline };
}

/** Resets voting creation fields (called from _resetMeetingModal in meetings.js). */
export function resetVotingCreationFields() {
  const cb   = document.getElementById('meeting-use-voting');
  const wrap = document.getElementById('meeting-voting-options-wrap');
  const list = document.getElementById('meeting-voting-options-list');
  const dl   = document.getElementById('meeting-voting-deadline');
  if (cb)   cb.checked  = false;
  if (wrap) wrap.classList.add('hidden');
  if (list) list.innerHTML = '';
  if (dl)   dl.value = '';
}

/* =========================================================
   VOTING PANEL RENDERING
   Called when building a meeting card for voting meetings.
========================================================= */

/**
 * Builds and returns the HTML for the voting panel inside a meeting card.
 * Also attaches a real-time vote listener for this meeting.
 *
 * @param {Object} meeting — full meeting document
 * @param {string} currentUid
 * @param {Function} showToast — from meetings.js
 * @returns {string} HTML string placeholder (listener patches in real data)
 */
export function buildVotingPanel(meeting, currentUid, showToast) {
  if (!meeting.isVotingMeeting) return '';

  const isCreator   = meeting.organizerUid === currentUid;
  const isParticipant = (meeting.participants || []).includes(currentUid);
  const status      = meeting.status;
  const options     = meeting.votingOptions || [];
  const panelId     = `voting-panel-${meeting.id}`;

  // Start a live vote listener for this meeting (cleanup old one first)
  _attachVoteListener(meeting, currentUid, showToast);

  const deadlineDate = meeting.votingDeadline
    ? (typeof meeting.votingDeadline?.toDate === 'function'
        ? meeting.votingDeadline.toDate()
        : new Date(meeting.votingDeadline))
    : null;
  const validDeadline = deadlineDate && !isNaN(deadlineDate.getTime()) ? deadlineDate : null;
  const deadlineStr = validDeadline
    ? validDeadline.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  const deadlinePassed = meeting.votingDeadline ? isDeadlinePassed(meeting.votingDeadline) : false;

  let statusBadge = '';
  if (status === 'voting_open' && !deadlinePassed)  statusBadge = '<span class="voting-status-badge open">🗳️ Voting Open</span>';
  if (status === 'voting_open' && deadlinePassed)   statusBadge = '<span class="voting-status-badge expired">⏰ Deadline Passed</span>';
  if (status === 'voting_closed') statusBadge = '<span class="voting-status-badge closed">🔒 Voting Closed</span>';
  if (status === 'confirmed')     statusBadge = '<span class="voting-status-badge confirmed-badge">✅ Confirmed</span>';
  if (status === 'cancelled')     statusBadge = '<span class="voting-status-badge cancelled-badge">❌ Cancelled</span>';

  return `
    <div class="voting-panel" id="${panelId}">
      <div class="voting-panel-header">
        <span class="voting-panel-title">Time Options</span>
        ${statusBadge}
        ${deadlineStr ? `<span class="voting-deadline-str">Deadline: ${deadlineStr}</span>` : ''}
      </div>
      <div class="voting-options-container" id="voting-opts-${meeting.id}">
        <div class="voting-loading">Loading votes…</div>
      </div>
      ${isParticipant && !isCreator && status === 'voting_open' && !deadlinePassed
        ? `<p class="voting-hint">Select an option above to cast or change your vote.</p>` : ''}
      <div class="voting-creator-actions" id="voting-creator-${meeting.id}">
        ${_buildCreatorActions(meeting, isCreator, deadlinePassed)}
      </div>
    </div>`;
}

function _buildCreatorActions(meeting, isCreator, deadlinePassed) {
  if (!isCreator) return '';
  const status = meeting.status;

  if (status === 'confirmed') {
    return `<p class="voting-creator-info">Meeting confirmed ✅</p>`;
  }
  if (status === 'cancelled') {
    return `<p class="voting-creator-info">Meeting cancelled ❌</p>`;
  }

  let html = '';
  if (status === 'voting_open') {
    html += `<button class="btn-secondary btn-sm voting-close-btn" data-meeting-id="${meeting.id}">🔒 Close Voting</button>`;
  }
  if (status === 'voting_closed' || deadlinePassed) {
    html += `
      <div class="creator-confirm-wrap">
        <select class="creator-option-select" id="confirm-select-${meeting.id}">
          ${(meeting.votingOptions || []).map((opt, i) =>
            `<option value="${i}">${opt.label || opt.date + ' ' + (opt.startTime || '')}</option>`
          ).join('')}
        </select>
        <button class="btn-primary btn-sm voting-confirm-btn" data-meeting-id="${meeting.id}">✅ Confirm Time</button>
      </div>`;
  }
  if (status !== 'cancelled') {
    html += `<button class="btn-terracotta btn-sm voting-cancel-btn" data-meeting-id="${meeting.id}">🗑 Cancel Meeting</button>`;
  }
  return html;
}

/* =========================================================
   LIVE VOTE LISTENER & DOM PATCHING
========================================================= */

function _attachVoteListener(meeting, currentUid, showToast) {
  // Detach old listener for this meeting if present
  if (_voteListeners.has(meeting.id)) {
    _voteListeners.get(meeting.id)();
  }

  const unsub = listenToVotes(meeting.id, votes => {
    _patchVotingPanel(meeting, votes, currentUid, showToast);
  });
  _voteListeners.set(meeting.id, unsub);
}

function _patchVotingPanel(meeting, votes, currentUid, showToast) {
  const optsCont    = document.getElementById(`voting-opts-${meeting.id}`);
  const creatorCont = document.getElementById(`voting-creator-${meeting.id}`);
  if (!optsCont) return;

  const options     = meeting.votingOptions || [];
  const participants= meeting.participants  || [];
  const isCreator   = meeting.organizerUid === currentUid;
  const isParticipant = participants.includes(currentUid);
  const status      = meeting.status;
  const deadlinePassed = meeting.votingDeadline ? isDeadlinePassed(meeting.votingDeadline) : false;
  const canVote     = isParticipant && !isCreator && status === 'voting_open' && !deadlinePassed;

  const tally = tallyVotes(votes, options, participants);
  const myVote = votes.find(v => v.uid === currentUid);

  // --- Render options ---
  optsCont.innerHTML = options.map((opt, i) => {
    const count   = tally.counts[i];
    const pct     = tally.totalVotes > 0 ? Math.round((count / tally.totalVotes) * 100) : 0;
    const isWinner= tally.winners.some(w => w.index === i) && !tally.isZero;
    const myChoice= myVote?.optionIndex === i;
    const isConfirmed = meeting.finalOptionIndex === i && status === 'confirmed';

    const names = (tally.votersByOption[i] || [])
      .map(uid => (meeting.participantNames?.[uid] || uid.slice(0, 6)))
      .join(', ');

    const label = opt.label
      || `${opt.date || '?'} ${opt.startTime ? formatTime12(opt.startTime) : ''} – ${opt.endTime ? formatTime12(opt.endTime) : ''}`.trim();

    return `
      <div class="voting-option-card ${myChoice ? 'my-vote' : ''} ${isWinner ? 'leading-opt' : ''} ${isConfirmed ? 'confirmed-opt' : ''}"
           data-opt-index="${i}" data-meeting-id="${meeting.id}">
        <div class="voting-opt-top">
          <span class="voting-opt-label">${label}</span>
          <span class="voting-opt-count">${count} vote${count !== 1 ? 's' : ''}</span>
          ${isConfirmed ? '<span class="voting-confirmed-mark">✅ Final</span>' : ''}
          ${isWinner && !isConfirmed && !tally.isZero ? '<span class="voting-leader-mark">↑ Leading</span>' : ''}
          ${myChoice ? '<span class="voting-my-mark">Your vote</span>' : ''}
        </div>
        <div class="voting-progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemax="100">
          <div class="voting-progress-fill ${myChoice ? 'my-fill' : ''}" style="width:${pct}%;"></div>
        </div>
        ${names ? `<div class="voting-voter-names">${names}</div>` : ''}
        ${canVote ? `<button class="btn-secondary btn-sm voting-cast-btn ${myChoice ? 'active-vote-btn' : ''}" data-opt-index="${i}" data-meeting-id="${meeting.id}">${myChoice ? '✓ Voted' : 'Vote'}</button>` : ''}
      </div>`;
  }).join('');

  // Wire vote buttons
  optsCont.querySelectorAll('.voting-cast-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.optIndex);
      const mid = btn.dataset.meetingId;
      btn.disabled = true;
      try {
        await castVote(mid, idx);
        showToast?.('✅ Vote cast!', 'success');
      } catch (err) {
        showToast?.('Failed to vote: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });

  // --- Pending voters ---
  const pendingNames = tally.pendingUids
    .filter(uid => uid !== meeting.organizerUid)
    .map(uid => meeting.participantNames?.[uid] || uid.slice(0, 6))
    .join(', ');

  if (pendingNames) {
    const pending = document.createElement('p');
    pending.className = 'voting-pending-info';
    pending.textContent = `⏳ Awaiting: ${pendingNames}`;
    optsCont.appendChild(pending);
  }

  // --- Tie / zero info ---
  if (status === 'voting_closed' || (status === 'voting_open' && deadlinePassed)) {
    if (tally.isZero) {
      const info = document.createElement('p');
      info.className = 'voting-tally-info';
      info.textContent = '⚠️ No votes received. Organiser can still pick a time manually.';
      optsCont.appendChild(info);
    } else if (tally.isTie) {
      const info = document.createElement('p');
      info.className = 'voting-tally-info';
      info.textContent = `🤝 Tie! Organiser must pick the final time manually.`;
      optsCont.appendChild(info);
    }
  }

  // --- Wire creator controls ---
  if (creatorCont && isCreator) {
    creatorCont.innerHTML = _buildCreatorActions(meeting, true, deadlinePassed);

    creatorCont.querySelector('.voting-close-btn')?.addEventListener('click', async () => {
      if (!confirm('Close voting? Participants will no longer be able to vote.')) return;
      try {
        await closeVoting(meeting.id);
        showToast?.('Voting closed.', 'info');
      } catch (err) {
        showToast?.('Failed: ' + err.message, 'error');
      }
    });

    creatorCont.querySelector('.voting-confirm-btn')?.addEventListener('click', async () => {
      const sel  = document.getElementById(`confirm-select-${meeting.id}`);
      const idx  = parseInt(sel?.value ?? '0');
      if (!confirm('Confirm this as the final meeting time?')) return;
      try {
        await confirmMeeting(meeting.id, idx);
        showToast?.('✅ Meeting confirmed!', 'success');
      } catch (err) {
        showToast?.('Failed: ' + err.message, 'error');
      }
    });

    creatorCont.querySelector('.voting-cancel-btn')?.addEventListener('click', async () => {
      if (!confirm('Cancel this meeting? All participants will be notified.')) return;
      try {
        await cancelVotingMeeting(meeting.id);
        showToast?.('Meeting cancelled.', 'info');
      } catch (err) {
        showToast?.('Failed: ' + err.message, 'error');
      }
    });
  }
}
