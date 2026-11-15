import { 
  auth, loginWithGoogle, logoutUser, onAuthChange,
  createGroup, joinGroup, leaveGroup, getUserGroups,
  regenerateGroupCode, deleteGroup, kickMember,
  getGroupProfile, updateGroupProfile, saveGroupSchedule, deleteGroupSchedule,
  getFriendSchedule, getAllGroupStudents, searchGroupFriends, getGroupSquadStatus, getGroupMemberCount
} from './db.js?v=10';
import { parseLpuExcel } from './timetable-parser.js?v=10';
import { scanTimetableImage } from './api.js?v=10';
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

document.addEventListener('DOMContentLoaded', () => {

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
  function switchView(targetId) {
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname);
    }
    navBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-target') === targetId));
    views.forEach(v => v.classList.toggle('active', v.id === targetId));

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

        // Init meetings module with injected dependencies
        initMeetingsModule({
          getAllGroupStudents: (gid) => getAllGroupStudents(gid),
          getActiveGroupId:   () => activeGroupId,
          getActiveGroupMeta: () => activeGroupMeta,
          showToast:          (msg, type) => showToast(msg, type)
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

      // Hide notification bell and cleanup
      const notifBellWrap = document.getElementById('notif-bell-wrap');
      if (notifBellWrap) notifBellWrap.classList.add('hidden');
      cleanupNotificationBell();
      cleanupMeetingsModule();

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
        if (dashPulseDot) dashPulseDot.style.background = 'var(--forest)';
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
  function renderWeeklyMatrix(gridDOM, scheduleMap) {
    if (!gridDOM) return;
    gridDOM.innerHTML = '';
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
          <button type="button" class="matrix-empty-add-btn">+ Add Class</button>
        `;
        emptyDay.querySelector('.matrix-empty-add-btn').addEventListener('click', () => openClassModalForAdd(day));
        list.appendChild(emptyDay);
      } else {
        daySlots.sort(([a], [b]) => a.split(' - ')[0].localeCompare(b.split(' - ')[0]));
        daySlots.forEach(([slotKey, data]) => {
          const [startT, endT] = slotKey.split(' - ');
          const card = document.createElement('div');
          card.className = 'matrix-card';
          card.title = 'Click to edit or remove this class';
          card.innerHTML = `
            <div class="matrix-time">${formatTime12(startT)} – ${formatTime12(endT)}</div>
            <div class="matrix-subj">${data.subject || 'Class'}</div>
            <div class="matrix-meta">
              <span class="type-badge type-${data.type || 'L'}">${data.typeLabel || 'Lecture'}</span>
              ${data.room ? `<span class="room-pill">📍 ${data.room}</span>` : ''}
              ${data.batch ? `<span class="batch-pill">${data.batch}</span>` : ''}
            </div>
          `;
          card.addEventListener('click', () => openClassModalForEdit(day, slotKey, data));
          list.appendChild(card);
        });

        // + Add Class button positioned cleanly under the last class
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'matrix-add-btn';
        addBtn.innerHTML = `+ Add Class`;
        addBtn.title = `Add a class to ${day}`;
        addBtn.addEventListener('click', () => openClassModalForAdd(day));
        list.appendChild(addBtn);
      }

      col.appendChild(list);
      gridDOM.appendChild(col);
    });
  }

  // Render Day Cards
  function renderDayCards(containerDOM, scheduleMap) {
    if (!containerDOM) return;
    containerDOM.innerHTML = '';
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
        slotEl.title = 'Click to edit or remove this class';
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
              <span class="slot-edit-badge">✏️ Edit</span>
            </div>
            <div class="slot-meta">
              <span class="type-badge type-${data.type}">${typeLabel}</span>
              ${data.room ? `<span>📍 ${data.room}</span>` : ''}
              ${data.batch ? `<span>${data.batch}</span>` : ''}
            </div>
          </div>`;
        slotEl.addEventListener('click', () => openClassModalForEdit(day, slotKey, data));
        slotList.appendChild(slotEl);
      });

      dayCard.appendChild(slotList);

      // + Add button at bottom of each day card
      const dayAddBtn = document.createElement('button');
      dayAddBtn.type = 'button';
      dayAddBtn.className = 'day-card-add-btn';
      dayAddBtn.innerHTML = `+ Add Class to ${day}`;
      dayAddBtn.addEventListener('click', () => openClassModalForAdd(day));
      dayCard.appendChild(dayAddBtn);

      containerDOM.appendChild(dayCard);
    });
  }

  // ── FULL SCHEDULE TABLE EDITOR ─────────────────────────────────────────────
  function renderTableEditor(scheduleMap) {
    if (!tableEditorTbody) return;
    tableEditorTbody.innerHTML = '';
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
                subject: data.subject || '',
                type: data.type || 'L',
                room: data.room || '',
                batch: data.batch || ''
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
    tr.innerHTML = `
      <td>
        <select class="table-row-day">
          <option value="Monday" ${data.day === 'Monday' ? 'selected' : ''}>Monday</option>
          <option value="Tuesday" ${data.day === 'Tuesday' ? 'selected' : ''}>Tuesday</option>
          <option value="Wednesday" ${data.day === 'Wednesday' ? 'selected' : ''}>Wednesday</option>
          <option value="Thursday" ${data.day === 'Thursday' ? 'selected' : ''}>Thursday</option>
          <option value="Friday" ${data.day === 'Friday' ? 'selected' : ''}>Friday</option>
          <option value="Saturday" ${data.day === 'Saturday' ? 'selected' : ''}>Saturday</option>
          <option value="Sunday" ${data.day === 'Sunday' ? 'selected' : ''}>Sunday</option>
        </select>
      </td>
      <td><input type="time" class="table-row-start" value="${normaliseTime(data.startTime) || '08:30'}" required /></td>
      <td><input type="time" class="table-row-end" value="${normaliseTime(data.endTime) || '09:20'}" required /></td>
      <td><input type="text" class="table-row-subj" value="${data.subject || ''}" placeholder="Course Code" required /></td>
      <td>
        <select class="table-row-type">
          <option value="L" ${data.type === 'L' ? 'selected' : ''}>Lecture</option>
          <option value="T" ${data.type === 'T' ? 'selected' : ''}>Tutorial</option>
          <option value="P" ${data.type === 'P' ? 'selected' : ''}>Practical / Lab</option>
        </select>
      </td>
      <td><input type="text" class="table-row-room" value="${data.room || ''}" placeholder="e.g. 36-809" /></td>
      <td><input type="text" class="table-row-batch" value="${data.batch || ''}" placeholder="e.g. 323MB" /></td>
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
      if (!activeGroupId) return;
      const rows = tableEditorTbody.querySelectorAll('tr');
      const newSchedule = {};

      let hasErrors = false;
      rows.forEach(tr => {
        const day   = tr.querySelector('.table-row-day')?.value;
        const start = normaliseTime(tr.querySelector('.table-row-start')?.value);
        const end   = normaliseTime(tr.querySelector('.table-row-end')?.value);
        const subj  = tr.querySelector('.table-row-subj')?.value.trim();
        const type  = tr.querySelector('.table-row-type')?.value || 'L';
        const room  = tr.querySelector('.table-row-room')?.value.trim() || '';
        const batch = tr.querySelector('.table-row-batch')?.value.trim() || '';

        if (!subj) return; // skip completely empty rows

        if (!start || !end) {
          hasErrors = true;
          return;
        }

        if (timeToMinutes(end) <= timeToMinutes(start)) {
          alert(`Invalid time for ${subj} on ${day}: End Time must be after Start Time.`);
          hasErrors = true;
          return;
        }

        if (!newSchedule[day]) newSchedule[day] = {};
        const slotKey = `${start} - ${end}`;
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
      });

      if (hasErrors) return;

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
      if (!activeGroupId) return;

      const origDay   = document.getElementById('modal-edit-original-day').value;
      const origSlot  = document.getElementById('modal-edit-original-slot').value;

      const day       = document.getElementById('modal-class-day').value;
      const startTime = normaliseTime(document.getElementById('modal-class-start').value);
      const endTime   = normaliseTime(document.getElementById('modal-class-end').value);
      const subject   = document.getElementById('modal-class-subject').value.trim();
      const type      = document.getElementById('modal-class-type').value;
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
     4. EXCEL UPLOAD & AI SCAN WITH EDITABLE REVIEW
  ========================================================= */
  const tabBtns          = document.querySelectorAll('.upload-tab');
  const tabExcel         = document.getElementById('tab-panel-excel');
  const tabAI            = document.getElementById('tab-panel-ai');
  const fileDropArea     = document.getElementById('file-drop-area');
  const fileInput        = document.getElementById('timetable-file');
  const uploadStatus     = document.getElementById('upload-status');
  const previewPanel     = document.getElementById('preview-panel');
  const previewTbody     = document.getElementById('preview-tbody');
  const previewMeta      = document.getElementById('preview-meta');
  const saveTimetableBtn = document.getElementById('save-timetable-btn');
  const reuploadBtn      = document.getElementById('reupload-btn');
  const addClassBtn      = document.getElementById('add-class-btn');

  const imageDropArea    = document.getElementById('image-drop-area');
  const imageInput       = document.getElementById('timetable-image');
  const imagePreviewWrap = document.getElementById('image-preview-wrap');
  const imagePreviewThumb= document.getElementById('image-preview-thumb');
  const imageFilename    = document.getElementById('image-preview-filename');
  const changeImageBtn   = document.getElementById('change-image-btn');
  const scanImageBtn     = document.getElementById('scan-image-btn');

  let workingParsedClasses = [];
  let selectedImageFile    = null;

  function switchUploadTab(tab) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'excel') {
      tabExcel.classList.remove('hidden');
      tabAI.classList.add('hidden');
    } else {
      tabExcel.classList.add('hidden');
      tabAI.classList.remove('hidden');
    }
    uploadStatus.classList.add('hidden');
    previewPanel.classList.add('hidden');
    workingParsedClasses = [];
  }
  tabBtns.forEach(btn => btn.addEventListener('click', () => switchUploadTab(btn.dataset.tab)));

  function resetUploadUI() {
    if (previewPanel)  previewPanel.classList.add('hidden');
    if (uploadStatus)  uploadStatus.classList.add('hidden');
    if (fileDropArea)  fileDropArea.classList.remove('hidden');
    if (fileInput)     fileInput.value = '';
    workingParsedClasses = [];
    resetAITab();
  }

  function resetAITab() {
    if (imageDropArea)    imageDropArea.classList.remove('hidden');
    if (imagePreviewWrap) imagePreviewWrap.classList.add('hidden');
    if (imageInput)       imageInput.value = '';
    selectedImageFile = null;
    if (scanImageBtn) {
      scanImageBtn.disabled = false;
      scanImageBtn.innerHTML = '✨ Scan Image with Gemini AI';
    }
  }

  function renderEditablePreviewTable(classesList) {
    workingParsedClasses = classesList || [];
    previewTbody.innerHTML = '';
    const dayOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const typeOptions = [
      { val: 'L', label: 'Lecture' },
      { val: 'T', label: 'Tutorial' },
      { val: 'P', label: 'Practical' }
    ];

    if (!workingParsedClasses || workingParsedClasses.length === 0) {
      previewTbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:16px; color:var(--ink-muted);">No classes detected. Click "+ Add Class Row" to add one manually.</td></tr>`;
      previewMeta.innerText = '0 classes parsed';
      return;
    }

    workingParsedClasses.forEach((cls, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.index = idx;
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
            ${typeOptions.map(t => `<option value="${t.val}" ${t.val === (cls.type || 'L') ? 'selected' : ''}>${t.label}</option>`).join('')}
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

    previewMeta.innerText = `${workingParsedClasses.length} class${workingParsedClasses.length === 1 ? '' : 'es'} · Click any cell to edit`;

    // Live update listeners
    previewTbody.querySelectorAll('.preview-day').forEach(el => {
      el.addEventListener('change', e => { workingParsedClasses[e.target.dataset.idx].day = e.target.value; });
    });
    previewTbody.querySelectorAll('.preview-start').forEach(el => {
      el.addEventListener('input', e => { workingParsedClasses[e.target.dataset.idx].startTime = e.target.value; });
    });
    previewTbody.querySelectorAll('.preview-end').forEach(el => {
      el.addEventListener('input', e => { workingParsedClasses[e.target.dataset.idx].endTime = e.target.value; });
    });
    previewTbody.querySelectorAll('.preview-subject').forEach(el => {
      el.addEventListener('input', e => { workingParsedClasses[e.target.dataset.idx].subject = e.target.value; });
    });
    previewTbody.querySelectorAll('.preview-type').forEach(el => {
      el.addEventListener('change', e => {
        workingParsedClasses[e.target.dataset.idx].type = e.target.value;
        workingParsedClasses[e.target.dataset.idx].typeLabel = e.target.value === 'P' ? 'Practical' : (e.target.value === 'T' ? 'Tutorial' : 'Lecture');
      });
    });
    previewTbody.querySelectorAll('.preview-room').forEach(el => {
      el.addEventListener('input', e => { workingParsedClasses[e.target.dataset.idx].room = e.target.value; });
    });
    previewTbody.querySelectorAll('.preview-batch').forEach(el => {
      el.addEventListener('input', e => { workingParsedClasses[e.target.dataset.idx].batch = e.target.value; });
    });
    previewTbody.querySelectorAll('.btn-remove-row').forEach(el => {
      el.addEventListener('click', e => {
        const idx = parseInt(e.target.dataset.idx, 10);
        workingParsedClasses.splice(idx, 1);
        renderEditablePreviewTable(workingParsedClasses);
      });
    });
  }

  if (addClassBtn) {
    addClassBtn.addEventListener('click', () => {
      if (!workingParsedClasses) workingParsedClasses = [];
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

  // Image Upload Handlers
  imageDropArea?.addEventListener('dragover', (e) => { e.preventDefault(); imageDropArea.classList.add('drag-over'); });
  imageDropArea?.addEventListener('dragleave', () => imageDropArea.classList.remove('drag-over'));
  imageDropArea?.addEventListener('drop', (e) => {
    e.preventDefault();
    imageDropArea.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) showImagePreview(f);
  });
  imageDropArea?.addEventListener('click', (e) => { if (e.target !== imageInput) imageInput.click(); });
  imageInput?.addEventListener('change', () => { if (imageInput.files[0]) showImagePreview(imageInput.files[0]); });

  function showImagePreview(file) {
    selectedImageFile = file;
    imagePreviewThumb.src = URL.createObjectURL(file);
    imageFilename.textContent = file.name;
    imageDropArea.classList.add('hidden');
    imagePreviewWrap.classList.remove('hidden');
    previewPanel.classList.add('hidden');
  }
  changeImageBtn?.addEventListener('click', resetAITab);

  scanImageBtn?.addEventListener('click', async () => {
    if (!selectedImageFile) return;
    scanImageBtn.disabled = true;
    scanImageBtn.innerHTML = '<div class="spinner"></div> Scanning Image with Gemini AI…';
    uploadStatus.classList.remove('hidden');
    timetableStatusText.innerText = 'Analyzing period column headers and days… this takes 10–25s.';
    previewPanel.classList.add('hidden');

    try {
      const result = await scanTimetableImage(selectedImageFile);
      if (!result.classes || result.classes.length === 0) {
        timetableStatusText.innerText = 'No classes detected. Please try a clearer screenshot.';
        scanImageBtn.disabled = false;
        scanImageBtn.innerText = '✨ Retry AI Scan';
        return;
      }
      renderEditablePreviewTable(result.classes);
      uploadStatus.classList.add('hidden');
      previewPanel.classList.remove('hidden');
      scanImageBtn.disabled = false;
      scanImageBtn.innerText = '✨ Scan Image with Gemini AI';
    } catch (err) {
      timetableStatusText.innerText = 'Scan error: ' + err.message;
      scanImageBtn.disabled = false;
      scanImageBtn.innerText = '✨ Retry AI Scan';
    }
  });

  reuploadBtn?.addEventListener('click', resetUploadUI);

  // Save Schedule Button
  saveTimetableBtn?.addEventListener('click', async () => {
    if (!workingParsedClasses || workingParsedClasses.length === 0 || !activeGroupId) {
      alert('Please add at least one valid class before saving.');
      return;
    }

    const scheduleToSave = {};
    for (const c of workingParsedClasses) {
      const day   = (c.day || '').trim();
      const sTime = normaliseTime(c.startTime);
      const eTime = normaliseTime(c.endTime);
      const subj  = (c.subject || '').trim();
      if (!day || !sTime || !eTime || !subj) continue;

      if (!scheduleToSave[day]) scheduleToSave[day] = {};
      const slotKey = `${sTime} - ${eTime}`;
      scheduleToSave[day][slotKey] = {
        status: 'busy',
        subject: subj,
        room: (c.room || '').trim(),
        type: c.type || 'L',
        typeLabel: c.typeLabel || (c.type === 'P' ? 'Practical' : (c.type === 'T' ? 'Tutorial' : 'Lecture')),
        batch: (c.batch || '').trim(),
        startTime: sTime,
        endTime: eTime
      };
    }

    if (Object.keys(scheduleToSave).length === 0) {
      alert('Please fill in valid Day, Start Time, End Time, and Course Name.');
      return;
    }

    saveTimetableBtn.disabled = true;
    saveTimetableBtn.innerText = 'Saving…';
    uploadStatus.classList.remove('hidden');
    timetableStatusText.innerText = 'Saving timetable to campus squad…';

    try {
      await saveGroupSchedule(activeGroupId, scheduleToSave);
      timetableStatusText.innerText = 'Timetable saved successfully!';
      setTimeout(async () => {
        uploadStatus.classList.add('hidden');
        saveTimetableBtn.disabled = false;
        saveTimetableBtn.innerText = '✓ Looks good, Save Timetable';
        workingParsedClasses = [];
        await evaluateTimetableStatus();
      }, 1200);
    } catch (err) {
      timetableStatusText.innerText = 'Save failed: ' + err.message;
      saveTimetableBtn.disabled = false;
      saveTimetableBtn.innerText = '✓ Looks good, Save Timetable';
    }
  });


  /* =========================================================
     5. FIND FRIENDS & 1-ON-1 SCHEDULE COMPARE
  ========================================================= */
  const searchBtn           = document.getElementById('search-btn');
  const searchInput         = document.getElementById('search-input');
  const searchResultsDiv    = document.getElementById('search-results');
  const friendSchedWrap     = document.getElementById('friend-schedule-container');
  const friendNameDisplay   = document.querySelector('#friend-name-display span');
  const calendarGrid        = document.getElementById('calendar-grid');
  const compareFriendBtn    = document.getElementById('compare-friend-btn');
  const friendCompareResults= document.getElementById('friend-compare-results');

  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchBtn?.click();
    }
  });

  searchBtn?.addEventListener('click', async () => {
    const q = searchInput.value.trim();
    if (!q || !activeGroupId) return;
    searchResultsDiv.innerHTML = '<p style="color:var(--ink-muted); font-size:0.86rem;">Searching squad members…</p>';
    friendSchedWrap.classList.add('hidden');
    friendCompareResults.classList.add('hidden');

    try {
      const results = await searchGroupFriends(activeGroupId, q);
      searchResultsDiv.innerHTML = '';
      if (results.length === 0) {
        searchResultsDiv.innerHTML = '<p style="color:var(--ink-muted); font-size:0.88rem; padding:8px 0;">No squad members found matching that name.</p>';
        return;
      }
      results.forEach(friend => {
        const div = document.createElement('div');
        div.className = 'squad-card';
        div.style.cursor = 'pointer';
        div.innerHTML = `
          <div class="info">
            <h4>${friend.name}</h4>
            <p>${friend.schedule ? 'Timetable Available' : 'No schedule uploaded'}</p>
          </div>
          <span style="font-size:0.82rem; font-weight:700; color:var(--forest);">View Schedule &rarr;</span>
        `;
        div.addEventListener('click', () => {
          activeFriendData = friend;
          friendNameDisplay.innerText = friend.name;
          friendSchedWrap.classList.remove('hidden');
          friendCompareResults.classList.add('hidden');
          renderDayCards(calendarGrid, friend.schedule);
        });
        searchResultsDiv.appendChild(div);
      });
    } catch (e) {
      searchResultsDiv.innerHTML = `<p style="color:var(--terracotta);">Error searching: ${e.message}</p>`;
    }
  });

  // 1-on-1 Free Time Compare Button
  compareFriendBtn?.addEventListener('click', () => {
    if (!activeFriendData || !currentUserSchedule) {
      alert('Both you and your friend must have uploaded timetables to compare.');
      return;
    }

    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const pair = [
      { name: 'You', schedule: currentUserSchedule },
      { name: activeFriendData.name, schedule: activeFriendData.schedule }
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

  createGroupBtn?.addEventListener('click', async () => {
    const name = document.getElementById('create-group-name').value.trim();
    if (!name) return;
    onboardError.innerText = 'Creating squad…';
    try {
      const g = await createGroup(name);
      activeGroupId = g.id;
      document.getElementById('create-group-name').value = '';
      await reloadAllUserGroups();
    } catch (e) {
      onboardError.innerText = e.message;
    }
  });

  joinGroupBtn?.addEventListener('click', async () => {
    const code = document.getElementById('join-group-code').value.trim();
    if (!code) return;
    onboardError.innerText = 'Joining squad…';
    try {
      const g = await joinGroup(code);
      activeGroupId = g.id;
      document.getElementById('join-group-code').value = '';
      await reloadAllUserGroups();
    } catch (e) {
      onboardError.innerText = e.message;
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

    // Attach leave / delete / manage listeners
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
