/**
 * squad-chat.js — UniSync Squad Chat Module
 * Lightweight, text-only real-time chat for authenticated squad members.
 * Strictly scoped under groups/{groupId}/messages using Firestore real-time listeners.
 * Free-tier (Spark) optimized: max 50 latest messages, unsubscribed when inactive.
 */

import {
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp
} from 'firebase/firestore';
import { db, auth, getGroupProfile } from './db.js?v=10';

// Module State
let _activeGroupIdGetter = null;
let _activeGroupMetaGetter = null;
let _unsubscribeListener = null;
let _currentChatGroupId = null;
let _lastSentTime = 0;
const SEND_COOLDOWN_MS = 1500; // 1.5s client-side cooldown against spam/double-clicks
const MAX_MESSAGE_LENGTH = 500;

// DOM Elements
let chatContainerEl = null;
let messagesContainerEl = null;
let formEl = null;
let inputEl = null;
let sendBtnEl = null;
let charCounterEl = null;
let statusTabBtnEl = null;
let chatTabBtnEl = null;
let statusPaneEl = null;
let chatPaneEl = null;
let squadTitleEl = null;

/**
 * Initializes the Squad Chat module and binds event listeners.
 */
export function initSquadChat({ getActiveGroupId, getActiveGroupMeta }) {
  _activeGroupIdGetter = getActiveGroupId;
  _activeGroupMetaGetter = getActiveGroupMeta;

  chatContainerEl = document.getElementById('squad-chat-container');
  messagesContainerEl = document.getElementById('squad-chat-messages');
  formEl = document.getElementById('squad-chat-form');
  inputEl = document.getElementById('squad-chat-input');
  sendBtnEl = document.getElementById('squad-chat-send-btn');
  charCounterEl = document.getElementById('squad-chat-counter');

  statusTabBtnEl = document.getElementById('squad-subtab-status-btn');
  chatTabBtnEl = document.getElementById('squad-subtab-chat-btn');
  statusPaneEl = document.getElementById('squad-status-pane');
  chatPaneEl = document.getElementById('squad-chat-pane');
  squadTitleEl = document.getElementById('squad-chat-header-title');

  // Subtab switching between Status and Chat
  statusTabBtnEl?.addEventListener('click', () => switchSquadSubtab('status'));
  chatTabBtnEl?.addEventListener('click', () => switchSquadSubtab('chat'));

  // Message input events
  inputEl?.addEventListener('input', handleInputChange);
  inputEl?.addEventListener('keydown', handleInputKeyDown);
  formEl?.addEventListener('submit', handleFormSubmit);
}

/**
 * Handles text input changes and updates the 500-char counter.
 */
function handleInputChange() {
  if (!inputEl) return;
  const len = inputEl.value.length;
  if (charCounterEl) {
    charCounterEl.textContent = `${len}/${MAX_MESSAGE_LENGTH}`;
    if (len > MAX_MESSAGE_LENGTH) {
      charCounterEl.style.color = 'var(--terracotta)';
    } else {
      charCounterEl.style.color = 'var(--ink-muted)';
    }
  }

  const trimmed = inputEl.value.trim();
  const isValid = trimmed.length > 0 && len <= MAX_MESSAGE_LENGTH;
  const isCooldown = (Date.now() - _lastSentTime) < SEND_COOLDOWN_MS;

  if (sendBtnEl) {
    sendBtnEl.disabled = !isValid || isCooldown;
  }

  // Autosize input textarea height
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

/**
 * Support Enter to send and Shift+Enter for a new line.
 */
function handleInputKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (sendBtnEl && !sendBtnEl.disabled) {
      formEl?.dispatchEvent(new Event('submit'));
    }
  }
}

/**
 * Handles submitting a new squad chat message.
 */
async function handleFormSubmit(e) {
  e.preventDefault();
  if (!inputEl) return;

  const rawText = inputEl.value;
  const text = rawText.trim();

  if (!text) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    alert(`Message exceeds ${MAX_MESSAGE_LENGTH} characters.`);
    return;
  }

  const now = Date.now();
  if (now - _lastSentTime < SEND_COOLDOWN_MS) {
    return;
  }

  const groupId = typeof _activeGroupIdGetter === 'function' ? _activeGroupIdGetter() : null;
  if (!groupId) {
    alert('Please select a squad first.');
    return;
  }

  const user = auth.currentUser;
  if (!user) {
    alert('You must be signed in to send messages.');
    return;
  }

  // Set sending state
  _lastSentTime = now;
  inputEl.disabled = true;
  if (sendBtnEl) sendBtnEl.disabled = true;

  try {
    const senderName = user.displayName || 'Squad Member';
    await addDoc(collection(db, 'groups', groupId, 'messages'), {
      senderId: user.uid,
      senderName: senderName.trim().slice(0, 80),
      message: text,
      createdAt: serverTimestamp()
    });

    // Clear input on success
    inputEl.value = '';
    inputEl.style.height = 'auto';
    handleInputChange();
  } catch (err) {
    console.error('[Squad Chat Send Error]:', {
      code: err?.code,
      message: err?.message,
      groupId,
      userUid: user.uid
    });
    if (err?.code === 'permission-denied') {
      alert('Unable to send: Squad Chat security rules are not active in Firebase Console.');
    } else {
      alert('Failed to send message: ' + (err?.message || 'Permission denied'));
    }
  } finally {
    inputEl.disabled = false;
    inputEl.focus();
    handleInputChange();
  }
}

/**
 * Toggles between Squad Status and Squad Chat subtabs.
 * @param {'status' | 'chat'} tab
 */
export function switchSquadSubtab(tab) {
  if (tab === 'chat') {
    statusTabBtnEl?.classList.remove('active');
    chatTabBtnEl?.classList.add('active');
    statusPaneEl?.classList.add('hidden');
    chatPaneEl?.classList.remove('hidden');

    const groupId = typeof _activeGroupIdGetter === 'function' ? _activeGroupIdGetter() : null;
    openSquadChat(groupId);
  } else {
    chatTabBtnEl?.classList.remove('active');
    statusTabBtnEl?.classList.add('active');
    chatPaneEl?.classList.add('hidden');
    statusPaneEl?.classList.remove('hidden');

    // Clean up real-time listener when moving away from chat
    closeSquadChatListener();
  }
}

/**
 * Opens and listens to the chat for the given squad.
 */
export async function openSquadChat(groupId) {
  if (!groupId) {
    renderEmptyState('Please join or select a squad to access Squad Chat.');
    return;
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    renderErrorState('Please sign in to access squad conversations.');
    return;
  }

  // Update header title
  const meta = typeof _activeGroupMetaGetter === 'function' ? _activeGroupMetaGetter() : null;
  const squadName = meta?.name || 'Squad';
  if (squadTitleEl) {
    squadTitleEl.textContent = `${squadName} • Chat`;
  }

  // If already listening to this squad, do not recreate listener
  if (_unsubscribeListener && _currentChatGroupId === groupId) {
    scrollToBottom();
    return;
  }

  // Unsubscribe any previous listener
  closeSquadChatListener();
  _currentChatGroupId = groupId;

  renderLoadingState();

  // 1. Verify membership explicitly against squad members subcollection
  let isVerifiedMember = false;
  try {
    const profile = await getGroupProfile(groupId, currentUser.uid);
    isVerifiedMember = !!profile;
  } catch (err) {
    console.warn('[Squad Chat] Local membership check warning:', err?.message || err);
    // If getGroupProfile threw because of transient error, do not block prematurely
    isVerifiedMember = true;
  }

  if (!isVerifiedMember) {
    console.warn('[Squad Chat] User is not a registered member of squad:', { groupId, uid: currentUser.uid });
    renderErrorState('You are not registered as a member of this squad. Join using the squad invite code.');
    return;
  }

  // 2. Attach real-time Firestore listener
  try {
    const q = query(
      collection(db, 'groups', groupId, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(50)
    );

    _unsubscribeListener = onSnapshot(
      q,
      (snapshot) => {
        if (snapshot.empty) {
          renderEmptyState('No messages in this squad yet. Say hello to your squadmates! 👋');
          return;
        }

        const messages = [];
        snapshot.forEach((docSnap) => {
          messages.push({
            id: docSnap.id,
            ...docSnap.data({ serverTimestamps: 'estimate' })
          });
        });

        // Reverse so chronological order flows from top (older) to bottom (newest)
        messages.reverse();
        renderMessages(messages);
      },
      (error) => {
        console.error('[Squad Chat Listener Error]:', {
          code: error.code,
          message: error.message,
          groupId,
          userUid: currentUser.uid
        });

        if (error.code === 'permission-denied') {
          renderErrorState('Chat permissions not active: The Squad Chat security rules must be deployed in Firebase Console.');
        } else if (error.code === 'unavailable') {
          renderErrorState('Network connection lost. Reconnecting to squad chat…');
        } else if (error.code === 'not-found') {
          renderErrorState('This squad conversation could not be found.');
        } else if (error.code === 'failed-precondition') {
          renderErrorState('Database index initializing. Please retry in a few seconds.');
        } else {
          renderErrorState('Unable to load squad messages. Please check your connection and retry.');
        }
      }
    );
  } catch (err) {
    console.error('[Squad Chat Setup Error]:', err);
    renderErrorState('Failed to connect to squad conversation.');
  }
}

/**
 * Cleans up any active Firestore real-time listener to prevent memory leaks and wasted reads.
 */
export function closeSquadChatListener() {
  if (typeof _unsubscribeListener === 'function') {
    _unsubscribeListener();
    _unsubscribeListener = null;
  }
  _currentChatGroupId = null;
}

/**
 * Renders the message list into the DOM.
 */
function renderMessages(messages) {
  if (!messagesContainerEl) return;
  messagesContainerEl.innerHTML = '';

  const currentUid = auth.currentUser?.uid;

  messages.forEach((msg) => {
    const isMe = msg.senderId === currentUid;
    const msgDiv = document.createElement('div');
    msgDiv.className = `squad-chat-msg ${isMe ? 'squad-chat-msg-me' : 'squad-chat-msg-other'}`;

    const senderName = isMe ? 'You' : (msg.senderName || 'Member');
    const timeFormatted = formatTimestamp(msg.createdAt);

    msgDiv.innerHTML = `
      <div class="squad-chat-msg-meta">
        <span class="squad-chat-sender">${escapeHtml(senderName)}</span>
        <span class="squad-chat-time">${timeFormatted}</span>
      </div>
      <div class="squad-chat-bubble">
        <p class="squad-chat-text">${escapeHtml(msg.message || '')}</p>
      </div>
    `;

    messagesContainerEl.appendChild(msgDiv);
  });

  scrollToBottom();
}

/**
 * Helper to display loading indicator.
 */
function renderLoadingState() {
  if (!messagesContainerEl) return;
  messagesContainerEl.innerHTML = `
    <div class="squad-chat-placeholder">
      <div class="squad-chat-spinner"></div>
      <span>Loading conversation…</span>
    </div>
  `;
}

/**
 * Helper to display empty state.
 */
function renderEmptyState(text) {
  if (!messagesContainerEl) return;
  messagesContainerEl.innerHTML = `
    <div class="squad-chat-placeholder empty">
      <span class="squad-chat-empty-icon">💬</span>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

/**
 * Helper to display error state.
 */
function renderErrorState(text) {
  if (!messagesContainerEl) return;
  messagesContainerEl.innerHTML = `
    <div class="squad-chat-placeholder error">
      <span>⚠️ ${escapeHtml(text)}</span>
    </div>
  `;
}

/**
 * Automatically scrolls to the newest message.
 */
function scrollToBottom() {
  if (!messagesContainerEl) return;
  messagesContainerEl.scrollTop = messagesContainerEl.scrollHeight;
}

/**
 * Formats a Firestore Timestamp or Date object into human-readable time.
 */
function formatTimestamp(ts) {
  if (!ts) return 'Just now';
  let date;
  if (typeof ts.toDate === 'function') {
    date = ts.toDate();
  } else if (ts instanceof Date) {
    date = ts;
  } else if (typeof ts === 'number') {
    date = new Date(ts);
  } else {
    return 'Just now';
  }

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) {
    return timeStr;
  }

  const monthName = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${monthName}, ${timeStr}`;
}

/**
 * Escapes HTML characters to prevent XSS.
 */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
