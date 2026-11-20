/**
 * assistant.js — UniSync Smart Assistant Frontend Module
 * Handles conversational UI, API communication with /api/assistant/chat,
 * quota tracking, markdown rendering, and suggestion chips.
 */

import { auth } from './db.js?v=10';

let _activeGroupIdGetter = null;
let _conversationTurn = null; // { user: string, assistant: string }
let _isSending = false;

// DOM Elements
let drawerEl, overlayEl, fabEl, closeBtn, newChatBtn, messagesEl, formEl, inputEl, sendBtn, quotaEl, chipsContainerEl;

export function initAssistant({ getActiveGroupId }) {
  _activeGroupIdGetter = getActiveGroupId;

  drawerEl = document.getElementById('assistant-drawer');
  overlayEl = document.getElementById('assistant-overlay');
  fabEl = document.getElementById('assistant-fab');
  closeBtn = document.getElementById('assistant-close-btn');
  newChatBtn = document.getElementById('assistant-new-chat-btn');
  messagesEl = document.getElementById('assistant-messages');
  formEl = document.getElementById('assistant-form');
  inputEl = document.getElementById('assistant-input');
  sendBtn = document.getElementById('assistant-send-btn');
  quotaEl = document.getElementById('assistant-quota-indicator');
  chipsContainerEl = document.getElementById('assistant-chips-container');

  // Open/Close triggers
  fabEl?.addEventListener('click', () => openAssistantDrawer());
  closeBtn?.addEventListener('click', () => closeAssistantDrawer());
  overlayEl?.addEventListener('click', () => closeAssistantDrawer());

  // Navigation button
  document.getElementById('nav-assistant-btn')?.addEventListener('click', () => openAssistantDrawer());

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawerEl?.classList.contains('hidden')) {
      closeAssistantDrawer();
    }
  });

  // New Chat
  newChatBtn?.addEventListener('click', () => resetConversation());

  // Input autosize and validation
  inputEl?.addEventListener('input', () => {
    const val = inputEl.value.trim();
    if (sendBtn) sendBtn.disabled = val.length === 0 || _isSending;

    // Character counter
    const counter = document.getElementById('assistant-char-counter');
    if (counter) counter.textContent = `${inputEl.value.length}/500`;

    // Autosize height
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  // Keydown handler: Enter to send, Shift+Enter for newline
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled && !_isSending) {
        formEl?.dispatchEvent(new Event('submit'));
      }
    }
  });

  // Form submit
  formEl?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = inputEl.value.trim();
    if (!query || _isSending) return;
    await submitAssistantQuery(query);
  });

  // Suggestion chips delegation
  chipsContainerEl?.addEventListener('click', (e) => {
    const chip = e.target.closest('.assistant-chip');
    if (chip && chip.dataset.prompt && !_isSending) {
      submitAssistantQuery(chip.dataset.prompt);
    }
  });

  // Check quota on load
  refreshQuota();
}

export function openAssistantDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.remove('hidden');
  overlayEl?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (inputEl) {
    setTimeout(() => inputEl.focus(), 150);
  }
  refreshQuota();
}

export function closeAssistantDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.add('hidden');
  overlayEl?.classList.add('hidden');
  document.body.style.overflow = '';
}

export function toggleAssistantFab(show) {
  if (fabEl) {
    fabEl.classList.toggle('hidden', !show);
  }
}

async function refreshQuota() {
  if (!auth.currentUser || !quotaEl) return;
  try {
    const token = await auth.currentUser.getIdToken();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const res = await fetch(`/api/assistant/chat?timezone=${encodeURIComponent(tz)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      updateQuotaBadge(data.remaining, data.limit);
    }
  } catch (err) {
    console.warn('Failed to fetch assistant quota:', err);
  }
}

function updateQuotaBadge(remaining, limit) {
  if (!quotaEl) return;
  const rem = typeof remaining === 'number' ? remaining : 3;
  const max = typeof limit === 'number' ? limit : 3;
  quotaEl.textContent = `${rem}/${max} daily queries left`;
  if (rem === 0) {
    quotaEl.style.background = 'var(--terracotta-subtle)';
    quotaEl.style.color = 'var(--terracotta-dark)';
    quotaEl.style.borderColor = 'var(--terracotta)';
  } else {
    quotaEl.style.background = 'var(--forest-subtle)';
    quotaEl.style.color = 'var(--forest-dark)';
    quotaEl.style.borderColor = 'var(--forest)';
  }
}

function resetConversation() {
  _conversationTurn = null;
  // Keep only welcome card and chips
  const welcomeCard = document.getElementById('assistant-welcome-card');
  const chipsRow = document.getElementById('assistant-chips-container');
  if (messagesEl) {
    messagesEl.innerHTML = '';
    if (welcomeCard) messagesEl.appendChild(welcomeCard);
    if (chipsRow) messagesEl.appendChild(chipsRow);
  }
  if (inputEl) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    if (sendBtn) sendBtn.disabled = true;
  }
}

async function submitAssistantQuery(queryText) {
  if (!auth.currentUser) {
    appendMessageBubble('assistant', 'Please sign in to your UniSync account to use the campus assistant.');
    return;
  }

  _isSending = true;
  if (sendBtn) sendBtn.disabled = true;
  if (inputEl) inputEl.value = '';

  // Append user bubble
  appendMessageBubble('user', queryText);

  // Show loading indicator
  const loadingBubble = appendLoadingBubble();
  scrollToBottom();

  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  const groupId = typeof _activeGroupIdGetter === 'function' ? _activeGroupIdGetter() : null;

  try {
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        question: queryText,
        groupId,
        timezone: userTimezone,
        conversationContext: _conversationTurn
      })
    });

    loadingBubble.remove();

    if (!res.ok) {
      let errMsg = `Assistant service returned error (${res.status})`;
      if (res.status === 404) {
        errMsg = 'Assistant endpoint not found (404). Please ensure the latest changes are deployed.';
      } else {
        try {
          const errJson = await res.json();
          errMsg = errJson.error || errMsg;
        } catch (_) {}
      }
      appendMessageBubble('assistant', `⚠️ ${errMsg}`);
      return;
    }

    const data = await res.json();

    // Store recent turn for follow-up conversation context
    _conversationTurn = {
      user: queryText,
      assistant: data.answer?.slice(0, 150) || ''
    };

    // Update remaining quota badge
    if (typeof data.remainingUserQuota === 'number') {
      updateQuotaBadge(data.remainingUserQuota, data.dailyLimit);
    }

    // Append response bubble with markdown rendering & action chips
    appendMessageBubble('assistant', data.answer, data.suggestedPrompts, data.tier);

  } catch (err) {
    loadingBubble?.remove();
    console.error('Assistant network error:', err);
    appendMessageBubble('assistant', '⚠️ Unable to reach the assistant service. Please check your network connection.');
  } finally {
    _isSending = false;
    if (inputEl) inputEl.focus();
    scrollToBottom();
  }
}

function appendMessageBubble(sender, text, suggestedPrompts = [], tier = null) {
  if (!messagesEl) return null;

  const msgDiv = document.createElement('div');
  msgDiv.className = `assistant-msg ${sender === 'user' ? 'assistant-msg-user' : 'assistant-msg-bot'}`;

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let tierBadge = '';
  if (sender === 'assistant' && tier) {
    if (tier === 'ai') {
      tierBadge = '<span class="assistant-tier-badge ai" title="Intent classified via Gemini NLU">✨ AI Understood</span>';
    } else if (tier === 'fallback_quota') {
      tierBadge = '<span class="assistant-tier-badge quota" title="Daily AI limit reached; answered using deterministic rules">⚡ Deterministic Rule</span>';
    } else {
      tierBadge = '<span class="assistant-tier-badge deterministic" title="Processed via deterministic rules">⚡ Instant Logic</span>';
    }
  }

  const renderedContent = sender === 'user'
    ? escapeHtml(text).replace(/\n/g, '<br>')
    : renderMarkdownSafe(text);

  let chipsHtml = '';
  if (suggestedPrompts && suggestedPrompts.length > 0) {
    const chipsList = suggestedPrompts.map(p => `<button class="assistant-chip-inline" data-prompt="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('');
    chipsHtml = `<div class="assistant-inline-chips">${chipsList}</div>`;
  }

  msgDiv.innerHTML = `
    <div class="assistant-msg-bubble">
      <div class="assistant-msg-content">${renderedContent}</div>
      ${chipsHtml}
      <div class="assistant-msg-meta">
        ${tierBadge}
        <span class="assistant-msg-time">${timeStr}</span>
      </div>
    </div>
  `;

  // Attach click handler to any inline chips
  msgDiv.querySelectorAll('.assistant-chip-inline').forEach(chip => {
    chip.addEventListener('click', () => {
      const p = chip.dataset.prompt;
      if (p && !_isSending) submitAssistantQuery(p);
    });
  });

  messagesEl.appendChild(msgDiv);
  return msgDiv;
}

function appendLoadingBubble() {
  if (!messagesEl) return null;
  const loadDiv = document.createElement('div');
  loadDiv.className = 'assistant-msg assistant-msg-bot assistant-msg-loading';
  loadDiv.innerHTML = `
    <div class="assistant-msg-bubble">
      <div class="assistant-typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  messagesEl.appendChild(loadDiv);
  return loadDiv;
}

function scrollToBottom() {
  if (!messagesEl) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Basic safe Markdown renderer (XSS-safe).
 * Sanitizes all HTML first, then parses bold, italics, bullet points, headers, code, and links.
 */
function renderMarkdownSafe(md) {
  if (!md) return '';
  let s = escapeHtml(String(md));

  // Bold **text**
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic *text*
  s = s.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Inline code `code`
  s = s.replace(/`([^`]+)`/g, '<code class="assistant-code">$1</code>');

  // Markdown lists (- item or * item)
  const lines = s.split('\n');
  const outLines = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('• ') || trimmed.startsWith('- ') || /^\d+\.\s/.test(trimmed)) {
      if (!inList) {
        outLines.push('<ul class="assistant-list">');
        inList = true;
      }
      const itemText = trimmed.replace(/^(•|-|\d+\.)\s*/, '');
      outLines.push(`<li>${itemText}</li>`);
    } else {
      if (inList) {
        outLines.push('</ul>');
        inList = false;
      }
      if (trimmed.length === 0) {
        outLines.push('<div class="assistant-spacing"></div>');
      } else {
        outLines.push(`<p>${line}</p>`);
      }
    }
  }
  if (inList) outLines.push('</ul>');

  return outLines.join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
