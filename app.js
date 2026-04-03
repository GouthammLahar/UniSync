import { 
  auth, loginWithGoogle, logoutUser, onAuthChange,
  createGroup, joinGroup, leaveGroup, getUserGroups,
  regenerateGroupCode, deleteGroup,
  getGroupProfile, updateGroupProfile, saveGroupSchedule, deleteGroupSchedule,
  getFriendSchedule, getAllGroupStudents, searchGroupFriends, getGroupSquadStatus, getGroupMemberCount
} from './db.js';
import { parseLpuExcel, LPU_SLOTS } from './timetable-parser.js';
import { scanTimetableImage } from './api.js';

document.addEventListener('DOMContentLoaded', () => {

  // --- APP NAVIGATION ---
  const navBtns = document.querySelectorAll('.nav-btn');
  const views = document.querySelectorAll('.view');
  const mainNav = document.getElementById('main-nav');
  const googleLoginBtn = document.getElementById('google-login-btn');
  const logoutBtn = document.getElementById('logout-btn');
  
  // --- SUBVIEWS DOM ---
  const groupSwitcher = document.getElementById('group-switcher-select');
  const profileTabBtn = document.querySelector('[data-target="profile-view"]');

  // --- GLOBAL STATE ---
  let activeGroupId = null;
  let activeGroupMeta = null;
  let currentUserProfile = null;
  let allMyGroups = [];
  let userIsAdmin = false;

  function switchView(targetId) {
    navBtns.forEach(b => b.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    const targetView = document.getElementById(targetId);
    if (targetView) targetView.classList.add('active');
    const targetNav = document.querySelector(`.nav-btn[data-target="${targetId}"]`);
    if (targetNav) targetNav.classList.add('active');
  }

  navBtns.forEach(btn => {
    if (btn.id === 'logout-btn') return;
    btn.addEventListener('click', () => {
      switchView(btn.getAttribute('data-target'));
      if (btn.getAttribute('data-target') === 'groups-view') renderGroupsDashboard();
    });
  });

  if(googleLoginBtn) {
    googleLoginBtn.addEventListener('click', async () => {
      try { 
        await loginWithGoogle(); 
      } catch (e) { 
        console.error("Login failed:", e);
        alert("Login failed: " + e.message); 
      }
    });
  }

  const timetableStatusText = document.getElementById('status-text');

  const doLogout = async () => { await logoutUser(); };
  if(logoutBtn) logoutBtn.addEventListener('click', doLogout);
  const onboardLogout = document.getElementById('onboard-logout-btn');
  if(onboardLogout) onboardLogout.addEventListener('click', doLogout);

  /* =========================================================
     AUTH ROUTER & GROUP LOAD
  ========================================================= */
  onAuthChange(async (user) => {
    if (user) {
      await reloadAllUserGroups();
    } else {
      mainNav.classList.add('hidden');
      switchView('login-view');
      activeGroupId = null;
      activeGroupMeta = null;
      currentUserProfile = null;
    }
  });

  async function reloadAllUserGroups(forceMessage = null) {
    mainNav.classList.add('hidden');
    if (!auth.currentUser) return;
    
    allMyGroups = await getUserGroups();
    
    if (allMyGroups.length === 0) {
       switchView('groups-view');
       renderGroupsDashboard();
       const panicEl = document.getElementById('onboard-panic-msg');
       if (forceMessage) {
          panicEl.innerText = forceMessage;
          panicEl.classList.remove('hidden');
       } else {
          panicEl.classList.add('hidden');
       }
       document.getElementById('onboard-logout-btn').classList.remove('hidden');
       return;
    }

    document.getElementById('onboard-logout-btn').classList.add('hidden');
    document.getElementById('onboard-panic-msg').classList.add('hidden');

    // Populate Switcher
    groupSwitcher.innerHTML = "";
    allMyGroups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.innerText = g.name;
      groupSwitcher.appendChild(opt);
    });
    
    // Set active
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
    userIsAdmin = activeGroupMeta.adminUid === auth.currentUser.uid;
    
    try {
      currentUserProfile = await getGroupProfile(groupId);
    } catch(e) {
      console.warn("Group seems to have been deleted!");
      await reloadAllUserGroups("This group has been deleted by the admin");
      return;
    }
    
    mainNav.classList.remove('hidden');
    allStudentsCache = null;

    if (!currentUserProfile || !currentUserProfile.name) {
      switchView('profile-view');
    } else {
      await evaluateTimetableStatus();
      switchView('upload-view');
    }
  }

  /* =========================================================
     SMART TIMETABLE (My Timetable) LOGIC
  ========================================================= */
  const uploadFormArea = document.getElementById('upload-form');
  const displayTimetableArea = document.getElementById('timetable-display-area');
  const myCalendarGrid = document.getElementById('my-calendar-grid');
  
  const updateModal = document.getElementById('update-warning-modal');
  document.getElementById('trigger-update-btn').addEventListener('click', () => {
    updateModal.classList.remove('hidden');
  });
  document.getElementById('cancel-update-btn').addEventListener('click', () => {
    updateModal.classList.add('hidden');
  });
  document.getElementById('confirm-update-btn').addEventListener('click', async () => {
    updateModal.classList.add('hidden');
    timetableStatusText.innerText = "Deleting old schedule...";
    await deleteGroupSchedule(activeGroupId);
    await evaluateTimetableStatus();
  });

  async function evaluateTimetableStatus() {
     const statusTag = document.getElementById('my-timetable-status');
     statusTag.innerText = 'Checking…';
     const scheduleDocument = await getFriendSchedule(activeGroupId, auth.currentUser.uid);
     
     if (scheduleDocument && scheduleDocument.schedule) {
       let dateStr = 'Unknown Date';
       if (scheduleDocument.updatedAt) {
         const d = new Date(scheduleDocument.updatedAt);
         dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
       }
       statusTag.innerText = `✓  Uploaded on: ${dateStr}`;
       statusTag.className = 'upload-status-tag';
       
       uploadFormArea.classList.add('hidden');
       displayTimetableArea.classList.remove('hidden');
       renderDayCards(myCalendarGrid, scheduleDocument.schedule);
     } else {
       statusTag.innerText = 'Not uploaded yet';
       statusTag.className = 'upload-status-tag empty';
       // Show upload form, reset to drop zone state
       uploadFormArea.classList.remove('hidden');
       displayTimetableArea.classList.add('hidden');
       resetUploadUI();
     }
  }

  /* =========================================================
     TAB SWITCHER (Excel / AI Scan)
  ========================================================= */
  const tabBtns   = document.querySelectorAll('.upload-tab');
  const tabExcel  = document.getElementById('tab-panel-excel');
  const tabAI     = document.getElementById('tab-panel-ai');

  function switchUploadTab(tab) {
    // Update button active states
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    // Show/hide panels
    if (tab === 'excel') {
      tabExcel.classList.remove('hidden');
      tabAI.classList.add('hidden');
    } else {
      tabExcel.classList.add('hidden');
      tabAI.classList.remove('hidden');
    }
    // Reset shared status/preview
    uploadStatus.classList.add('hidden');
    previewPanel.classList.add('hidden');
    uploadStatus.style.color = '';
    parsedScheduleData = null;
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchUploadTab(btn.dataset.tab));
  });

  /* =========================================================
     EXCEL UPLOAD LOGIC
  ========================================================= */
  const fileDropArea = document.getElementById('file-drop-area');
  const fileInput    = document.getElementById('timetable-file');
  const uploadStatus = document.getElementById('upload-status');
  const previewPanel = document.getElementById('preview-panel');
  const previewTbody = document.getElementById('preview-tbody');
  const previewMeta  = document.getElementById('preview-meta');
  const saveTimetableBtn = document.getElementById('save-timetable-btn');
  const reuploadBtn      = document.getElementById('reupload-btn');

  // Parsed data held in closure
  let parsedScheduleData = null;

  function resetUploadUI() {
    if (previewPanel)  previewPanel.classList.add('hidden');
    if (uploadStatus)  uploadStatus.classList.add('hidden');
    if (fileDropArea)  fileDropArea.classList.remove('hidden');
    if (fileInput)     fileInput.value = '';
    uploadStatus.style.color = '';
    parsedScheduleData = null;
    // Also reset AI tab state
    resetAITab();
  }

  // Drag and drop
  fileDropArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDropArea.classList.add('drag-over');
  });
  fileDropArea.addEventListener('dragleave', () => fileDropArea.classList.remove('drag-over'));
  fileDropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleExcelFile(file);
  });
  fileDropArea.addEventListener('click', (e) => {
    if (e.target !== fileInput) fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleExcelFile(fileInput.files[0]);
  });

  async function handleExcelFile(file) {
    if (!file.name.endsWith('.xlsx') && file.type !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      alert('Please upload a .xlsx file only.');
      return;
    }

    // Show parsing status
    fileDropArea.classList.add('hidden');
    uploadStatus.classList.remove('hidden');
    timetableStatusText.innerText = 'Parsing Excel file...';
    previewPanel.classList.add('hidden');

    try {
      const result = await parseLpuExcel(file);
      parsedScheduleData = result.schedule;

      if (result.classes.length === 0) {
        timetableStatusText.innerText = 'No classes found in the file. Please check the format.';
        uploadStatus.style.color = 'var(--red)';
        fileDropArea.classList.remove('hidden');
        return;
      }

      // Populate preview table
      previewTbody.innerHTML = '';
      result.classes.forEach(cls => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${cls.day}</td>
          <td class="slot-time">${cls.startTime} – ${cls.endTime}</td>
          <td><strong>${cls.subject}</strong></td>
          <td><span class="type-badge type-${cls.type}">${cls.typeLabel}</span></td>
          <td>${cls.room}</td>
          <td>${cls.batch}</td>`;
        previewTbody.appendChild(tr);
      });

      if (result.studentId) {
        previewMeta.innerText = `Student ID: ${result.studentId} · ${result.classes.length} classes parsed`;
      } else {
        previewMeta.innerText = `${result.classes.length} classes parsed`;
      }

      uploadStatus.classList.add('hidden');
      previewPanel.classList.remove('hidden');
    } catch (err) {
      timetableStatusText.innerText = 'Error: ' + err.message;
      uploadStatus.style.color = 'var(--red)';
      fileDropArea.classList.remove('hidden');
      console.error('Parse error:', err);
    }
  }

  // Re-upload button
  reuploadBtn.addEventListener('click', () => {
    uploadStatus.style.color = '';
    resetUploadUI();
    // Switch back to the active tab's drop zone
    const activeTab = document.querySelector('.upload-tab.active');
    if (activeTab && activeTab.dataset.tab === 'ai') {
      switchUploadTab('ai');
    } else {
      switchUploadTab('excel');
    }
  });

  /* =========================================================
     AI IMAGE SCAN LOGIC (PNG/JPG → Gemini 2.0 Flash)
  ========================================================= */
  const imageDropArea     = document.getElementById('image-drop-area');
  const imageInput        = document.getElementById('timetable-image');
  const imagePreviewWrap  = document.getElementById('image-preview-wrap');
  const imagePreviewThumb = document.getElementById('image-preview-thumb');
  const imageFilename     = document.getElementById('image-preview-filename');
  const changeImageBtn    = document.getElementById('change-image-btn');
  const scanImageBtn      = document.getElementById('scan-image-btn');
  const imagePreviewBox   = document.querySelector('.image-preview-box');

  let selectedImageFile = null;

  function resetAITab() {
    imageDropArea.classList.remove('hidden');
    imagePreviewWrap.classList.add('hidden');
    if (imagePreviewBox) imagePreviewBox.classList.remove('scanning');
    if (imageInput) imageInput.value = '';
    selectedImageFile = null;
    scanImageBtn.disabled = false;
    scanImageBtn.innerHTML = '<span class="scan-btn-icon">✨</span> Scan with Gemini AI';
  }

  function showImagePreview(file) {
    selectedImageFile = file;
    const url = URL.createObjectURL(file);
    imagePreviewThumb.src = url;
    imageFilename.textContent = file.name;
    imageDropArea.classList.add('hidden');
    imagePreviewWrap.classList.remove('hidden');
    // Reset any previous scan state
    previewPanel.classList.add('hidden');
    uploadStatus.classList.add('hidden');
    uploadStatus.style.color = '';
    if (imagePreviewBox) imagePreviewBox.classList.remove('scanning');
    scanImageBtn.disabled = false;
    scanImageBtn.innerHTML = '<span class="scan-btn-icon">✨</span> Scan with Gemini AI';
  }

  // Drag & drop
  imageDropArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    imageDropArea.classList.add('drag-over');
  });
  imageDropArea.addEventListener('dragleave', () => imageDropArea.classList.remove('drag-over'));
  imageDropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    imageDropArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) showImagePreview(file);
  });

  // Click-to-browse
  imageDropArea.addEventListener('click', (e) => {
    if (e.target !== imageInput) imageInput.click();
  });
  imageInput.addEventListener('change', () => {
    if (imageInput.files[0]) showImagePreview(imageInput.files[0]);
  });

  // Change image
  changeImageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetAITab();
  });

  // Scan button
  scanImageBtn.addEventListener('click', async () => {
    if (!selectedImageFile) return;

    // Lock UI
    scanImageBtn.disabled = true;
    scanImageBtn.innerHTML = '<div class="spinner" style="border-top-color:#fff;"></div> Scanning…';
    if (imagePreviewBox) imagePreviewBox.classList.add('scanning');
    uploadStatus.classList.remove('hidden');
    uploadStatus.style.color = '';
    timetableStatusText.innerText = 'Sending image to Gemini AI… this may take 10–30 seconds.';
    previewPanel.classList.add('hidden');

    try {
      const result = await scanTimetableImage(selectedImageFile);
      parsedScheduleData = result.schedule;

      if (result.classes.length === 0) {
        timetableStatusText.innerText = 'No classes detected. Try a clearer screenshot.';
        uploadStatus.style.color = 'var(--red)';
        scanImageBtn.disabled = false;
        scanImageBtn.innerHTML = '<span class="scan-btn-icon">✨</span> Retry Scan';
        if (imagePreviewBox) imagePreviewBox.classList.remove('scanning');
        return;
      }

      // Populate preview table
      previewTbody.innerHTML = '';
      result.classes.forEach(cls => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${cls.day}</td>
          <td class="slot-time">${cls.startTime} – ${cls.endTime}</td>
          <td><strong>${cls.subject}</strong></td>
          <td><span class="type-badge type-${cls.type}">${cls.typeLabel}</span></td>
          <td>${cls.room}</td>
          <td>${cls.batch}</td>`;
        previewTbody.appendChild(tr);
      });
      previewMeta.innerText = `✨ AI extracted ${result.classes.length} class${result.classes.length > 1 ? 'es' : ''} from your image`;

      if (imagePreviewBox) imagePreviewBox.classList.remove('scanning');
      uploadStatus.classList.add('hidden');
      previewPanel.classList.remove('hidden');

    } catch (err) {
      timetableStatusText.innerText = 'Scan failed: ' + err.message;
      uploadStatus.style.color = 'var(--red)';
      scanImageBtn.disabled = false;
      scanImageBtn.innerHTML = '<span class="scan-btn-icon">✨</span> Retry Scan';
      if (imagePreviewBox) imagePreviewBox.classList.remove('scanning');
      console.error('AI scan error:', err);
    }
  });

  // Save button
  saveTimetableBtn.addEventListener('click', async () => {
    if (!parsedScheduleData || !activeGroupId) return;
    saveTimetableBtn.disabled = true;
    saveTimetableBtn.innerText = 'Saving...';
    previewPanel.classList.add('hidden');
    uploadStatus.classList.remove('hidden');
    timetableStatusText.innerText = 'Saving to database...';
    uploadStatus.style.color = '';

    try {
      await saveGroupSchedule(activeGroupId, parsedScheduleData);
      timetableStatusText.innerText = 'Timetable saved successfully!';
      uploadStatus.style.color = 'var(--green)';

      setTimeout(async () => {
        uploadStatus.classList.add('hidden');
        uploadStatus.style.color = '';
        saveTimetableBtn.disabled = false;
        saveTimetableBtn.innerText = '✓ Looks good, Save';
        parsedScheduleData = null;
        await evaluateTimetableStatus();
      }, 1800);
    } catch (err) {
      timetableStatusText.innerText = 'Save failed: ' + err.message;
      uploadStatus.style.color = 'var(--red)';
      previewPanel.classList.remove('hidden');
      saveTimetableBtn.disabled = false;
      saveTimetableBtn.innerText = '✓ Looks good, Save';
    }
  });


  /* =========================================================
     GROUPS DASHBOARD (Replaces Settings)
  ========================================================= */
  const createGroupBtn = document.getElementById('create-group-btn');
  const joinGroupBtn = document.getElementById('join-group-btn');
  const onboardError = document.getElementById('onboard-error');

  createGroupBtn.addEventListener('click', async () => {
    const name = document.getElementById('create-group-name').value;
    if (!name) return;
    onboardError.innerText = "Creating Group...";
    try {
      const g = await createGroup(name);
      activeGroupId = g.id;
      document.getElementById('create-group-name').value = "";
      await reloadAllUserGroups();
    } catch (e) { onboardError.innerText = e.message; }
  });

  joinGroupBtn.addEventListener('click', async () => {
    const code = document.getElementById('join-group-code').value;
    if (!code) return;
    onboardError.innerText = "Joining...";
    try {
      const g = await joinGroup(code);
      activeGroupId = g.id;
      document.getElementById('join-group-code').value = "";
      await reloadAllUserGroups();
    } catch (e) { onboardError.innerText = e.message; }
  });

  async function renderGroupsDashboard() {
     const grid = document.getElementById('my-groups-grid');
     grid.innerHTML = "Loading cards...";
     if (allMyGroups.length === 0) {
       grid.innerHTML = "<div class='empty-state' style='grid-column: 1/-1'>You are not in any groups.</div>";
       return;
     }

     grid.innerHTML = "";
     for (const group of allMyGroups) {
       let memberCount = "...";
       try { memberCount = await getGroupMemberCount(group.id); } catch(e){}
       const isAdmin = group.adminUid === auth.currentUser.uid;
       
       const card = document.createElement('div');
       card.className = 'group-card';

       card.innerHTML = `
         <div class="group-card-header">
           <div class="group-avatar">${group.name.substring(0,1).toUpperCase()}</div>
           <div class="group-card-meta">
             <h3>${group.name}</h3>
             <span class="role-badge ${isAdmin ? 'admin' : 'member'}">${isAdmin ? '● Admin' : 'Member'}</span>
           </div>
         </div>

         <div class="group-card-stats">
           <svg width="15" height="15" fill="currentColor" viewBox="0 0 20 20"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z"/></svg>
           ${memberCount} members
         </div>

         ${isAdmin ? `
           <div class="group-invite-code">
             <span class="code-label">Invite Code</span>
             <span class="code-value">${group.code}</span>
           </div>` : ''}

         <div class="group-card-actions">
           ${isAdmin
             ? `<button class="primary-btn btn-sm dashboard-delete-btn" data-id="${group.id}" style="background:var(--red); box-shadow:0 2px 8px rgba(239,68,68,0.25);">Delete Group</button>`
             : `<button class="secondary-btn btn-sm dashboard-leave-btn" data-id="${group.id}" style="color:var(--red); border-color:var(--red);">Leave Group</button>`
           }
         </div>
       `;
       grid.appendChild(card);
     }

     document.querySelectorAll('.dashboard-delete-btn').forEach(b => {
       b.addEventListener('click', async (e) => {
         if(confirm("DANGER! This deletes the entire group and drops all members forcefully. Are you absolutely sure?")) {
           e.target.innerText = "Deleting...";
           e.target.disabled = true;
           await deleteGroup(e.target.getAttribute('data-id'));
           await reloadAllUserGroups("Group deleted.");
         }
       });
     });

     document.querySelectorAll('.dashboard-leave-btn').forEach(b => {
       b.addEventListener('click', async (e) => {
         if(confirm("Leave this group? You will lose access to everything here.")) {
           e.target.innerText = "Leaving...";
           e.target.disabled = true;
           await leaveGroup(e.target.getAttribute('data-id'));
           if (activeGroupId === e.target.getAttribute('data-id')) activeGroupId = null;
           await reloadAllUserGroups();
         }
       });
     });
  }

  /* =========================================================
     TIMING HELPERS — EXACT MINUTE COMPARISON
  ========================================================= */

  /**
   * Returns true if the current time falls within [startTime, endTime).
   * startTime and endTime are "HH:MM" strings (e.g. "10:20", "11:10").
   */
  function isInClass(startTime, endTime) {
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    return currentMins >= startMins && currentMins < endMins;
  }

  /**
   * Format a "HH:MM" string to "H:MM AM/PM"
   */
  function formatTime(t24) {
    const [h, m] = t24.split(":");
    let hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12;
    if (hour === 0) hour = 12;
    return `${hour}:${m} ${ampm}`;
  }

  /* =========================================================
     DAY-CARD CALENDAR RENDERER (replaces grid)
  ========================================================= */
  function renderDayCards(containerDOM, scheduleMap) {
    containerDOM.innerHTML = "";
    if (!scheduleMap || Object.keys(scheduleMap).length === 0) {
      containerDOM.innerHTML = '<div class="empty-state"><span class="empty-icon">📭</span><p>No classes found in this timetable.</p></div>';
      return;
    }

    const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const days = dayOrder.filter(d => scheduleMap[d] && Object.keys(scheduleMap[d]).length > 0);

    if (days.length === 0) {
      containerDOM.innerHTML = '<div class="empty-state"><span class="empty-icon">📭</span><p>No classes found in this timetable.</p></div>';
      return;
    }

    days.forEach(day => {
      const daySlots = scheduleMap[day];
      // Sort slot keys by their start time
      const sortedSlots = Object.entries(daySlots)
        .filter(([, v]) => v.status === 'busy')
        .sort(([a], [b]) => {
          const aStart = a.split(' - ')[0];
          const bStart = b.split(' - ')[0];
          return aStart.localeCompare(bStart);
        });

      if (sortedSlots.length === 0) return;

      const dayCard = document.createElement('div');
      dayCard.className = 'day-card';
      dayCard.innerHTML = `<div class="day-card-header"><span class="day-name">${day}</span><span class="class-count">${sortedSlots.length} class${sortedSlots.length > 1 ? 'es' : ''}</span></div>`;

      const slotList = document.createElement('div');
      slotList.className = 'slot-list';

      sortedSlots.forEach(([slotKey, data]) => {
        const [startT, endT] = slotKey.split(' - ');
        const inClassNow = isInClass(startT, endT);
        const typeLabel = data.typeLabel || (data.type === 'L' ? 'Lecture' : data.type === 'T' ? 'Tutorial' : data.type === 'P' ? 'Practical' : data.type || '');

        const slotEl = document.createElement('div');
        slotEl.className = `slot-item${inClassNow ? ' active-slot' : ''}`;
        slotEl.innerHTML = `
          <div class="slot-time-col">
            <span class="slot-start">${formatTime(startT)}</span>
            <span class="slot-sep">→</span>
            <span class="slot-end">${formatTime(endT)}</span>
            ${inClassNow ? '<span class="now-badge">NOW</span>' : ''}
          </div>
          <div class="slot-details-col">
            <div class="slot-subject">${data.subject || 'Class'}</div>
            <div class="slot-meta">
              <span class="type-badge type-${data.type}">${typeLabel}</span>
              ${data.room ? `<span class="slot-room">📍 ${data.room}</span>` : ''}
              ${data.batch ? `<span class="slot-batch">${data.batch}</span>` : ''}
            </div>
          </div>`;
        slotList.appendChild(slotEl);
      });

      dayCard.appendChild(slotList);
      containerDOM.appendChild(dayCard);
    });
  }


  /* =========================================================
     PROFILE LOGIC (SCOPED)
  ========================================================= */
  const profileForm = document.getElementById('profile-form');
  const displayNameInput = document.getElementById('display-name');
  
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!activeGroupId) return;
    
    const name = displayNameInput.value;
    document.getElementById('profile-status').classList.remove('hidden');
    document.getElementById('profile-status-text').innerText = "Saving profile...";
    
    try {
      await updateGroupProfile(activeGroupId, name, []);
      currentUserProfile = await getGroupProfile(activeGroupId);
      document.getElementById('profile-status-text').innerText = "Profile saved successfully!";
      setTimeout(() => switchView('upload-view'), 1000);
    } catch (error) { document.getElementById('profile-status-text').innerText = "Failed to save profile."; }
  });

  profileTabBtn.addEventListener('click', () => {
     if (currentUserProfile) {
       displayNameInput.value = currentUserProfile.name || "";
     }
  });


  /* =========================================================
     FIND FRIEND LOGIC (SCOPED)
  ========================================================= */
  const searchBtn = document.getElementById('search-btn');
  const searchResultsDiv = document.getElementById('search-results');
  const friendScheduleContainer = document.getElementById('friend-schedule-container');
  const calendarGrid = document.getElementById('calendar-grid');

  searchBtn.addEventListener('click', async () => {
    const q = document.getElementById('search-input').value.trim();
    if (!q || !activeGroupId) return;
    searchResultsDiv.innerHTML = "Searching Group...";
    friendScheduleContainer.classList.add('hidden');

    try {
      const results = await searchGroupFriends(activeGroupId, q);
      searchResultsDiv.innerHTML = "";
      if (results.length === 0) {
        searchResultsDiv.innerHTML = "<p>No friends found matching that name in this group.</p>";
        return;
      }
      results.forEach(friend => {
        const div = document.createElement('div'); div.className = 'friend-card-preview';
        div.innerHTML = `<strong>${friend.name}</strong> <span>View Schedule &rarr;</span>`;
        div.addEventListener('click', () => {
          document.querySelector('#friend-name-display span').innerText = friend.name;
          friendScheduleContainer.classList.remove('hidden');
          renderDayCards(calendarGrid, friend.schedule);
        });
        searchResultsDiv.appendChild(div);
      });
    } catch (error) { searchResultsDiv.innerHTML = `<p style="color:red">Error searching: ${error.message}</p>`; }
  });


  /* =========================================================
     SQUAD OVERVIEW LOGIC (SCOPED)
  ========================================================= */
  document.getElementById('check-squad-btn').addEventListener('click', async () => {
    if(!activeGroupId) return;
    const day = document.getElementById('day-select').value;
    const time = document.getElementById('time-select').value;
    const resDiv = document.getElementById('squad-results');
    resDiv.innerHTML = "Loading group status...";
    try {
      const results = await getGroupSquadStatus(activeGroupId, day, time);
      resDiv.innerHTML = "";
      if (results.length === 0) { resDiv.innerHTML = '<div class="empty-state">No group members found.</div>'; return; }
      results.forEach(student => {
        const isFree = student.status === "Free";
        const div = document.createElement('div'); div.className = 'squad-card';
        div.innerHTML = `
          <div class="info"><h4>${student.name}</h4><p>${isFree ? 'Ready to hang out! 😎' : (student.subject + ' | ' + student.room)}</p></div>
          <div class="status-badge ${isFree ? 'free' : 'busy'}">${student.status}</div>`;
        resDiv.appendChild(div);
      });
    } catch (error) { resDiv.innerHTML = `<div style="color:red">Error: ${error.message}</div>`; }
  });


  /* =========================================================
     CACHING & ADVANCED VIEWS (SCOPED)
  ========================================================= */
  let allStudentsCache = null;
  async function loadGroupStudents() {
    if (!allStudentsCache) allStudentsCache = await getAllGroupStudents(activeGroupId);
    return allStudentsCache;
  }

  // Free Slots
  document.querySelector('[data-target="free-slots-view"]').addEventListener('click', async () => {
    if (!activeGroupId) return;
    const cbl = document.getElementById('friend-checkbox-list');
    cbl.innerHTML = "Loading group members...";
    try {
      const students = await loadGroupStudents();
      cbl.innerHTML = "";
      students.forEach((student, index) => {
        const label = document.createElement('label'); label.className = 'friend-checkbox-card';
        label.innerHTML = `<input type="checkbox" value="${index}" class="friend-cb" /><span>${student.name}</span>`;
        label.querySelector('input').addEventListener('change', function() {
          if(this.checked) label.classList.add('selected'); else label.classList.remove('selected');
        });
        cbl.appendChild(label);
      });
    } catch (e) { cbl.innerHTML = "Error loading members."; }
  });

  document.getElementById('find-common-slots-btn').addEventListener('click', () => {
    if(!allStudentsCache) return;
    const cbs = document.querySelectorAll('.friend-cb:checked');
    const out = document.getElementById('common-slots-results');
    if (cbs.length === 0) { out.innerHTML = "<p>Please select friends.</p>"; return; }
    
    const selected = Array.from(cbs).map(cb => allStudentsCache[cb.value]);
    const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const common = {};

    dayOrder.forEach(day => {
      LPU_SLOTS.forEach(slot => {
        let allFree = true;
        for (let s of selected) {
          // A student is busy at this slot if their schedule has this exact slot key marked busy
          if (s.schedule && s.schedule[day] && s.schedule[day][slot] && s.schedule[day][slot].status === 'busy') {
            allFree = false;
            break;
          }
        }
        if (allFree) {
          if (!common[day]) common[day] = [];
          common[day].push(slot);
        }
      });
    });

    let html = ""; let found = false;
    for (let day of dayOrder) {
      if (common[day] && common[day].length > 0) {
        found = true;
        html += `<div class="result-day-block"><div class="result-day-header">${day}</div><div class="result-slots">`;
        common[day].forEach(slot => html += `<div class="free-time-tag">✓ ${slot}</div>`);
        html += `</div></div>`;
      }
    }
    out.innerHTML = found ? html : '<div class="empty-state" style="color:red;">No common free time found</div>';
  });

  // Right Now — uses exact minute comparison
  function updateRightNowTime() {
    const now = new Date();
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    document.getElementById('current-time-display').innerText = `It is currently ${now.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit',hour12:true})} on ${days[now.getDay()]}`;
    return { now, currentDay: days[now.getDay()] };
  }

  async function renderLiveTracker() {
    if(!activeGroupId) return;
    const r = document.getElementById('right-now-results');
    r.innerHTML = "Loading live status...";
    const { now, currentDay } = updateRightNowTime();
    
    try {
      const students = await loadGroupStudents();
      r.innerHTML = "";
      
      const currentH = now.getHours();
      const isOff = (currentDay === "Sunday") || (currentH < 8) || (currentH >= 22);

      if (students.length === 0) { r.innerHTML = '<div class="empty-state">No active members found.</div>'; return; }

      students.forEach(student => {
        let status = "off"; let sub = "Day off / Out of hours";

        if (!isOff) {
          status = "free"; sub = "Free right now!";
          
          // Check if any slot is active right now using exact minute comparison
          if (student.schedule && student.schedule[currentDay]) {
            const daySlots = student.schedule[currentDay];
            for (const [slotKey, data] of Object.entries(daySlots)) {
              if (data.status !== 'busy') continue;
              const parts = slotKey.split(' - ');
              if (parts.length === 2 && isInClass(parts[0], parts[1])) {
                status = "busy";
                sub = `${data.subject || 'Class'} | ${data.room || ''}`;
                break;
              }
            }
          }
        }

        const card = document.createElement('div'); card.className = 'squad-card';
        card.innerHTML = `<div class="info"><h4 style="display:flex;align-items:center;gap:0.5rem;"><span class="live-dot ${status}"></span> ${student.name}</h4><p>${sub}</p></div>`;
        r.appendChild(card);
      });
    } catch (e) { r.innerHTML = "Error fetching live data."; }
  }

  document.querySelector('[data-target="right-now-view"]').addEventListener('click', renderLiveTracker);
  document.getElementById('refresh-now-btn').addEventListener('click', renderLiveTracker);

});
