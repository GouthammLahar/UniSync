import { inject, pageview } from '@vercel/analytics';
import { 
  auth, loginWithGoogle, logoutUser, onAuthChange,
  createGroup, joinGroup, leaveGroup, getUserGroups,
  regenerateGroupCode, deleteGroup, kickMember,
  getGroupProfile, updateGroupProfile, saveGroupSchedule, deleteGroupSchedule,
  getFriendSchedule, getAllGroupStudents, searchGroupFriends, getGroupSquadStatus, getGroupMemberCount,
  checkCodeAvailability
} from './db.js?v=10';
import { parseLpuExcel } from './timetable-parser.js?v=10';
import {
  normaliseTime,
  timeToMinutes,
  minutesToTime,
  formatTime12,
  formatDuration,
  findCommonFreeSlots,
  checkStudentBusy,
  DAY_ORDER
} from './schedule-utils.js?v=10';
import { initMeetingsModule, enterMeetingsView, cleanupMeetingsModule } from './meetings.js?v=10';
import { initNotificationBell, cleanupNotificationBell } from './notifications.js?v=10';
import { initAssistant, toggleAssistantFab, closeAssistantDrawer } from './assistant.js?v=11';
import { initSquadChat, switchSquadSubtab, openSquadChat, closeSquadChatListener } from './squad-chat.js?v=10';
import { registerServiceWorker } from './fcm.js?v=10';

// Initialize Vercel Web Analytics exactly once
inject();

document.addEventListener('DOMContentLoaded', () => {
  // Register Service Worker for PWA installability and background push
  registerServiceWorker();

  // --- APP NAVIGATION ELEMENTS ---
  const publicNavLinks    = document.getElementById('public-nav-links');
  const appNavLinks       = document.getElementById('app-nav-links');
  const mobileAppBar      = document.getElementById('mobile-app-bar');
  const userMenuWrap      = document.getElementById('nav-user-menu-wrap');
  const userMenuTrigger   = document.getElementById('user-menu-trigger');
  const userDropdown      = document.getElementById('user-dropdown-panel');
  const navUserAvatar     = document.getElementById('nav-user-avatar');
  const navUserName       = document.getElementById('nav-user-name');
  const userDropdownName  = document.getElementById('user-dropdown-name');
  const userDropdownEmail = document.getElementById('user-dropdown-email');
  const squadPillWrapper  = document.getElementById('squad-pill-wrapper');
  const navBtns           = document.querySelectorAll('.nav-link, .mobile-tab-btn, .dropdown-nav-btn');
  const views             = document.querySelectorAll('.view');
  const groupSwitcher     = document.getElementById('group-switcher-select');
  const brandLink         = document.getElementById('nav-brand-link');

  // Google Login triggers
  const heroGoogleBtn     = document.getElementById('hero-google-btn');
  const navLoginBtn       = document.getElementById('nav-login-btn');
  const finalCtaBtn       = document.getElementById('final-cta-btn');
  const onboardLogout     = document.getElementById('onboard-logout-btn');

  // --- GLOBAL STATE ---
  let activeGroupId       = null;
  let activeGroupMeta     = null;
  let currentUserProfile  = null;
  let allMyGroups         = [];
  let userIsAdmin         = false;
  let currentUserSchedule = null;
  let activeFriendData    = null; // For 1-on-1 compare
  let allStudentsCache    = null; // Group students cache

  // Clear any jump hash from URL on load so page doesn't scroll past the hero headline
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname);
    window.scrollTo(0, 0);
  }

  // Intercept anchor clicks on public links to scroll smoothly without polluting the URL hash
  document.querySelectorAll('#public-nav-links a[href^="#"], .hero-actions a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', (e) => {
      const hash = anchor.getAttribute('href');
      if (hash && hash !== '#') {
        const targetSection = document.querySelector(hash);
        if (targetSection) {
          e.preventDefault();
          targetSection.scrollIntoView({ behavior: 'smooth' });
          history.replaceState(null, '', window.location.pathname);
        }
      }
    });
  });

  // ── VIEW ROUTER ────────────────────────────────────────────────────────────
  // Initial active view in index.html is landing-view (already recorded on initial load by inject())
  let currentActiveViewId = 'landing-view';

  function switchView(targetId) {
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname);
    }
    navBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-target') === targetId));
    views.forEach(v => v.classList.toggle('active', v.id === targetId));

    // Track SPA pageview on route change (avoid duplicate events for the same view)
    if (targetId && targetId !== currentActiveViewId) {
      currentActiveViewId = targetId;
      const cleanRoute = '/' + targetId.replace(/-view$/, '');
      pageview({ route: cleanRoute, path: cleanRoute });
    }

    // Close user dropdown if open
    if (userDropdown) userDropdown.classList.add('hidden');
    if (userMenuWrap) userMenuWrap.classList.remove('open');

    // Force instant scroll to absolute top
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;

    // View-specific initializers
    if (targetId === 'dashboard-view')  renderDashboard();
    if (targetId === 'groups-view')     renderGroupsDashboard();
    if (targetId === 'right-now-view')  renderLiveTracker();
    if (targetId === 'meetings-view')   enterMeetingsView();
    if (targetId === 'find-view') {
      if (activeGroupId) executeFriendSearch(searchInput ? searchInput.value : '');
    }
    if (targetId === 'squad-view') {
      const chatPane = document.getElementById('squad-chat-pane');
      if (chatPane && !chatPane.classList.contains('hidden')) {
        openSquadChat(activeGroupId);
      }
    } else {
      // Unsubscribe from real-time squad chat when leaving squad-view to preserve free-tier quota
      closeSquadChatListener();
    }
  }
  window.switchView = switchView;

  navBtns.forEach(btn => {
    if (btn.id === 'logout-btn') return;
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      if (target) switchView(target);
    });
  });

  // User Profile Dropdown Toggle
  if (userMenuTrigger && userDropdown) {
    userMenuTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdown.classList.toggle('hidden');
      userMenuWrap.classList.toggle('open');
    });
  }
  document.addEventListener('click', (e) => {
    if (userMenuWrap && !userMenuWrap.contains(e.target)) {
      if (userDropdown) userDropdown.classList.add('hidden');
      userMenuWrap.classList.remove('open');
    }
  });

  if (brandLink) {
    brandLink.addEventListener('click', (e) => {
      if (auth.currentUser && activeGroupId) {
        e.preventDefault();
        switchView('dashboard-view');
      }
    });
  }

  // ── AUTHENTICATION HANDLERS ────────────────────────────────────────────────
  async function triggerGoogleLogin(btnElement) {
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.dataset.originalText = btnElement.innerText;
      btnElement.innerText = 'Signing in…';
    }
    try {
      await loginWithGoogle();
    } catch (e) {
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.innerText = btnElement.dataset.originalText || 'Sign In with Google';
      }
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        console.error('Login failed:', e);
        alert('Login failed: ' + e.message);
      }
    } finally {
      if (!auth.currentUser && btnElement) {
        btnElement.disabled = false;
        btnElement.innerText = btnElement.dataset.originalText || 'Sign In with Google';
      }
    }
  }

  [heroGoogleBtn, navLoginBtn, finalCtaBtn].forEach(btn => {
    if (btn) btn.addEventListener('click', () => triggerGoogleLogin(btn));
  });

  const doLogout = async () => { await logoutUser(); };
  document.querySelectorAll('#logout-btn, #onboard-logout-btn, .dropdown-logout').forEach(btn => {
    btn.addEventListener('click', doLogout);
  });

  // ── FAQ ACCORDION (Landing Page) ───────────────────────────────────────────
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      if (item) item.classList.toggle('open');
    });
  });

  // ── AUTH STATE ROUTER ──────────────────────────────────────────────────────
  onAuthChange(async (user) => {
    if (user) {
      publicNavLinks.classList.add('hidden');
      appNavLinks.classList.remove('hidden');
      if (mobileAppBar) mobileAppBar.classList.remove('hidden');
      if (userMenuWrap) userMenuWrap.classList.remove('hidden');

      // Show nav-right group (wraps bell + user menu)
      const navRightGroup = document.getElementById('nav-right-group');
      if (navRightGroup) navRightGroup.classList.remove('hidden');

      // Show notification bell
      const notifBellWrap = document.getElementById('notif-bell-wrap');
      if (notifBellWrap) notifBellWrap.classList.remove('hidden');

      if (auth.currentUser) {
        const u = auth.currentUser;
        if (userDropdownEmail) userDropdownEmail.innerText = u.email || '';
        const initial = (u.displayName || u.email || 'U')[0].toUpperCase();
        if (navUserAvatar) navUserAvatar.innerText = initial;
        if (navUserName) navUserName.innerText = (u.displayName ? u.displayName.split(' ')[0] : 'Student');
        if (userDropdownName) userDropdownName.innerText = u.displayName || 'Student';

        // Init notification bell
        initNotificationBell(u.uid, switchView);

        // Init assistant
        initAssistant({
          getActiveGroupId: () => activeGroupId
        });
        toggleAssistantFab(true);

        // Init meetings module with injected dependencies
        initMeetingsModule({
          getAllGroupStudents: (gid) => getAllGroupStudents(gid),
          getActiveGroupId:   () => activeGroupId,
          getActiveGroupMeta: () => activeGroupMeta,
          showToast:          (msg, type) => showToast(msg, type)
        });

        // Init squad chat module
        initSquadChat({
          getActiveGroupId:   () => activeGroupId,
          getActiveGroupMeta: () => activeGroupMeta
        });
      }

      try {
        await reloadAllUserGroups();
      } catch(e) {
        console.error('Error loading app after login:', e);
        alert('Error loading app: ' + e.message);
      }
    } else {
      publicNavLinks.classList.remove('hidden');
      appNavLinks.classList.add('hidden');
      if (mobileAppBar) mobileAppBar.classList.add('hidden');
      if (userMenuWrap) userMenuWrap.classList.add('hidden');
      if (squadPillWrapper) squadPillWrapper.classList.add('hidden');
      groupSwitcher.classList.add('hidden');

      // Hide nav-right group
      const navRightGroup2 = document.getElementById('nav-right-group');
      if (navRightGroup2) navRightGroup2.classList.add('hidden');

      // Hide notification bell and cleanup
      const notifBellWrap = document.getElementById('notif-bell-wrap');
      if (notifBellWrap) notifBellWrap.classList.add('hidden');
      cleanupNotificationBell();
      cleanupMeetingsModule();
      toggleAssistantFab(false);
      closeAssistantDrawer();
      closeSquadChatListener();

      switchView('landing-view');
      activeGroupId = null;
      activeGroupMeta = null;
      currentUserProfile = null;
      currentUserSchedule = null;
    }
  });

  async function reloadAllUserGroups(forceMessage = null) {
    if (!auth.currentUser) return;

    try {
      allMyGroups = await getUserGroups();
    } catch(e) {
      console.error('getUserGroups failed:', e);
      alert('Failed to load squads: ' + e.message);
      return;
    }

    if (allMyGroups.length === 0) {
      if (squadPillWrapper) squadPillWrapper.classList.add('hidden');
      groupSwitcher.classList.add('hidden');
      switchView('groups-view');
      renderGroupsDashboard();
      const panicEl = document.getElementById('onboard-panic-msg');
      if (forceMessage) {
        panicEl.innerText = forceMessage;
        panicEl.classList.remove('hidden');
      } else {
        panicEl.classList.add('hidden');
      }
      if (onboardLogout) onboardLogout.classList.remove('hidden');
      return;
    }

    if (onboardLogout) onboardLogout.classList.add('hidden');
    document.getElementById('onboard-panic-msg').classList.add('hidden');
    if (squadPillWrapper) squadPillWrapper.classList.remove('hidden');
    groupSwitcher.classList.remove('hidden');

    // Populate Group Switcher
    groupSwitcher.innerHTML = '';
    allMyGroups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.innerText = g.name;
      groupSwitcher.appendChild(opt);
    });

    if (!activeGroupId || !allMyGroups.find(g => g.id === activeGroupId)) {
      activeGroupId = allMyGroups[0].id;
    }
    groupSwitcher.value = activeGroupId;
    await applyGroupContext(activeGroupId);
  }

  groupSwitcher.addEventListener('change', async (e) => {
    await applyGroupContext(e.target.value);
  });

  async function applyGroupContext(groupId) {
    activeGroupId = groupId;
    activeGroupMeta = allMyGroups.find(g => g.id === groupId);
    userIsAdmin = activeGroupMeta && activeGroupMeta.adminUid === auth.currentUser.uid;

    try {
      currentUserProfile = await getGroupProfile(groupId);
    } catch(e) {
      console.warn('Squad seems to have been deleted!');
      await reloadAllUserGroups('This squad has been deleted by the admin.');
      return;
    }

    if (currentUserProfile && currentUserProfile.name) {
      const firstName = currentUserProfile.name.trim().split(' ')[0] || 'Student';
      if (navUserName) navUserName.innerText = firstName;
      if (navUserAvatar) navUserAvatar.innerText = firstName[0].toUpperCase();
      if (userDropdownName) userDropdownName.innerText = currentUserProfile.name;
    }

    allStudentsCache = null;

    if (!currentUserProfile || !currentUserProfile.name) {
      switchView('profile-view');
    } else {
      await evaluateTimetableStatus();
      switchView('dashboard-view');
    }
  }


  /* =========================================================
     1. DASHBOARD (PERSONAL STUDENT WORKSPACE)
  ========================================================= */
  const dashGreeting        = document.getElementById('dash-greeting');
  const dashDateStr         = document.getElementById('dash-date-str');
  const dashLiveStatusTitle = document.getElementById('dash-live-status-title');
  const dashLiveStatusSub   = document.getElementById('dash-live-status-sub');
  const dashPulseDot        = document.getElementById('dash-pulse-dot');
  const metricTodayClasses  = document.getElementById('metric-today-classes');
  const metricSquadCount    = document.getElementById('metric-squad-count');
  const metricFreeNow       = document.getElementById('metric-free-now');
  const metricInviteCode    = document.getElementById('metric-invite-code');
  const dashTodayList       = document.getElementById('dash-today-schedule-list');
  const dashSquadPresence   = document.getElementById('dash-squad-presence-list');

  // Quick Dashboard Navigation
  document.getElementById('dash-view-full-timetable')?.addEventListener('click', () => switchView('upload-view'));
  document.getElementById('dash-find-free-slots-btn')?.addEventListener('click', () => switchView('free-slots-view'));

  async function renderDashboard() {
    if (!auth.currentUser || !activeGroupId) return;

    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = dayNames[now.getDay()];
    const currentMins = now.getHours() * 60 + now.getMinutes();

    // Greeting
    const hour = now.getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : (hour < 17 ? 'Good afternoon' : 'Good evening');
    const studentName = (currentUserProfile && currentUserProfile.name) ? currentUserProfile.name.split(' ')[0] : 'Student';
    if (dashGreeting) dashGreeting.innerText = `${timeGreeting}, ${studentName}`;

    // Date & Squad
    const dateFormatted = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const squadName = activeGroupMeta ? activeGroupMeta.name : 'Campus Squad';
    if (dashDateStr) dashDateStr.innerText = `${dateFormatted} • ${squadName}`;

    // Squad Code Metric
    if (metricInviteCode && activeGroupMeta) {
      metricInviteCode.innerText = activeGroupMeta.code || '—';
    }

    // Load squad count
    try {
      const memberCount = await getGroupMemberCount(activeGroupId);
      if (metricSquadCount) metricSquadCount.innerText = memberCount;
    } catch(e) {}

    // Evaluate user's live presence
    if (currentUserSchedule) {
      const check = checkStudentBusy(currentUserSchedule, currentDay, currentMins);
      if (check.isBusy && check.class) {
        if (dashLiveStatusTitle) dashLiveStatusTitle.innerText = `In Class: ${check.class.subject || 'Class'}`;
        const room = check.class.room ? `📍 ${check.class.room} • ` : '';
        if (dashLiveStatusSub) dashLiveStatusSub.innerText = `${room}Until ${formatTime12(check.class.endTime)}`;
        if (dashPulseDot) dashPulseDot.style.background = 'var(--terracotta)';
      } else {
        if (dashLiveStatusTitle) dashLiveStatusTitle.innerText = 'Free right now! 😎';
        if (dashLiveStatusSub) dashLiveStatusSub.innerText = 'No classes active at this moment';
        if (dashPulseDot) dashPulseDot.style.background = 'var(--cyan)';
      }

      // Populate today's classes
      const todayClasses = (currentUserSchedule[currentDay])
        ? Object.entries(currentUserSchedule[currentDay]).filter(([, v]) => v.status === 'busy')
        : [];

      if (metricTodayClasses) metricTodayClasses.innerText = todayClasses.length;

      if (dashTodayList) {
        if (todayClasses.length === 0) {
          dashTodayList.innerHTML = `
            <div class="empty-state" style="padding:1.5rem; text-align:center; color:var(--ink-muted);">
              No classes scheduled for ${currentDay} — enjoy your free time! 🎉
            </div>
          `;
        } else {
          // Sort by start time
          todayClasses.sort(([a], [b]) => a.split(' - ')[0].localeCompare(b.split(' - ')[0]));
          dashTodayList.innerHTML = '';
          todayClasses.forEach(([slotKey, data]) => {
            const [startT, endT] = slotKey.split(' - ');
            const inClassNow = isInClass(startT, endT);
            const item = document.createElement('div');
            item.className = `slot-item${inClassNow ? ' active-slot' : ''}`;
            item.innerHTML = `
              <div class="slot-time-col">
                <span class="slot-start">${formatTime12(startT)}</span>
                <span>→</span>
                <span class="slot-end">${formatTime12(endT)}</span>
                ${inClassNow ? '<span class="now-badge">NOW</span>' : ''}
              </div>
              <div class="slot-details-col">
                <div class="slot-subject">${data.subject || 'Class'}</div>
                <div class="slot-meta">
                  <span class="type-badge type-${data.type || 'L'}">${data.typeLabel || 'Lecture'}</span>
                  ${data.room ? `<span>📍 ${data.room}</span>` : ''}
                  ${data.batch ? `<span>${data.batch}</span>` : ''}
                </div>
              </div>
            `;
            dashTodayList.appendChild(item);
          });
        }
      }
    } else {
      if (metricTodayClasses) metricTodayClasses.innerText = '0';
      if (dashTodayList) {
        dashTodayList.innerHTML = `
          <div style="padding:1.5rem; text-align:center;">
            <p style="color:var(--ink-muted); margin-bottom:12px;">You haven't uploaded your timetable for this squad yet.</p>
            <button class="btn-primary btn-sm" onclick="document.querySelector('[data-target=\\'upload-view\\']').click()">Import Timetable Now</button>
          </div>
        `;
      }
    }

    // Load squad presence
    try {
      const students = await loadGroupStudents();
      let freeCount = 0;
      if (dashSquadPresence) {
        dashSquadPresence.innerHTML = '';
        students.forEach(student => {
          const check = checkStudentBusy(student.schedule, currentDay, currentMins);
          const isFree = !check.isBusy;
          if (isFree) freeCount++;

          const card = document.createElement('div');
          card.className = 'friend-checkbox-card';
          card.style.cursor = 'default';
          card.innerHTML = `
            <span class="live-dot ${isFree ? 'free' : 'busy'}"></span>
            <div style="flex:1; overflow:hidden;">
              <strong style="font-size:0.86rem; display:block; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${student.name}</strong>
              <span style="font-size:0.75rem; color:var(--ink-muted);">${isFree ? 'Free now' : (check.class?.subject || 'In Class')}</span>
            </div>
          `;
          dashSquadPresence.appendChild(card);
        });
      }
      if (metricFreeNow) metricFreeNow.innerText = freeCount;
    } catch(e) {}
  }


  /* =========================================================
     2. MY TIMETABLE (UPLOAD, REVIEW, MATRIX & DAY CARDS)
  ========================================================= */
  const uploadFormArea        = document.getElementById('upload-form');
  const displayTimetableArea  = document.getElementById('timetable-display-area');
  const myCalendarGrid        = document.getElementById('my-calendar-grid');
  const weeklyMatrixGrid      = document.getElementById('weekly-matrix-grid');
  const weeklyMatrixContainer = document.getElementById('weekly-matrix-container');
  const dayCardsWrapper       = document.getElementById('day-cards-wrapper');
  const btnToggleMatrix       = document.getElementById('btn-toggle-matrix');
  const btnToggleCards        = document.getElementById('btn-toggle-cards');
  const btnToggleTable        = document.getElementById('btn-toggle-table');
  const tableEditorWrapper    = document.getElementById('table-editor-wrapper');
  const tableEditorTbody      = document.getElementById('table-editor-tbody');
  const tableEditorAddBtn     = document.getElementById('table-editor-add-row-btn');
  const tableEditorSaveBtn    = document.getElementById('table-editor-save-btn');
  const toggleImportPanelBtn  = document.getElementById('toggle-import-panel-btn');
  const timetableStatusText   = document.getElementById('status-text');

  // Matrix vs Cards vs Table Editor toggle
  if (btnToggleMatrix) {
    btnToggleMatrix.addEventListener('click', () => {
      btnToggleMatrix.classList.add('active');
      btnToggleCards?.classList.remove('active');
      btnToggleTable?.classList.remove('active');
      weeklyMatrixContainer.classList.remove('hidden');
      dayCardsWrapper.classList.add('hidden');
      tableEditorWrapper?.classList.add('hidden');
    });
  }
  if (btnToggleCards) {
    btnToggleCards.addEventListener('click', () => {
      btnToggleCards.classList.add('active');
      btnToggleMatrix?.classList.remove('active');
      btnToggleTable?.classList.remove('active');
      dayCardsWrapper.classList.remove('hidden');
      weeklyMatrixContainer.classList.add('hidden');
      tableEditorWrapper?.classList.add('hidden');
    });
  }
  if (btnToggleTable) {
    btnToggleTable.addEventListener('click', () => {
      btnToggleTable.classList.add('active');
      btnToggleMatrix?.classList.remove('active');
      btnToggleCards?.classList.remove('active');
      tableEditorWrapper?.classList.remove('hidden');
      weeklyMatrixContainer.classList.add('hidden');
      dayCardsWrapper.classList.add('hidden');
      renderTableEditor(currentUserSchedule);
    });
  }

  // Toggle import panel
  if (toggleImportPanelBtn) {
    toggleImportPanelBtn.addEventListener('click', () => {
      uploadFormArea.classList.toggle('hidden');
      if (!uploadFormArea.classList.contains('hidden')) {
        uploadFormArea.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }

  // Clear / Replace Warning Modal
  const updateModal = document.getElementById('update-warning-modal');
  document.getElementById('trigger-update-btn')?.addEventListener('click', () => {
    updateModal.classList.remove('hidden');
  });
  document.getElementById('cancel-update-btn')?.addEventListener('click', () => {
    updateModal.classList.add('hidden');
  });
  document.getElementById('confirm-update-btn')?.addEventListener('click', async () => {
    updateModal.classList.add('hidden');
    timetableStatusText.innerText = 'Clearing old timetable…';
    await deleteGroupSchedule(activeGroupId);
    currentUserSchedule = null;
    await evaluateTimetableStatus();
  });

  async function evaluateTimetableStatus() {
    const statusTag = document.getElementById('my-timetable-status');
    statusTag.innerText = 'Checking…';
    const scheduleDocument = await getFriendSchedule(activeGroupId, auth.currentUser.uid);

    if (scheduleDocument && scheduleDocument.schedule && Object.keys(scheduleDocument.schedule).length > 0) {
      currentUserSchedule = scheduleDocument.schedule;
      let dateStr = 'Active';
      if (scheduleDocument.updatedAt) {
        const d = new Date(scheduleDocument.updatedAt);
        dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      }
      statusTag.innerText = `✓ Saved on: ${dateStr}`;
      statusTag.className = 'upload-status-tag';

      uploadFormArea.classList.add('hidden');
      displayTimetableArea.classList.remove('hidden');

      renderWeeklyMatrix(weeklyMatrixGrid, currentUserSchedule);
      renderDayCards(myCalendarGrid, currentUserSchedule);
    } else {
      currentUserSchedule = null;
      statusTag.innerText = 'No timetable uploaded';
      statusTag.className = 'upload-status-tag empty';

      uploadFormArea.classList.remove('hidden');
      displayTimetableArea.classList.add('hidden');
      resetUploadUI();
    }
  }

  // ── TOAST NOTIFICATIONS (Doherty Threshold & Fast Feedback) ────────────────
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const pill = document.createElement('div');
    pill.className = `toast-pill ${type}`;
    pill.innerHTML = `<span>${type === 'danger' ? '⚠️' : '✓'}</span><span>${message}</span>`;
    container.appendChild(pill);
    setTimeout(() => {
      pill.style.opacity = '0';
      pill.style.transform = 'translateY(-10px)';
      pill.style.transition = 'all 0.3s ease';
      setTimeout(() => pill.remove(), 300);
    }, 2800);
  }

  // Render Weekly Matrix
  function renderWeeklyMatrix(gridDOM, scheduleMap, options = {}) {
    if (!gridDOM) return;
    gridDOM.innerHTML = '';
    const readOnly = !!options.readOnly;
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (scheduleMap && scheduleMap['Sunday'] && Object.keys(scheduleMap['Sunday']).length > 0) {
      days.push('Sunday');
    }

    if (days.length > 6) {
      gridDOM.style.gridTemplateColumns = `repeat(${days.length}, minmax(170px, 1fr))`;
    } else {
      gridDOM.style.gridTemplateColumns = '';
    }

    days.forEach(day => {
      const col = document.createElement('div');
      col.className = 'matrix-col';

      const colHeader = document.createElement('div');
      colHeader.className = 'matrix-col-header';
      colHeader.innerText = day;
      col.appendChild(colHeader);

      const list = document.createElement('div');
      list.className = 'matrix-classes-list';

      const daySlots = (scheduleMap && scheduleMap[day]) ? Object.entries(scheduleMap[day]).filter(([, v]) => v.status === 'busy') : [];

      if (daySlots.length === 0) {
        const emptyDay = document.createElement('div');
        emptyDay.className = 'matrix-empty-day';
        emptyDay.innerHTML = `
          <span class="matrix-empty-icon">☕</span>
          <span class="matrix-empty-title">No classes</span>
          <span class="matrix-empty-sub">Enjoy your day</span>
          ${!readOnly ? `<button type="button" class="matrix-empty-add-btn">+ Add Class</button>` : ''}
        `;
        if (!readOnly) {
          emptyDay.querySelector('.matrix-empty-add-btn')?.addEventListener('click', () => openClassModalForAdd(day));
        }
        list.appendChild(emptyDay);
      } else {
        daySlots.sort(([a], [b]) => a.split(' - ')[0].localeCompare(b.split(' - ')[0]));
        daySlots.forEach(([slotKey, data]) => {
          const [startT, endT] = slotKey.split(' - ');
          const card = document.createElement('div');
          card.className = 'matrix-card';
          if (!readOnly) {
            card.title = 'Click to edit or remove this class';
          } else {
            card.title = `${data.subject || 'Class'}: ${formatTime12(startT)} – ${formatTime12(endT)}`;
            card.style.cursor = 'default';
          }
          card.innerHTML = `
            <div class="matrix-time">${formatTime12(startT)} – ${formatTime12(endT)}</div>
            <div class="matrix-subj">${data.subject || 'Class'}</div>
            <div class="matrix-meta">
              <span class="type-badge type-${data.type || 'L'}">${data.typeLabel || 'Lecture'}</span>
              ${data.room ? `<span class="room-pill">📍 ${data.room}</span>` : ''}
              ${data.batch ? `<span class="batch-pill">${data.batch}</span>` : ''}
              ${data.isMakeup ? `<span class="makeup-badge" style="background:var(--terracotta-subtle); color:var(--terracotta); font-size:0.68rem; padding:2px 6px; border-radius:var(--r-pill); font-weight:700;">MAKEUP</span>` : ''}
            </div>
          `;
          if (!readOnly) {
            card.addEventListener('click', () => openClassModalForEdit(day, slotKey, data));
          }
          list.appendChild(card);
        });

        if (!readOnly) {
          // + Add Class button positioned cleanly under the last class
          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'matrix-add-btn';
          addBtn.innerHTML = `+ Add Class`;
          addBtn.title = `Add a class to ${day}`;
          addBtn.addEventListener('click', () => openClassModalForAdd(day));
          list.appendChild(addBtn);
        }
      }

      col.appendChild(list);
      gridDOM.appendChild(col);
    });
  }

  // Render Day Cards
  function renderDayCards(containerDOM, scheduleMap, options = {}) {
    if (!containerDOM) return;
    containerDOM.innerHTML = '';
    const readOnly = !!options.readOnly;
    if (!scheduleMap || Object.keys(scheduleMap).length === 0) {
      containerDOM.innerHTML = '<div class="empty-state" style="padding:2rem; text-align:center; color:var(--ink-muted);"><p>No classes found in this timetable.</p></div>';
      return;
    }

    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const days = dayOrder.filter(d => scheduleMap[d] && Object.keys(scheduleMap[d]).length > 0);

    if (days.length === 0) {
      containerDOM.innerHTML = '<div class="empty-state" style="padding:2rem; text-align:center; color:var(--ink-muted);"><p>No classes found in this timetable.</p></div>';
      return;
    }

    days.forEach(day => {
      const daySlots = scheduleMap[day];
      const sortedSlots = Object.entries(daySlots)
        .filter(([, v]) => v.status === 'busy')
        .sort(([a], [b]) => a.split(' - ')[0].localeCompare(b.split(' - ')[0]));

      if (sortedSlots.length === 0) return;

      const dayCard = document.createElement('div');
      dayCard.className = 'day-card';
      dayCard.innerHTML = `<div class="day-card-header"><span class="day-name">${day}</span><span class="class-count">${sortedSlots.length} class${sortedSlots.length > 1 ? 'es' : ''}</span></div>`;

      const slotList = document.createElement('div');
      slotList.className = 'slot-list';

      sortedSlots.forEach(([slotKey, data]) => {
        const [startT, endT] = slotKey.split(' - ');
        const inClassNow = isInClass(startT, endT);
        const typeLabel = data.typeLabel || (data.type === 'P' ? 'Practical' : (data.type === 'T' ? 'Tutorial' : 'Lecture'));

        const slotEl = document.createElement('div');
        slotEl.className = `slot-item${inClassNow ? ' active-slot' : ''}`;
        if (!readOnly) {
          slotEl.title = 'Click to edit or remove this class';
        } else {
          slotEl.style.cursor = 'default';
        }
        slotEl.innerHTML = `
          <div class="slot-time-col">
            <span class="slot-start">${formatTime12(startT)}</span>
            <span>→</span>
            <span class="slot-end">${formatTime12(endT)}</span>
            ${inClassNow ? '<span class="now-badge">NOW</span>' : ''}
          </div>
          <div class="slot-details-col">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
              <div class="slot-subject">${data.subject || 'Class'}</div>
              ${!readOnly ? `<span class="slot-edit-badge">✏️ Edit</span>` : ''}
            </div>
            <div class="slot-meta">
              <span class="type-badge type-${data.type}">${typeLabel}</span>
              ${data.room ? `<span>📍 ${data.room}</span>` : ''}
              ${data.batch ? `<span>${data.batch}</span>` : ''}
              ${data.isMakeup ? `<span class="makeup-badge" style="background:var(--terracotta-subtle); color:var(--terracotta); font-size:0.68rem; padding:2px 6px; border-radius:var(--r-pill); font-weight:700;">MAKEUP</span>` : ''}
            </div>
          </div>`;
        if (!readOnly) {
          slotEl.addEventListener('click', () => openClassModalForEdit(day, slotKey, data));
        }
        slotList.appendChild(slotEl);
      });

      dayCard.appendChild(slotList);

      if (!readOnly) {
        // + Add button at bottom of each day card
        const dayAddBtn = document.createElement('button');
        dayAddBtn.type = 'button';
        dayAddBtn.className = 'day-card-add-btn';
        dayAddBtn.innerHTML = `+ Add Class to ${day}`;
        dayAddBtn.addEventListener('click', () => openClassModalForAdd(day));
        dayCard.appendChild(dayAddBtn);
      }

      containerDOM.appendChild(dayCard);
    });
  }

  // Render Read-Only Table View
  function renderReadOnlyTable(tbodyDOM, scheduleMap) {
    if (!tbodyDOM) return;
    tbodyDOM.innerHTML = '';
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    let allRows = [];
    if (scheduleMap) {
      days.forEach(day => {
        if (scheduleMap[day]) {
          Object.entries(scheduleMap[day]).forEach(([slotKey, data]) => {
            if (data.status === 'busy') {
              const [startT, endT] = slotKey.split(' - ');
              allRows.push({
                day,
                startTime: data.startTime || startT,
                endTime: data.endTime || endT,
                subject: data.subject || 'Class',
                type: data.type || 'L',
                typeLabel: data.typeLabel || (data.type === 'P' ? 'Practical' : (data.type === 'T' ? 'Tutorial' : 'Lecture')),
                room: data.room || '',
                batch: data.batch || '',
                isMakeup: data.isMakeup || false
              });
            }
          });
        }
      });
    }

    if (allRows.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="7" style="text-align:center; padding:2rem; color:var(--ink-muted);">No classes found in this timetable.</td>`;
      tbodyDOM.appendChild(tr);
      return;
    }

    allRows.sort((a, b) => {
      const dDiff = days.indexOf(a.day) - days.indexOf(b.day);
      if (dDiff !== 0) return dDiff;
      return a.startTime.localeCompare(b.startTime);
    });

    allRows.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong style="color:var(--ink);">${row.day}</strong></td>
        <td><span style="font-family:var(--font-mono); font-size:0.82rem; font-weight:600;">${formatTime12(row.startTime)}</span></td>
        <td><span style="font-family:var(--font-mono); font-size:0.82rem; font-weight:600;">${formatTime12(row.endTime)}</span></td>
        <td>
          <strong style="color:var(--forest-dark);">${row.subject}</strong>
          ${row.isMakeup ? `<span class="makeup-badge" style="background:var(--terracotta-subtle); color:var(--terracotta); font-size:0.68rem; padding:2px 6px; border-radius:var(--r-pill); font-weight:700; margin-left:4px;">MAKEUP</span>` : ''}
        </td>
        <td><span class="type-badge type-${row.type}">${row.typeLabel}</span></td>
        <td>${row.room ? `<span class="room-pill">📍 ${row.room}</span>` : '<span style="color:var(--ink-muted);">—</span>'}</td>
        <td>${row.batch ? `<span class="batch-pill">${row.batch}</span>` : '<span style="color:var(--ink-muted);">—</span>'}</td>
      `;
      tbodyDOM.appendChild(tr);
    });
  }

  // ── FULL SCHEDULE TABLE EDITOR ─────────────────────────────────────────────
  const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  function canonicalDay(d) {
    if (!d) return null;
    const s = String(d).trim().toLowerCase();
    const match = VALID_DAYS.find(vd => vd.toLowerCase() === s);
    if (match) return match;
    const abbrev = {
      mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', weds: 'Wednesday',
      thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
    };
    return abbrev[s] || null;
  }

  function renderTableEditor(scheduleMap) {
    if (!tableEditorTbody) return;
    tableEditorTbody.innerHTML = '';
    const days = VALID_DAYS;

    let allRows = [];
    if (scheduleMap) {
      days.forEach(day => {
        if (scheduleMap[day]) {
          Object.entries(scheduleMap[day]).forEach(([slotKey, data]) => {
            if (data.status === 'busy') {
              const [startT, endT] = slotKey.split(' - ');
              const rawType = data.type || data.classType || 'L';
              const type = rawType.toUpperCase().startsWith('P') ? 'P' : (rawType.toUpperCase().startsWith('T') ? 'T' : 'L');
              allRows.push({
                day,
                startTime: normaliseTime(data.startTime || data.start || startT),
                endTime: normaliseTime(data.endTime || data.end || endT),
                subject: data.subject || data.courseCode || data.course || data.code || '',
                type,
                room: data.room || '',
                batch: data.batch || data.group || data.section || ''
              });
            }
          });
        }
      });
    }

    if (allRows.length === 0) {
      appendTableEditorRow({ day: 'Monday', startTime: '08:30', endTime: '09:20', subject: '', type: 'L', room: '', batch: '' });
    } else {
      allRows.sort((a, b) => {
        const dDiff = days.indexOf(a.day) - days.indexOf(b.day);
        if (dDiff !== 0) return dDiff;
        return a.startTime.localeCompare(b.startTime);
      });
      allRows.forEach(row => appendTableEditorRow(row));
    }
  }

  function appendTableEditorRow(data = {}) {
    const tr = document.createElement('tr');
    const startVal = normaliseTime(data.startTime || data.start) || '08:30';
    const endVal = normaliseTime(data.endTime || data.end) || '09:20';
    const subjVal = data.subject || data.courseCode || data.course || data.code || '';
    const rawType = data.type || data.classType || 'L';
    const typeVal = rawType.toUpperCase().startsWith('P') ? 'P' : (rawType.toUpperCase().startsWith('T') ? 'T' : 'L');
    const roomVal = data.room || '';
    const batchVal = data.batch || data.group || data.section || '';
    const dayVal = data.day || 'Monday';

    tr.innerHTML = `
      <td>
        <select class="table-row-day">
          <option value="Monday" ${dayVal === 'Monday' ? 'selected' : ''}>Monday</option>
          <option value="Tuesday" ${dayVal === 'Tuesday' ? 'selected' : ''}>Tuesday</option>
          <option value="Wednesday" ${dayVal === 'Wednesday' ? 'selected' : ''}>Wednesday</option>
          <option value="Thursday" ${dayVal === 'Thursday' ? 'selected' : ''}>Thursday</option>
          <option value="Friday" ${dayVal === 'Friday' ? 'selected' : ''}>Friday</option>
          <option value="Saturday" ${dayVal === 'Saturday' ? 'selected' : ''}>Saturday</option>
          <option value="Sunday" ${dayVal === 'Sunday' ? 'selected' : ''}>Sunday</option>
        </select>
      </td>
      <td><input type="time" class="table-row-start" value="${startVal}" required /></td>
      <td><input type="time" class="table-row-end" value="${endVal}" required /></td>
      <td><input type="text" class="table-row-subj" value="${subjVal}" placeholder="Course Code" required /></td>
      <td>
        <select class="table-row-type">
          <option value="L" ${typeVal === 'L' ? 'selected' : ''}>Lecture</option>
          <option value="T" ${typeVal === 'T' ? 'selected' : ''}>Tutorial</option>
          <option value="P" ${typeVal === 'P' ? 'selected' : ''}>Practical / Lab</option>
        </select>
      </td>
      <td><input type="text" class="table-row-room" value="${roomVal}" placeholder="e.g. 36-809" /></td>
      <td><input type="text" class="table-row-batch" value="${batchVal}" placeholder="e.g. 323MB" /></td>
      <td style="text-align:center;">
        <button type="button" class="btn-remove-row" title="Remove this class">✕</button>
      </td>
    `;
    tr.querySelector('.btn-remove-row').addEventListener('click', () => tr.remove());
    tableEditorTbody.appendChild(tr);
  }

  if (tableEditorAddBtn) {
    tableEditorAddBtn.addEventListener('click', () => {
      appendTableEditorRow({ day: 'Monday', startTime: '08:30', endTime: '09:20', subject: '', type: 'L', room: '', batch: '' });
    });
  }

  if (tableEditorSaveBtn) {
    tableEditorSaveBtn.addEventListener('click', async () => {
      if (!activeGroupId) {
        alert('Please select or join a campus squad first before saving your timetable.');
        return;
      }
      const rows = tableEditorTbody.querySelectorAll('tr');
      const newSchedule = {};
      let validClassCount = 0;
      let hasErrors = false;

      for (let i = 0; i < rows.length; i++) {
        const tr = rows[i];
        const rawDay = (tr.querySelector('.table-row-day')?.value || '').trim();
        const day   = canonicalDay(rawDay);
        const rawStart = (tr.querySelector('.table-row-start')?.value || '').trim();
        const rawEnd   = (tr.querySelector('.table-row-end')?.value || '').trim();
        const start = normaliseTime(rawStart);
        const end   = normaliseTime(rawEnd);
        const subj  = (tr.querySelector('.table-row-subj')?.value || '').trim();
        const rawType = tr.querySelector('.table-row-type')?.value || 'L';
        const type  = rawType.toUpperCase().startsWith('P') ? 'P' : (rawType.toUpperCase().startsWith('T') ? 'T' : 'L');
        const room  = (tr.querySelector('.table-row-room')?.value || '').trim();
        const batch = (tr.querySelector('.table-row-batch')?.value || '').trim();

        // Skip completely empty rows
        if (!subj && !room && !batch) continue;

        if (!day) {
          alert(`Row ${i + 1}: Invalid weekday "${rawDay}". Must be Monday through Sunday.`);
          hasErrors = true;
          break;
        }

        if (!subj) {
          alert(`Row ${i + 1} (${day}): Please enter a course code / subject name.`);
          hasErrors = true;
          break;
        }

        if (!start || !end) {
          alert(`Row ${i + 1} (${subj} on ${day}): Please provide valid start and end times.`);
          hasErrors = true;
          break;
        }

        if (timeToMinutes(end) <= timeToMinutes(start)) {
          alert(`Invalid time for ${subj} on ${day}: End Time (${end}) must be after Start Time (${start}).`);
          hasErrors = true;
          break;
        }

        if (!newSchedule[day]) newSchedule[day] = {};
        let slotKey = `${start} - ${end}`;
        if (newSchedule[day][slotKey]) {
          slotKey = `${start} - ${end}|${batch || validClassCount}`;
        }
        newSchedule[day][slotKey] = {
          status: 'busy',
          subject: subj,
          room,
          type,
          typeLabel: type === 'P' ? 'Practical' : (type === 'T' ? 'Tutorial' : 'Lecture'),
          batch,
          startTime: start,
          endTime: end
        };
        validClassCount++;
      }

      if (hasErrors) return;

      if (validClassCount === 0 || Object.keys(newSchedule).length === 0) {
        alert('Please add at least one valid class before saving.');
        return;
      }

      tableEditorSaveBtn.disabled = true;
      tableEditorSaveBtn.innerText = 'Saving…';

      try {
        await saveGroupSchedule(activeGroupId, newSchedule);
        currentUserSchedule = newSchedule;
        showToast('✓ Timetable changes saved successfully!');
        if (btnToggleMatrix) btnToggleMatrix.click();
        await evaluateTimetableStatus();
      } catch(e) {
        alert('Failed to save timetable: ' + e.message);
      } finally {
        tableEditorSaveBtn.disabled = false;
        tableEditorSaveBtn.innerText = '💾 Save All Changes';
      }
    });
  }


  /* =========================================================
     3. MANUAL CLASS BUILDER & EDIT MODAL
  ========================================================= */
  const manualClassModal    = document.getElementById('manual-class-modal');
  const openManualModalBtn  = document.getElementById('open-manual-class-modal-btn');
  const closeManualModalBtn = document.getElementById('close-manual-class-modal-btn');
  const cancelManualModalBtn= document.getElementById('cancel-manual-class-btn');
  const manualClassForm     = document.getElementById('manual-class-form');
  const deleteClassBtn      = document.getElementById('delete-class-btn');

  function _safeSet(id, prop, val) {
    const el = document.getElementById(id);
    if (el) el[prop] = val;
  }

  function openClassModalForAdd(preselectedDay = 'Monday') {
    if (manualClassForm) manualClassForm.reset();
    _safeSet('modal-edit-original-day', 'value', '');
    _safeSet('modal-edit-original-slot', 'value', '');
    _safeSet('modal-badge-tag', 'innerText', 'NEW CLASS ENTRY');
    _safeSet('manual-modal-title', 'innerText', 'Add Class to Schedule');
    _safeSet('save-class-modal-btn', 'innerText', 'Add to Schedule');
    if (deleteClassBtn) deleteClassBtn.classList.add('hidden');
    _safeSet('modal-class-day', 'value', preselectedDay);
    _safeSet('modal-class-start', 'value', '08:30');
    _safeSet('modal-class-end', 'value', '09:20');
    if (manualClassModal) manualClassModal.classList.remove('hidden');
  }

  function openClassModalForEdit(day, slotKey, data) {
    _safeSet('modal-edit-original-day', 'value', day);
    _safeSet('modal-edit-original-slot', 'value', slotKey);
    _safeSet('modal-badge-tag', 'innerText', 'EDIT CLASS DETAILS');
    _safeSet('manual-modal-title', 'innerText', 'Edit Class');
    _safeSet('save-class-modal-btn', 'innerText', 'Save Changes');
    if (deleteClassBtn) deleteClassBtn.classList.remove('hidden');

    _safeSet('modal-class-day', 'value', day);
    const [startT, endT] = slotKey.split(' - ');
    _safeSet('modal-class-start', 'value', normaliseTime(data.startTime || startT));
    _safeSet('modal-class-end', 'value', normaliseTime(data.endTime || endT));
    _safeSet('modal-class-subject', 'value', data.subject || '');
    _safeSet('modal-class-type', 'value', data.type || 'L');
    _safeSet('modal-class-room', 'value', data.room || '');
    _safeSet('modal-class-batch', 'value', data.batch || '');

    if (manualClassModal) manualClassModal.classList.remove('hidden');
  }

  if (openManualModalBtn) {
    openManualModalBtn.addEventListener('click', () => openClassModalForAdd('Monday'));
  }
  const closeManualModal = () => manualClassModal.classList.add('hidden');
  if (closeManualModalBtn) closeManualModalBtn.addEventListener('click', closeManualModal);
  if (cancelManualModalBtn) cancelManualModalBtn.addEventListener('click', closeManualModal);

  // Delete single class from modal
  if (deleteClassBtn) {
    deleteClassBtn.addEventListener('click', async () => {
      const origDay = document.getElementById('modal-edit-original-day').value;
      const origSlot = document.getElementById('modal-edit-original-slot').value;
      if (!origDay || !origSlot) return;

      if (!confirm(`Are you sure you want to delete this class on ${origDay} (${origSlot})?`)) return;

      const schedDoc = await getFriendSchedule(activeGroupId, auth.currentUser.uid);
      const schedule = (schedDoc && schedDoc.schedule) ? schedDoc.schedule : {};

      if (schedule[origDay] && schedule[origDay][origSlot]) {
        delete schedule[origDay][origSlot];
        if (Object.keys(schedule[origDay]).length === 0) {
          delete schedule[origDay];
        }
      }

      await saveGroupSchedule(activeGroupId, schedule);
      closeManualModal();
      showToast('✓ Class removed from timetable', 'danger');
      await evaluateTimetableStatus();
    });
  }

  // Add / Edit form submit handler
  if (manualClassForm) {
    manualClassForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!activeGroupId) {
        alert('Please select or join a campus squad first before adding a class.');
        return;
      }

      const origDay   = document.getElementById('modal-edit-original-day').value;
      const origSlot  = document.getElementById('modal-edit-original-slot').value;

      const day       = document.getElementById('modal-class-day').value;
      const startTime = normaliseTime(document.getElementById('modal-class-start').value);
      const endTime   = normaliseTime(document.getElementById('modal-class-end').value);
      const subject   = document.getElementById('modal-class-subject').value.trim();
      const rawType   = document.getElementById('modal-class-type').value;
      const type      = rawType.toUpperCase().startsWith('P') ? 'P' : (rawType.toUpperCase().startsWith('T') ? 'T' : 'L');
      const room      = document.getElementById('modal-class-room').value.trim();
      const batch     = document.getElementById('modal-class-batch').value.trim();

      if (!day || !startTime || !endTime || !subject) {
        alert('Please fill in Day, Start Time, End Time, and Course Name.');
        return;
      }

      if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
        alert('End Time must be after Start Time!');
        return;
      }

      // Load existing schedule
      const schedDoc = await getFriendSchedule(activeGroupId, auth.currentUser.uid);
      const schedule = (schedDoc && schedDoc.schedule) ? schedDoc.schedule : {};

      // If editing an existing slot, delete the old slot entry first
      if (origDay && origSlot && schedule[origDay] && schedule[origDay][origSlot]) {
        delete schedule[origDay][origSlot];
      }

      if (!schedule[day]) schedule[day] = {};
      const slotKey = `${startTime} - ${endTime}`;
      schedule[day][slotKey] = {
        status: 'busy',
        subject,
        room,
        type,
        typeLabel: type === 'P' ? 'Practical' : (type === 'T' ? 'Tutorial' : 'Lecture'),
        batch,
        startTime,
        endTime
      };

      await saveGroupSchedule(activeGroupId, schedule);
      closeManualModal();
      manualClassForm.reset();
      showToast(origSlot ? '✓ Class updated successfully!' : '✓ Class added to schedule!');
      await evaluateTimetableStatus();
    });
  }


  /* =========================================================
     4. EXCEL UPLOAD WITH EDITABLE REVIEW
  ========================================================= */
  const fileDropArea     = document.getElementById('file-drop-area');
  const fileInput        = document.getElementById('timetable-file');
  const uploadStatus     = document.getElementById('upload-status');
  const previewPanel     = document.getElementById('preview-panel');
  const previewTbody     = document.getElementById('preview-tbody');
  const previewMeta      = document.getElementById('preview-meta');
  const saveTimetableBtn = document.getElementById('save-timetable-btn');
  const reuploadBtn      = document.getElementById('reupload-btn');
  const addClassBtn      = document.getElementById('add-class-btn');

  let workingParsedClasses = [];

  function resetUploadUI() {
    if (previewPanel)  previewPanel.classList.add('hidden');
    if (uploadStatus)  uploadStatus.classList.add('hidden');
    if (fileDropArea)  fileDropArea.classList.remove('hidden');
    if (fileInput)     fileInput.value = '';
    workingParsedClasses = [];
  }

  function harvestPreviewRows() {
    if (!previewTbody) return [];
    const trs = previewTbody.querySelectorAll('tr');
    const harvested = [];
    trs.forEach((tr) => {
      const dayEl   = tr.querySelector('.preview-day');
      const startEl = tr.querySelector('.preview-start');
      const endEl   = tr.querySelector('.preview-end');
      const subjEl  = tr.querySelector('.preview-subject');
      const typeEl  = tr.querySelector('.preview-type');
      const roomEl  = tr.querySelector('.preview-room');
      const batchEl = tr.querySelector('.preview-batch');

      // If empty state placeholder row, ignore
      if (!subjEl) return;

      const day       = (dayEl ? dayEl.value : 'Monday').trim();
      const startTime = (startEl ? startEl.value : '').trim();
      const endTime   = (endEl ? endEl.value : '').trim();
      const subject   = (subjEl ? subjEl.value : '').trim();
      const rawType   = (typeEl ? typeEl.value : 'L').trim();
      const type      = rawType.toUpperCase().startsWith('P') ? 'P' : (rawType.toUpperCase().startsWith('T') ? 'T' : 'L');
      const room      = (roomEl ? roomEl.value : '').trim();
      const batch     = (batchEl ? batchEl.value : '').trim();

      harvested.push({
        day,
        startTime,
        endTime,
        subject,
        type,
        typeLabel: type === 'P' ? 'Practical' : (type === 'T' ? 'Tutorial' : 'Lecture'),
        room,
        batch
      });
    });
    return harvested;
  }

  function renderEditablePreviewTable(classesList) {
    workingParsedClasses = (classesList || []).map(cls => {
      const rawType = cls.type || cls.classType || 'L';
      const type = rawType.toUpperCase().startsWith('P') ? 'P' : (rawType.toUpperCase().startsWith('T') ? 'T' : 'L');
      return {
        day: cls.day || cls.dayOfWeek || 'Monday',
        startTime: cls.startTime || cls.start || '',
        endTime: cls.endTime || cls.end || '',
        subject: cls.subject || cls.courseCode || cls.course || cls.code || '',
        type,
        typeLabel: cls.typeLabel || (type === 'P' ? 'Practical' : (type === 'T' ? 'Tutorial' : 'Lecture')),
        room: cls.room || '',
        batch: cls.batch || cls.group || cls.section || ''
      };
    });

    previewTbody.innerHTML = '';
    const dayOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const typeOptions = [
      { val: 'L', label: 'Lecture' },
      { val: 'T', label: 'Tutorial' },
      { val: 'P', label: 'Practical' }
    ];

    if (!workingParsedClasses || workingParsedClasses.length === 0) {
      previewTbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:16px; color:var(--ink-muted);">No classes detected. Click "+ Add Class Row" to add one manually.</td></tr>`;
      if (previewMeta) previewMeta.innerText = '0 classes parsed';
      return;
    }

    workingParsedClasses.forEach((cls, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.index = idx;
      const curType = cls.type === 'P' ? 'P' : (cls.type === 'T' ? 'T' : 'L');
      tr.innerHTML = `
        <td>
          <select class="preview-input preview-day" data-idx="${idx}" style="min-width:105px;">
            ${dayOptions.map(d => `<option value="${d}" ${d.toLowerCase() === (cls.day || '').toLowerCase() ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </td>
        <td>
          <input type="text" class="preview-input preview-time preview-start" data-idx="${idx}" value="${cls.startTime || ''}" placeholder="08:30" style="width:70px;" />
        </td>
        <td>
          <input type="text" class="preview-input preview-time preview-end" data-idx="${idx}" value="${cls.endTime || ''}" placeholder="09:20" style="width:70px;" />
        </td>
        <td>
          <input type="text" class="preview-input preview-subject" data-idx="${idx}" value="${cls.subject || ''}" placeholder="Course / Code" style="min-width:110px; font-weight:600;" />
        </td>
        <td>
          <select class="preview-input preview-type" data-idx="${idx}" style="min-width:95px;">
            ${typeOptions.map(t => `<option value="${t.val}" ${t.val === curType ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </td>
        <td>
          <input type="text" class="preview-input preview-room" data-idx="${idx}" value="${cls.room || ''}" placeholder="Room" style="width:75px;" />
        </td>
        <td>
          <input type="text" class="preview-input preview-batch" data-idx="${idx}" value="${cls.batch || ''}" placeholder="Batch" style="width:75px;" />
        </td>
        <td style="text-align:center;">
          <button type="button" class="btn-remove-row" data-idx="${idx}" title="Remove this class" style="background:transparent; border:none; color:var(--terracotta); font-size:1.15rem; cursor:pointer; padding:2px 6px;">✕</button>
        </td>
      `;
      previewTbody.appendChild(tr);
    });

    if (previewMeta) {
      previewMeta.innerText = `${workingParsedClasses.length} class${workingParsedClasses.length === 1 ? '' : 'es'} · Click any cell to edit`;
    }

    // Bidirectional live-sync helper
    const syncRowToState = (idx) => {
      const tr = previewTbody.querySelector(`tr[data-index="${idx}"]`);
      if (!tr || !workingParsedClasses[idx]) return;
      const dayEl   = tr.querySelector('.preview-day');
      const startEl = tr.querySelector('.preview-start');
      const endEl   = tr.querySelector('.preview-end');
      const subjEl  = tr.querySelector('.preview-subject');
      const typeEl  = tr.querySelector('.preview-type');
      const roomEl  = tr.querySelector('.preview-room');
      const batchEl = tr.querySelector('.preview-batch');

      if (dayEl) workingParsedClasses[idx].day = dayEl.value;
      if (startEl) workingParsedClasses[idx].startTime = startEl.value;
      if (endEl) workingParsedClasses[idx].endTime = endEl.value;
      if (subjEl) workingParsedClasses[idx].subject = subjEl.value;
      if (typeEl) {
        workingParsedClasses[idx].type = typeEl.value;
        workingParsedClasses[idx].typeLabel = typeEl.value === 'P' ? 'Practical' : (typeEl.value === 'T' ? 'Tutorial' : 'Lecture');
      }
      if (roomEl) workingParsedClasses[idx].room = roomEl.value;
      if (batchEl) workingParsedClasses[idx].batch = batchEl.value;
    };

    // Live update listeners on all inputs (input, change, blur)
    previewTbody.querySelectorAll('.preview-input').forEach(el => {
      const idx = parseInt(el.dataset.idx, 10);
      el.addEventListener('input', () => syncRowToState(idx));
      el.addEventListener('change', () => syncRowToState(idx));
      el.addEventListener('blur', () => syncRowToState(idx));
    });

    // Remove row listener
    previewTbody.querySelectorAll('.btn-remove-row').forEach(el => {
      el.addEventListener('click', (e) => {
        const harvested = harvestPreviewRows();
        const btn = e.currentTarget;
        const idx = parseInt(btn.dataset.idx, 10);
        if (!isNaN(idx) && idx >= 0 && idx < harvested.length) {
          harvested.splice(idx, 1);
        }
        workingParsedClasses = harvested;
        renderEditablePreviewTable(workingParsedClasses);
      });
    });
  }

  if (addClassBtn) {
    addClassBtn.addEventListener('click', () => {
      const currentRows = harvestPreviewRows();
      workingParsedClasses = currentRows.length > 0 ? currentRows : (workingParsedClasses || []);
      workingParsedClasses.push({
        day: 'Monday',
        startTime: '08:30',
        endTime: '09:20',
        subject: '',
        type: 'L',
        typeLabel: 'Lecture',
        room: '',
        batch: ''
      });
      renderEditablePreviewTable(workingParsedClasses);
    });
  }

  // File Drop & Browser
  fileDropArea?.addEventListener('dragover', (e) => { e.preventDefault(); fileDropArea.classList.add('drag-over'); });
  fileDropArea?.addEventListener('dragleave', () => fileDropArea.classList.remove('drag-over'));
  fileDropArea?.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropArea.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleExcelFile(e.dataTransfer.files[0]);
  });
  fileDropArea?.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
  fileInput?.addEventListener('change', () => { if (fileInput.files[0]) handleExcelFile(fileInput.files[0]); });

  async function handleExcelFile(file) {
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
      alert('Please upload an Excel (.xlsx or .xls) file.');
      return;
    }
    fileDropArea.classList.add('hidden');
    uploadStatus.classList.remove('hidden');
    timetableStatusText.innerText = 'Parsing Excel timetable…';
    previewPanel.classList.add('hidden');

    try {
      const result = await parseLpuExcel(file);
      if (!result.classes || result.classes.length === 0) {
        timetableStatusText.innerText = 'No classes found in the file. Please check format.';
        uploadStatus.style.color = 'var(--terracotta)';
        fileDropArea.classList.remove('hidden');
        return;
      }
      renderEditablePreviewTable(result.classes);
      uploadStatus.classList.add('hidden');
      previewPanel.classList.remove('hidden');
    } catch (err) {
      timetableStatusText.innerText = 'Parse error: ' + err.message;
      uploadStatus.style.color = 'var(--terracotta)';
      fileDropArea.classList.remove('hidden');
    }
  }

  reuploadBtn?.addEventListener('click', resetUploadUI);

  // Save Schedule Button
  saveTimetableBtn?.addEventListener('click', async () => {
    // 1. Verify squad context first
    if (!activeGroupId) {
      alert('Please select or join a campus squad first before saving your timetable.');
      return;
    }

    // 2. Harvest live rows directly from DOM first, falling back to workingParsedClasses
    const domHarvested = harvestPreviewRows();
    const candidateClasses = (domHarvested && domHarvested.length > 0)
      ? domHarvested
      : (workingParsedClasses || []);

    if (!candidateClasses || candidateClasses.length === 0) {
      alert('Please add at least one valid class before saving.');
      return;
    }

    // 3. Validate entries, ignore completely empty rows, and build schedule object
    const scheduleToSave = {};
    let validClassCount = 0;
    let hasErrors = false;

    for (let i = 0; i < candidateClasses.length; i++) {
      const c = candidateClasses[i];
      const subj = (c.subject || c.courseCode || c.course || c.code || '').trim();
      const rawStart = (c.startTime || c.start || '').trim();
      const rawEnd = (c.endTime || c.end || '').trim();
      const room = (c.room || '').trim();
      const batch = (c.batch || c.group || c.section || '').trim();
      const day = (c.day || c.dayOfWeek || 'Monday').trim();
      const rawType = c.type || c.classType || 'L';
      const type = rawType.toUpperCase().startsWith('P') ? 'P' :
                   rawType.toUpperCase().startsWith('T') ? 'T' : 'L';
      const typeLabel = c.typeLabel || (type === 'P' ? 'Practical' : (type === 'T' ? 'Tutorial' : 'Lecture'));

      // Check if row is completely empty (no subject, room, or batch, or default/blank)
      const isCompletelyEmpty = !subj && !room && !batch;
      if (isCompletelyEmpty) {
        continue; // Cleanly ignore completely empty rows without error
      }

      // If user provided some details but left subject blank
      if (!subj) {
        alert(`Row ${i + 1} (${day}): Please enter a course code / subject name.`);
        hasErrors = true;
        break;
      }

      const sTime = normaliseTime(rawStart);
      const eTime = normaliseTime(rawEnd);

      if (!sTime || !eTime) {
        alert(`Row ${i + 1} (${subj} on ${day}): Please enter valid start and end times (e.g. 08:30 - 09:20).`);
        hasErrors = true;
        break;
      }

      const startMins = timeToMinutes(sTime);
      const endMins = timeToMinutes(eTime);

      if (endMins <= startMins) {
        alert(`Invalid time for ${subj} on ${day}: End Time (${eTime}) must be after Start Time (${sTime}).`);
        hasErrors = true;
        break;
      }

      // Valid class entry
      if (!scheduleToSave[day]) scheduleToSave[day] = {};
      let slotKey = `${sTime} - ${eTime}`;
      if (scheduleToSave[day][slotKey]) {
        slotKey = `${sTime} - ${eTime}|${batch || validClassCount}`;
      }

      scheduleToSave[day][slotKey] = {
        status: 'busy',
        subject: subj,
        room,
        type,
        typeLabel,
        batch,
        startTime: sTime,
        endTime: eTime
      };
      validClassCount++;
    }

    if (hasErrors) return;

    if (validClassCount === 0 || Object.keys(scheduleToSave).length === 0) {
      alert('Please add at least one valid class before saving.');
      return;
    }

    // Keep workingParsedClasses in sync with latest harvested state
    workingParsedClasses = candidateClasses;

    saveTimetableBtn.disabled = true;
    saveTimetableBtn.innerText = 'Saving…';
    if (uploadStatus) uploadStatus.classList.remove('hidden');
    if (timetableStatusText) timetableStatusText.innerText = 'Saving timetable to campus squad…';

    try {
      await saveGroupSchedule(activeGroupId, scheduleToSave);
      currentUserSchedule = scheduleToSave;
      if (timetableStatusText) timetableStatusText.innerText = 'Timetable saved successfully!';
      showToast('✓ Timetable saved successfully!');
      setTimeout(async () => {
        if (uploadStatus) uploadStatus.classList.add('hidden');
        saveTimetableBtn.disabled = false;
        saveTimetableBtn.innerText = '✓ Looks good, Save Timetable';
        workingParsedClasses = [];
        await evaluateTimetableStatus();
      }, 1200);
    } catch (err) {
      if (timetableStatusText) timetableStatusText.innerText = 'Save failed: ' + err.message;
      saveTimetableBtn.disabled = false;
      saveTimetableBtn.innerText = '✓ Looks good, Save Timetable';
      alert('Save failed: ' + err.message);
    }
  });


  /* =========================================================
     5. FIND FRIENDS & TIMETABLE VIEWER
  ========================================================= */
  const searchBtn                 = document.getElementById('search-btn');
  const searchInput               = document.getElementById('search-input');
  const searchResultsDiv          = document.getElementById('search-results');
  const friendSchedWrap           = document.getElementById('friend-schedule-container');
  const friendBackBtn             = document.getElementById('friend-back-btn');
  const friendNameDisplay         = document.getElementById('friend-name-display');
  const friendAvatarCircle        = document.getElementById('friend-avatar-circle');
  const friendNicknamesBadge      = document.getElementById('friend-nicknames-badge');
  const friendTimetableMeta       = document.getElementById('friend-timetable-meta');
  const friendTimetableStatus     = document.getElementById('friend-timetable-status');
  const friendViewToggleBar       = document.getElementById('friend-view-toggle-bar');
  const friendTimetableLoading    = document.getElementById('friend-timetable-loading');
  const friendTimetableError      = document.getElementById('friend-timetable-error');
  const friendTimetableErrorMsg   = document.getElementById('friend-timetable-error-msg');
  const friendTimetableEmpty      = document.getElementById('friend-timetable-empty');
  const friendEmptyTitle          = document.getElementById('friend-empty-title');
  const friendEmptyDesc           = document.getElementById('friend-empty-desc');
  const friendCompareResults      = document.getElementById('friend-compare-results');
  const compareFriendBtn          = document.getElementById('compare-friend-btn');

  // Viewing container DOM elements
  const friendWeeklyMatrixContainer = document.getElementById('friend-weekly-matrix-container');
  const friendWeeklyMatrixGrid      = document.getElementById('friend-weekly-matrix-grid');
  const friendDayCardsWrapper       = document.getElementById('friend-day-cards-wrapper');
  const friendCalendarGrid          = document.getElementById('friend-calendar-grid');
  const friendTableViewWrapper      = document.getElementById('friend-table-view-wrapper');
  const friendTableTbody            = document.getElementById('friend-table-tbody');

  // View toggle buttons
  const btnFriendToggleMatrix     = document.getElementById('btn-friend-toggle-matrix');
  const btnFriendToggleCards      = document.getElementById('btn-friend-toggle-cards');
  const btnFriendToggleTable      = document.getElementById('btn-friend-toggle-table');

  let activeFriendSchedule = null;
  let activeFriendViewMode = 'matrix'; // 'matrix' | 'cards' | 'table'

  // View mode switcher for friend timetable
  function renderFriendActiveView() {
    if (!activeFriendSchedule) return;

    btnFriendToggleMatrix?.classList.toggle('active', activeFriendViewMode === 'matrix');
    btnFriendToggleCards?.classList.toggle('active',  activeFriendViewMode === 'cards');
    btnFriendToggleTable?.classList.toggle('active',  activeFriendViewMode === 'table');

    friendWeeklyMatrixContainer?.classList.toggle('hidden', activeFriendViewMode !== 'matrix');
    friendDayCardsWrapper?.classList.toggle('hidden',       activeFriendViewMode !== 'cards');
    friendTableViewWrapper?.classList.toggle('hidden',       activeFriendViewMode !== 'table');

    if (activeFriendViewMode === 'matrix') {
      renderWeeklyMatrix(friendWeeklyMatrixGrid, activeFriendSchedule, { readOnly: true });
    } else if (activeFriendViewMode === 'cards') {
      renderDayCards(friendCalendarGrid, activeFriendSchedule, { readOnly: true });
    } else if (activeFriendViewMode === 'table') {
      renderReadOnlyTable(friendTableTbody, activeFriendSchedule);
    }
  }

  btnFriendToggleMatrix?.addEventListener('click', () => {
    activeFriendViewMode = 'matrix';
    renderFriendActiveView();
  });
  btnFriendToggleCards?.addEventListener('click', () => {
    activeFriendViewMode = 'cards';
    renderFriendActiveView();
  });
  btnFriendToggleTable?.addEventListener('click', () => {
    activeFriendViewMode = 'table';
    renderFriendActiveView();
  });

  // Back to Find Friends button
  friendBackBtn?.addEventListener('click', () => {
    friendSchedWrap?.classList.add('hidden');
    friendCompareResults?.classList.add('hidden');
    activeFriendData = null;
    activeFriendSchedule = null;
    document.getElementById('friend-search-card')?.scrollIntoView({ behavior: 'smooth' });
  });

  // Open Friend Timetable Viewer
  async function openFriendTimetable(friend) {
    if (!friend || !friend.id || !activeGroupId) return;

    activeFriendData = { ...friend };
    activeFriendSchedule = null;

    // Reset and show timetable container
    friendSchedWrap?.classList.remove('hidden');
    friendCompareResults?.classList.add('hidden');

    // Update friend profile banner
    if (friendNameDisplay) friendNameDisplay.innerText = friend.name || 'Friend';
    const initial = (friend.name || 'F').trim()[0].toUpperCase();
    if (friendAvatarCircle) friendAvatarCircle.innerText = initial;

    if (friendNicknamesBadge) {
      if (friend.nicknames && friend.nicknames.length > 0) {
        friendNicknamesBadge.innerText = `AKA: ${friend.nicknames.join(', ')}`;
        friendNicknamesBadge.classList.remove('hidden');
      } else {
        friendNicknamesBadge.classList.add('hidden');
      }
    }

    if (friendTimetableMeta) {
      friendTimetableMeta.innerText = `Squad Member • Academic Schedule`;
    }

    // Set loading state
    friendTimetableLoading?.classList.remove('hidden');
    friendTimetableEmpty?.classList.add('hidden');
    friendTimetableError?.classList.add('hidden');
    friendWeeklyMatrixContainer?.classList.add('hidden');
    friendDayCardsWrapper?.classList.add('hidden');
    friendTableViewWrapper?.classList.add('hidden');
    friendViewToggleBar?.classList.add('hidden');

    if (friendTimetableStatus) {
      friendTimetableStatus.innerText = 'Retrieving timetable…';
      friendTimetableStatus.className = 'upload-status-tag';
    }

    try {
      // 1. Authorization verification: ensure friend is an active squad member
      const memberProfile = await getGroupProfile(activeGroupId, friend.id);
      if (!memberProfile) {
        throw new Error('This student is not a member of your active squad.');
      }

      // 2. Efficiently fetch this friend's timetable document from Firestore
      const scheduleDoc = await getFriendSchedule(activeGroupId, friend.id);
      friendTimetableLoading?.classList.add('hidden');

      if (!scheduleDoc || !scheduleDoc.schedule || Object.keys(scheduleDoc.schedule).length === 0) {
        // Friend has not uploaded a timetable yet
        activeFriendSchedule = null;
        activeFriendData.schedule = null;
        if (friendTimetableStatus) {
          friendTimetableStatus.innerText = 'No timetable uploaded';
          friendTimetableStatus.className = 'upload-status-tag empty';
        }
        if (friendEmptyTitle) friendEmptyTitle.innerText = `${friend.name}'s Timetable`;
        if (friendEmptyDesc) {
          friendEmptyDesc.innerText = `${friend.name} has not uploaded a timetable for this squad yet. Once they upload it, their weekly classes will appear here automatically.`;
        }
        friendTimetableEmpty?.classList.remove('hidden');
        return;
      }

      // 3. Timetable exists: store in memory (avoids repeated Firestore reads)
      activeFriendSchedule = scheduleDoc.schedule;
      activeFriendData.schedule = scheduleDoc.schedule;
      activeFriendData.updatedAt = scheduleDoc.updatedAt || null;

      let dateStr = 'Active';
      if (scheduleDoc.updatedAt) {
        const d = new Date(scheduleDoc.updatedAt);
        dateStr = `Saved on: ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
      }
      if (friendTimetableStatus) {
        friendTimetableStatus.innerText = `✓ ${dateStr}`;
        friendTimetableStatus.className = 'upload-status-tag';
      }

      friendViewToggleBar?.classList.remove('hidden');
      renderFriendActiveView();
      friendSchedWrap?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      friendTimetableLoading?.classList.add('hidden');
      if (friendTimetableErrorMsg) {
        friendTimetableErrorMsg.innerText = `Could not load timetable: ${err.message}`;
      }
      friendTimetableError?.classList.remove('hidden');
      if (friendTimetableStatus) {
        friendTimetableStatus.innerText = 'Error loading timetable';
        friendTimetableStatus.className = 'upload-status-tag empty';
      }
    }
  }

  // Execute Friend Search
  async function executeFriendSearch(query = '') {
    if (!activeGroupId) return;
    const q = query.trim();
    if (searchResultsDiv) {
      searchResultsDiv.innerHTML = '<p style="color:var(--ink-muted); font-size:0.86rem; padding:8px 0;">Searching squad members…</p>';
    }
    friendSchedWrap?.classList.add('hidden');
    friendCompareResults?.classList.add('hidden');

    try {
      const results = await searchGroupFriends(activeGroupId, q);
      if (!searchResultsDiv) return;
      searchResultsDiv.innerHTML = '';

      if (results.length === 0) {
        searchResultsDiv.innerHTML = '<p style="color:var(--ink-muted); font-size:0.88rem; padding:12px 0;">No squad members found matching that name.</p>';
        return;
      }

      results.forEach(friend => {
        const initial = (friend.name || 'F').trim()[0].toUpperCase();
        const nicknamesText = (friend.nicknames && friend.nicknames.length > 0) ? friend.nicknames.join(', ') : '';
        const isSelf = auth.currentUser && friend.id === auth.currentUser.uid;

        const card = document.createElement('div');
        card.className = 'squad-card';
        card.style.display = 'flex';
        card.style.justifyContent = 'space-between';
        card.style.alignItems = 'center';
        card.style.flexWrap = 'wrap';
        card.style.gap = '12px';
        card.style.padding = 'var(--space-4) var(--space-5)';
        card.style.cursor = 'pointer';

        card.innerHTML = `
          <div style="display:flex; align-items:center; gap:var(--space-3);">
            <div class="user-avatar-circle" style="background:linear-gradient(135deg, var(--royal), var(--midnight)); width:42px; height:42px; font-size:1.05rem;">
              ${initial}
            </div>
            <div class="info">
              <h4 style="margin:0 0 2px 0; font-size:0.98rem; color:var(--ink); font-weight:700;">
                ${friend.name} ${isSelf ? '<span style="font-size:0.75rem; color:var(--forest); font-weight:600;">(You)</span>' : ''}
              </h4>
              <p style="margin:0; font-size:0.8rem; color:var(--ink-muted);">
                ${nicknamesText ? `AKA: ${nicknamesText} • ` : ''}Squad Member
              </p>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="btn-primary btn-sm view-friend-btn" type="button" style="white-space:nowrap;">
              📅 View Timetable &rarr;
            </button>
          </div>
        `;

        card.addEventListener('click', () => openFriendTimetable(friend));
        searchResultsDiv.appendChild(card);
      });
    } catch (e) {
      if (searchResultsDiv) {
        searchResultsDiv.innerHTML = `<p style="color:var(--terracotta); padding:8px 0;">Error searching squad: ${e.message}</p>`;
      }
    }
  }

  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeFriendSearch(searchInput.value);
    }
  });

  searchBtn?.addEventListener('click', () => {
    executeFriendSearch(searchInput ? searchInput.value : '');
  });

  // 1-on-1 Free Time Compare Button
  compareFriendBtn?.addEventListener('click', () => {
    if (!currentUserSchedule) {
      alert('You have not uploaded your timetable yet. Please upload your timetable in "My Timetable" first.');
      return;
    }
    if (!activeFriendData || !activeFriendSchedule) {
      alert(`${activeFriendData?.name || 'This friend'} has not uploaded a timetable yet.`);
      return;
    }

    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (activeFriendSchedule['Sunday'] || currentUserSchedule['Sunday']) {
      dayOrder.push('Sunday');
    }

    const pair = [
      { name: 'You', schedule: currentUserSchedule },
      { name: activeFriendData.name, schedule: activeFriendSchedule }
    ];

    let html = `<h4 style="font-family:var(--font-serif); font-size:1.15rem; margin-bottom:12px; color:var(--forest-dark);">
      ⚡ Mutual Free Time with ${activeFriendData.name}
    </h4>`;
    let foundAny = false;

    for (const day of dayOrder) {
      const freeSlots = findCommonFreeSlots(pair, day, { minDuration: 30 });
      if (freeSlots.length > 0) {
        foundAny = true;
        html += `
          <div class="result-day-block" style="margin-bottom:12px;">
            <div class="result-day-header" style="font-size:0.85rem;">${day}</div>
            <div class="result-slots">
              ${freeSlots.map(s => `
                <div class="free-time-tag">
                  ✓ ${formatTime12(s.startTime)} – ${formatTime12(s.endTime)}
                  <span style="font-size:0.75rem; opacity:0.85; font-weight:normal;">(${formatDuration(s.durationMins)})</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }
    }

    if (!foundAny) {
      html += '<p style="color:var(--ink-muted); font-size:0.86rem;">No mutual free periods of 30+ minutes found between your schedules.</p>';
    }

    friendCompareResults.innerHTML = html;
    friendCompareResults.classList.remove('hidden');
    friendCompareResults.scrollIntoView({ behavior: 'smooth' });
  });


  /* =========================================================
     6. SQUAD OVERVIEW
  ========================================================= */
  const squadTimeSelect = document.getElementById('time-select');
  const squadCustomTime = document.getElementById('squad-custom-time');
  const checkSquadBtn   = document.getElementById('check-squad-btn');
  const squadResultsDiv = document.getElementById('squad-results');

  if (squadTimeSelect && squadCustomTime) {
    squadTimeSelect.addEventListener('change', () => {
      if (squadTimeSelect.value === 'custom') {
        squadCustomTime.classList.remove('hidden');
        if (!squadCustomTime.value) squadCustomTime.value = '08:30';
      } else {
        squadCustomTime.classList.add('hidden');
      }
    });
  }

  checkSquadBtn?.addEventListener('click', async () => {
    if (!activeGroupId) return;
    const day = document.getElementById('day-select').value;
    let timeVal = squadTimeSelect ? squadTimeSelect.value : '08:30';
    if (timeVal === 'custom') {
      timeVal = (squadCustomTime && squadCustomTime.value) ? squadCustomTime.value : '08:30';
    }

    squadResultsDiv.innerHTML = '<div style="color:var(--ink-muted); padding:1rem;">Loading squad status…</div>';
    try {
      const results = await getGroupSquadStatus(activeGroupId, day, timeVal);
      squadResultsDiv.innerHTML = '';
      if (results.length === 0) {
        squadResultsDiv.innerHTML = '<div class="empty-state" style="padding:1.5rem; text-align:center; color:var(--ink-muted);">No squad members found.</div>';
        return;
      }
      results.forEach(student => {
        const isFree = student.status === 'Free';
        const div = document.createElement('div');
        div.className = 'squad-card';
        let detailText = 'Ready to hang out! 😎';
        if (!isFree) {
          const roomStr = student.room ? ` | 📍 ${student.room}` : '';
          const timeStr = (student.startTime && student.endTime)
            ? ` (${formatTime12(student.startTime)} – ${formatTime12(student.endTime)})`
            : '';
          detailText = `${student.subject || 'Class'}${roomStr}${timeStr}`;
        }
        div.innerHTML = `
          <div class="info">
            <h4>${student.name}</h4>
            <p>${detailText}</p>
          </div>
          <div class="status-badge ${isFree ? 'free' : 'busy'}">${student.status}</div>
        `;
        squadResultsDiv.appendChild(div);
      });
    } catch (e) {
      squadResultsDiv.innerHTML = `<div style="color:var(--terracotta);">Error: ${e.message}</div>`;
    }
  });


  /* =========================================================
     7. COMMON FREE SLOT FINDER
  ========================================================= */
  async function loadGroupStudents() {
    if (!allStudentsCache && activeGroupId) {
      allStudentsCache = await getAllGroupStudents(activeGroupId);
    }
    return allStudentsCache || [];
  }

  document.querySelector('[data-target="free-slots-view"]')?.addEventListener('click', async () => {
    if (!activeGroupId) return;
    const cbl = document.getElementById('friend-checkbox-list');
    cbl.innerHTML = 'Loading squad members…';
    try {
      const students = await loadGroupStudents();
      cbl.innerHTML = '';
      students.forEach((student, index) => {
        const label = document.createElement('label');
        label.className = 'friend-checkbox-card';
        label.innerHTML = `
          <input type="checkbox" value="${index}" class="friend-cb" />
          <span>${student.name}</span>
        `;
        label.querySelector('input').addEventListener('change', function() {
          label.classList.toggle('selected', this.checked);
        });
        cbl.appendChild(label);
      });
    } catch (e) {
      cbl.innerHTML = 'Error loading squad members.';
    }
  });

  document.getElementById('find-common-slots-btn')?.addEventListener('click', () => {
    if (!allStudentsCache) return;
    const cbs = document.querySelectorAll('.friend-cb:checked');
    const out = document.getElementById('common-slots-results');
    if (cbs.length === 0) {
      out.innerHTML = '<p style="color:var(--terracotta); font-size:0.9rem;">Please select at least one friend.</p>';
      return;
    }

    const selected = Array.from(cbs).map(cb => allStudentsCache[cb.value]);
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const minDurVal = parseInt(document.getElementById('min-free-duration')?.value || '30', 10);
    const winVal = document.getElementById('free-time-window')?.value || '8-18';
    const [startH, endH] = winVal.split('-').map(Number);
    const dayStartMins = (startH || 8) * 60;
    const dayEndMins   = (endH || 18) * 60;

    let html = '';
    let found = false;

    // Missing schedule notices
    const missing = selected.filter(s => !s.schedule || Object.keys(s.schedule).length === 0);
    if (missing.length > 0) {
      html += `
        <div style="margin-bottom:var(--space-4); padding:10px 14px; background:var(--sage-light); border:1px solid var(--sage-border); border-radius:var(--r-md); color:var(--forest-dark); font-size:0.82rem;">
          ℹ️ Note: <strong>${missing.map(m => m.name).join(', ')}</strong> ${missing.length > 1 ? 'have' : 'has'} not uploaded a timetable yet.
        </div>
      `;
    }

    for (const day of dayOrder) {
      const freeSlots = findCommonFreeSlots(selected, day, {
        dayStartMins,
        dayEndMins,
        minDuration: minDurVal
      });

      if (freeSlots.length > 0) {
        found = true;
        html += `
          <div class="result-day-block">
            <div class="result-day-header">${day}</div>
            <div class="result-slots">
              ${freeSlots.map(slot => `
                <div class="free-time-tag">
                  ✓ ${formatTime12(slot.startTime)} – ${formatTime12(slot.endTime)}
                  <span style="font-size:0.75rem; opacity:0.85; font-weight:normal; margin-left:4px;">(${formatDuration(slot.durationMins)})</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }
    }

    out.innerHTML = found
      ? html
      : '<div class="empty-state" style="color:var(--ink-muted); padding:2rem 1rem; text-align:center;">No common free time intervals found. Try lowering the minimum duration filter.</div>';
  });


  /* =========================================================
     8. RIGHT NOW (LIVE PRESENCE TRACKER)
  ========================================================= */
  function updateRightNowTime() {
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const el = document.getElementById('current-time-display');
    if (el) {
      el.innerText = `Campus Time: ${now.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit',hour12:true})} • ${days[now.getDay()]}`;
    }
    return { now, currentDay: days[now.getDay()] };
  }

  async function renderLiveTracker() {
    if (!activeGroupId) return;
    const r = document.getElementById('right-now-results');
    r.innerHTML = 'Loading live presence…';
    const { now, currentDay } = updateRightNowTime();

    try {
      const students = await loadGroupStudents();
      r.innerHTML = '';
      const currentH = now.getHours();
      const isOff = (currentDay === 'Sunday') || (currentH < 8) || (currentH >= 22);

      if (students.length === 0) {
        r.innerHTML = '<div class="empty-state" style="padding:1.5rem; text-align:center; color:var(--ink-muted);">No active squad members found.</div>';
        return;
      }

      students.forEach(student => {
        let status = 'off';
        let sub = 'Campus Closed / Day Off';

        if (!isOff) {
          status = 'free';
          sub = 'Free right now! 😎';

          const currentMins = now.getHours() * 60 + now.getMinutes();
          const check = checkStudentBusy(student.schedule, currentDay, currentMins);

          if (check.isBusy && check.class) {
            status = 'busy';
            const roomStr = check.class.room ? ` | 📍 ${check.class.room}` : '';
            const timeStr = (check.class.startTime && check.class.endTime)
              ? ` (${formatTime12(check.class.startTime)} – ${formatTime12(check.class.endTime)})`
              : '';
            sub = `${check.class.subject || 'Class'}${roomStr}${timeStr}`;
          }
        }

        const card = document.createElement('div');
        card.className = 'squad-card';
        card.innerHTML = `
          <div class="info">
            <h4 style="display:flex; align-items:center; gap:8px;">
              <span class="live-dot ${status}"></span>
              ${student.name}
            </h4>
            <p>${sub}</p>
          </div>
          <span class="status-badge ${status === 'free' ? 'free' : (status === 'busy' ? 'busy' : '')}">${status === 'free' ? 'Free' : (status === 'busy' ? 'In Class' : 'Offline')}</span>
        `;
        r.appendChild(card);
      });
    } catch (e) {
      r.innerHTML = 'Error fetching live presence.';
    }
  }

  document.getElementById('refresh-now-btn')?.addEventListener('click', renderLiveTracker);


  /* =========================================================
     9. MY SQUADS (GROUPS DASHBOARD)
  ========================================================= */
  const createGroupBtn = document.getElementById('create-group-btn');
  const joinGroupBtn   = document.getElementById('join-group-btn');
  const onboardError   = document.getElementById('onboard-error');

  // --- Custom joining-code field wiring ---
  const createCodeInput   = document.getElementById('create-group-code');
  const createCodeStatus  = document.getElementById('create-code-status');
  const createCodeCounter = document.getElementById('create-code-counter');
  let _codeCheckTimer = null;
  let _currentCodeStatus = ''; // '', 'checking', 'available', 'taken', 'invalid'

  function styleCodeStatus(msg, type) {
    _currentCodeStatus = type;
    const colors = {
      available: 'var(--forest)',
      taken:     'var(--terracotta)',
      invalid:   'var(--terracotta)',
      '':        'var(--ink-muted)'
    };
    if (createCodeStatus) {
      createCodeStatus.textContent = msg;
      createCodeStatus.style.color = colors[type] ?? 'var(--ink-muted)';
    }
  }

  createCodeInput?.addEventListener('input', () => {
    // Auto-uppercase and strip invalid chars in-place
    const cleaned = createCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (createCodeInput.value !== cleaned) createCodeInput.value = cleaned;
    if (createCodeCounter) createCodeCounter.textContent = `${cleaned.length} / 12`;

    clearTimeout(_codeCheckTimer);
    if (cleaned.length === 0) { styleCodeStatus('', ''); return; }
    if (cleaned.length < 4)   { styleCodeStatus('Too short — minimum 4 characters', 'invalid'); return; }
    if (cleaned.length > 12)  { styleCodeStatus('Too long — maximum 12 characters', 'invalid'); return; }

    styleCodeStatus('Checking availability…', 'checking');
    _codeCheckTimer = setTimeout(async () => {
      const current = createCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (current !== cleaned) return; // stale debounce
      try {
        const available = await checkCodeAvailability(cleaned);
        // Check again for staleness after the async call
        if (createCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '') !== cleaned) return;
        styleCodeStatus(
          available ? '✓ This code is available!' : '✗ This code is already taken.',
          available ? 'available' : 'taken'
        );
      } catch (err) {
        if (createCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '') !== cleaned) return;
        styleCodeStatus('Unable to verify code availability. Check connection.', 'invalid');
      }
    }, 600);
  });

  createGroupBtn?.addEventListener('click', async () => {
    const nameInput = document.getElementById('create-group-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
      if (onboardError) onboardError.innerText = 'Please enter a squad name.';
      return;
    }

    const rawCode = (createCodeInput?.value || '').trim();
    if (rawCode) {
      if (rawCode.length < 4) {
        if (onboardError) onboardError.innerText = 'Custom joining code must be at least 4 characters.';
        return;
      }
      if (rawCode.length > 12) {
        if (onboardError) onboardError.innerText = 'Custom joining code cannot exceed 12 characters.';
        return;
      }
      if (_currentCodeStatus === 'taken') {
        if (onboardError) onboardError.innerText = 'This joining code is already taken. Please choose another.';
        return;
      }
    }

    createGroupBtn.disabled = true;
    if (onboardError) onboardError.innerText = 'Creating squad…';
    styleCodeStatus('', '');

    try {
      const g = await createGroup(name, rawCode);
      activeGroupId = g.id;
      if (nameInput) nameInput.value = '';
      if (createCodeInput)   createCodeInput.value = '';
      if (createCodeCounter) createCodeCounter.textContent = '0 / 12';
      if (onboardError) onboardError.innerText = '';
      await reloadAllUserGroups();
    } catch (e) {
      if (onboardError) onboardError.innerText = e.message;
    } finally {
      createGroupBtn.disabled = false;
    }
  });

  joinGroupBtn?.addEventListener('click', async () => {
    const codeInput = document.getElementById('join-group-code');
    const code = codeInput ? codeInput.value.trim() : '';
    if (!code) {
      if (onboardError) onboardError.innerText = 'Please enter a squad joining code.';
      return;
    }

    joinGroupBtn.disabled = true;
    if (onboardError) onboardError.innerText = 'Joining squad…';

    try {
      const g = await joinGroup(code);
      activeGroupId = g.id;
      if (codeInput) codeInput.value = '';
      if (onboardError) onboardError.innerText = '';
      await reloadAllUserGroups();
    } catch (e) {
      if (onboardError) onboardError.innerText = e.message;
    } finally {
      joinGroupBtn.disabled = false;
    }
  });

  async function renderGroupsDashboard() {
    const grid = document.getElementById('my-groups-grid');
    if (!grid) return;
    grid.innerHTML = 'Loading your squads…';

    if (allMyGroups.length === 0) {
      grid.innerHTML = "<div class='empty-state' style='grid-column: 1/-1'>You are not in any campus squads. Create or join one above!</div>";
      return;
    }

    grid.innerHTML = '';
    for (const group of allMyGroups) {
      let memberCount = '…';
      try { memberCount = await getGroupMemberCount(group.id); } catch(e){}
      const isAdmin = group.adminUid === auth.currentUser.uid;

      const card = document.createElement('div');
      card.className = 'group-card';
      card.innerHTML = `
        <div class="group-card-header">
          <div class="group-avatar">${group.name.substring(0,1).toUpperCase()}</div>
          <div style="flex:1;">
            <h3 style="font-size:1.15rem; margin-bottom:2px;">${group.name}</h3>
            <span class="role-badge ${isAdmin ? 'admin' : 'member'}">${isAdmin ? '● Admin' : 'Member'}</span>
          </div>
        </div>

        <div style="font-size:0.82rem; color:var(--ink-muted); margin-bottom:var(--space-2);">
          👥 ${memberCount} squad members
        </div>

        <div class="group-invite-code">
          <span class="code-label">Invite Code</span>
          <span class="code-value">${group.code}</span>
        </div>

        <div style="display:flex; flex-direction:column; gap:8px; margin-top:auto;">
          <button class="btn-primary btn-sm dashboard-chat-btn" data-id="${group.id}">💬 Squad Chat</button>
          ${isAdmin ? `
            <button class="btn-secondary btn-sm manage-members-btn" data-id="${group.id}">👥 Manage Members</button>
            <button class="btn-secondary btn-sm dashboard-delete-btn" data-id="${group.id}" style="color:var(--terracotta); border-color:var(--terracotta);">Delete Squad</button>
          ` : `
            <button class="btn-secondary btn-sm dashboard-leave-btn" data-id="${group.id}" style="color:var(--terracotta); border-color:var(--terracotta);">Leave Squad</button>
          `}
        </div>

        ${isAdmin ? `<div class="members-panel hidden" id="members-panel-${group.id}" style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);"></div>` : ''}
      `;
      grid.appendChild(card);
    }

    // Attach leave / delete / manage / chat listeners
    document.querySelectorAll('.dashboard-chat-btn').forEach(b => {
      b.addEventListener('click', async (e) => {
        const gid = e.currentTarget.getAttribute('data-id');
        if (gid) {
          await applyGroupContext(gid);
          switchView('squad-view');
          switchSquadSubtab('chat');
        }
      });
    });

    document.querySelectorAll('.dashboard-delete-btn').forEach(b => {
      b.addEventListener('click', async (e) => {
        if (confirm('DANGER! This deletes the entire squad for all members. Are you sure?')) {
          e.target.innerText = 'Deleting…';
          e.target.disabled = true;
          await deleteGroup(e.target.getAttribute('data-id'));
          await reloadAllUserGroups('Squad deleted.');
        }
      });
    });

    document.querySelectorAll('.dashboard-leave-btn').forEach(b => {
      b.addEventListener('click', async (e) => {
        if (confirm('Leave this squad? You will lose access to its shared timetables.')) {
          e.target.innerText = 'Leaving…';
          e.target.disabled = true;
          await leaveGroup(e.target.getAttribute('data-id'));
          if (activeGroupId === e.target.getAttribute('data-id')) activeGroupId = null;
          await reloadAllUserGroups();
        }
      });
    });

    document.querySelectorAll('.manage-members-btn').forEach(b => {
      b.addEventListener('click', async (e) => {
        const gid = e.target.getAttribute('data-id');
        const panel = document.getElementById(`members-panel-${gid}`);
        if (!panel.classList.contains('hidden')) {
          panel.classList.add('hidden');
          e.target.textContent = '👥 Manage Members';
          return;
        }
        e.target.textContent = 'Loading…';
        try {
          const members = await getAllGroupStudents(gid);
          panel.innerHTML = `
            <div style="font-weight:700; font-size:0.8rem; margin-bottom:8px; text-transform:uppercase; color:var(--ink-muted);">Squad Members (${members.length})</div>
            ${members.map(m => `
              <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:0.84rem;">
                <span>${m.name} ${m.id === auth.currentUser.uid ? '<strong>(You)</strong>' : ''}</span>
                ${m.id !== auth.currentUser.uid ? `
                  <button class="kick-member-btn" data-group="${gid}" data-uid="${m.id}" data-name="${m.name}" style="background:none; border:none; color:var(--terracotta); font-size:0.75rem; cursor:pointer;">Remove</button>
                ` : ''}
              </div>
            `).join('')}
          `;
          panel.classList.remove('hidden');
          e.target.textContent = '✕ Close Panel';

          panel.querySelectorAll('.kick-member-btn').forEach(kb => {
            kb.addEventListener('click', async () => {
              const uid = kb.getAttribute('data-uid');
              const name = kb.getAttribute('data-name');
              const group_id = kb.getAttribute('data-group');
              if (confirm(`Remove "${name}" from this squad?`)) {
                await kickMember(group_id, uid);
                await renderGroupsDashboard();
              }
            });
          });
        } catch(err) {
          panel.innerHTML = `<p style="color:red; font-size:0.8rem;">Failed to load members: ${err.message}</p>`;
        }
      });
    });
  }


  /* =========================================================
     10. PROFILE & SETTINGS
  ========================================================= */
  const profileForm        = document.getElementById('profile-form');
  const displayNameInput   = document.getElementById('display-name');
  const profileProgramInput= document.getElementById('profile-program');
  const profileBatchInput  = document.getElementById('profile-batch');

  profileForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeGroupId) return;

    const name = displayNameInput.value.trim();
    const statusBox = document.getElementById('profile-status');
    const statusText= document.getElementById('profile-status-text');
    statusBox.classList.remove('hidden');
    statusText.innerText = 'Saving profile…';

    try {
      await updateGroupProfile(activeGroupId, name, []);
      currentUserProfile = await getGroupProfile(activeGroupId);
      statusText.innerText = 'Profile saved successfully!';
      setTimeout(() => switchView('dashboard-view'), 1000);
    } catch(err) {
      statusText.innerText = 'Failed to save profile: ' + err.message;
    }
  });

  document.querySelector('[data-target="profile-view"]')?.addEventListener('click', () => {
    if (currentUserProfile) {
      if (displayNameInput) displayNameInput.value = currentUserProfile.name || '';
    }
  });

  // Helpers
  function isInClass(startTime, endTime) {
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const startMins = timeToMinutes(startTime);
    const endMins   = timeToMinutes(endTime);
    return currentMins >= startMins && currentMins < endMins;
  }

});
