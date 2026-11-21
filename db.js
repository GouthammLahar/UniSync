import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, setDoc, getDocs, getDoc, updateDoc, deleteDoc, query, where, writeBatch, runTransaction } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { firebaseConfig } from './config.js?v=10';
import { checkStudentBusy, timeToMinutes } from './schedule-utils.js?v=10';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

/* =========================================================
   AUTHENTICATION
========================================================= */
export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}
export async function logoutUser() { return signOut(auth); }
export function onAuthChange(callback) { return onAuthStateChanged(auth, callback); }

/* =========================================================
   GROUP MANAGEMENT (CORE)
========================================================= */
export async function getUserGroups() {
  if (!auth.currentUser) return [];
  const uid = auth.currentUser.uid;
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  
  if (!userSnap.exists()) return [];
  const groupIds = userSnap.data().groups || [];
  
  if (groupIds.length === 0) return [];
  
  const groups = [];
  for (const gid of groupIds) {
    const gSnap = await getDoc(doc(db, "groups", gid));
    if (gSnap.exists()) {
      groups.push({ id: gSnap.id, ...gSnap.data() });
    } else {
      // Group was deleted by admin! Clean up user's array automatically
      leaveGroup(gid).catch(e => console.error("Failed auto-cleanup", e));
    }
  }
  return groups;
}

// =====================================================
// JOINING CODE HELPERS
// =====================================================

/** Strip all non-alphanumeric chars and uppercase the result. */
export function normaliseJoinCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Resolves a joining code to its legacy format if applicable.
 * Legacy codes were generated as "CLA-" + 4 digits (e.g. "CLA-1234").
 */
export function toLegacyCodeFormat(normalisedCode) {
  if (typeof normalisedCode === 'string' && /^CLA\d{4}$/.test(normalisedCode)) {
    return `CLA-${normalisedCode.slice(3)}`;
  }
  return null;
}

/** Validate a custom joining code (empty string = no custom code, which is fine). */
export function validateJoinCode(raw) {
  const str = String(raw || '').trim();
  if (str.length === 0) return { valid: true, error: null }; // optional field
  if (/[^A-Za-z0-9]/.test(str)) {
    return { valid: false, error: 'Joining code can only contain letters and numbers (no spaces or special characters).' };
  }
  const code = str.toUpperCase();
  if (code.length < 4)  return { valid: false, error: 'Joining code must be at least 4 characters.' };
  if (code.length > 12) return { valid: false, error: 'Joining code must be at most 12 characters.' };
  return { valid: true, error: null, code };
}

/**
 * Check if a normalised code is available (true = available).
 * Checks BOTH the new groupCodes registry AND the legacy groups collection
 * (groups whose code field may still be "CLA-XXXX" or the normalised form).
 * This prevents new groups from claiming a code that would shadow an existing legacy group.
 */
export async function checkCodeAvailability(normalisedCode) {
  if (!auth.currentUser) throw new Error('Not authenticated');

  const clean = normaliseJoinCode(normalisedCode);
  if (!clean || clean.length < 4 || clean.length > 12) return false;

  // 1. Try secure backend API first (avoids exposing any group IDs or metadata during availability typing)
  try {
    const idToken = await auth.currentUser.getIdToken();
    const resp = await fetch('/api/groups/check-code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ code: clean })
    });
    if (resp.ok) {
      const data = await resp.json();
      if (typeof data.available === 'boolean') {
        return data.available;
      }
    }
  } catch (e) {
    // Backend API unavailable or offline; fall through to client-side Firestore check
  }

  // 2. Direct Firestore point lookup in groupCodes registry
  const regSnap = await getDoc(doc(db, 'groupCodes', clean));
  if (regSnap.exists()) return false;

  // 3. Check legacy groups: exact match on normalised code
  const q1 = query(collection(db, 'groups'), where('code', '==', clean));
  const snap1 = await getDocs(q1);
  if (!snap1.empty) return false;

  // 4. Check legacy groups: hyphenated format (e.g. "CLA-1234" for "CLA1234")
  const legacyHyphenCode = toLegacyCodeFormat(clean);
  if (legacyHyphenCode) {
    const q2 = query(collection(db, 'groups'), where('code', '==', legacyHyphenCode));
    const snap2 = await getDocs(q2);
    if (!snap2.empty) return false;
  }

  return true;
}

function generateCode() {
  // Auto-generated codes: "CLA" + 4 digits — stored in groupCodes for consistency
  return "CLA" + Math.floor(1000 + Math.random() * 9000);
}

/**
 * Generate a unique auto code not claimed in groupCodes or legacy groups.
 * Uses checkCodeAvailability so the same collision rules apply.
 */
async function generateUniqueCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateCode();
    const available = await checkCodeAvailability(candidate);
    if (available) return candidate;
  }
  // Fallback: 5-digit suffix for extra entropy (still within 12-char limit: "CLA" + 5 = 8)
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = "CLA" + Math.floor(10000 + Math.random() * 89999);
    const available = await checkCodeAvailability(candidate);
    if (available) return candidate;
  }
  // Last resort: timestamp suffix
  return "CLA" + (Date.now() % 100000000).toString().slice(0, 9).slice(0, 9);
}

export async function createGroup(groupName, customCode = '') {
  const uid = auth.currentUser.uid;

  if (!groupName || !groupName.trim()) throw new Error('Squad name is required.');

  // --- Resolve and validate final code ---
  let finalCode = '';
  const isCustom = Boolean(customCode && customCode.trim());

  if (isCustom) {
    const validation = validateJoinCode(customCode);
    if (!validation.valid) throw new Error(validation.error);
    finalCode = normaliseJoinCode(customCode);

    // Pre-check availability before starting transaction (saves transaction overhead and checks legacy)
    const available = await checkCodeAvailability(finalCode);
    if (!available) throw new Error('This joining code is already in use. Please choose another.');
  }

  // Group reference
  const groupRef = doc(collection(db, 'groups'));
  const groupId = groupRef.id;

  // Atomic creation via transaction
  // If auto-generated, we loop up to 5 times in case of extreme concurrent collision
  const maxAttempts = isCustom ? 1 : 5;
  let committed = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isCustom) {
      finalCode = await generateUniqueCode();
    }

    const codeRef = doc(db, 'groupCodes', finalCode);

    try {
      await runTransaction(db, async (transaction) => {
        const codeSnap = await transaction.get(codeRef);
        if (codeSnap.exists()) {
          throw new Error('CODE_ALREADY_EXISTS');
        }

        const newGroup = {
          name: groupName.trim(),
          code: finalCode,
          adminUid: uid,
          createdAt: new Date().toISOString()
        };

        transaction.set(groupRef, newGroup);
        transaction.set(codeRef, {
          groupId,
          createdAt: new Date().toISOString()
        });
      });

      committed = true;
      break;
    } catch (err) {
      if (err.message === 'CODE_ALREADY_EXISTS' || err.code === 'permission-denied') {
        if (isCustom) {
          throw new Error('This joining code is already in use. Please choose another.');
        }
        // If auto-generated, continue loop to pick another candidate
        continue;
      }
      throw err;
    }
  }

  if (!committed) {
    throw new Error('Unable to reserve a unique squad code. Please try again.');
  }

  // --- Add self to group ---
  await updateGroupProfile(groupId, auth.currentUser.displayName || "Admin", []);

  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);
  const groups = snap.exists() ? (snap.data().groups || []) : [];
  if (!groups.includes(groupId)) {
    groups.push(groupId);
    await setDoc(userRef, { groups }, { merge: true });
  }

  return { id: groupId, name: groupName.trim(), code: finalCode, adminUid: uid, createdAt: new Date().toISOString() };
}

export async function joinGroup(code) {
  if (!code || !code.trim()) throw new Error('Please enter a joining code.');

  const normalised = normaliseJoinCode(code);
  const rawUpper = code.trim().toUpperCase();

  // If normalisation strips everything (e.g., user typed "----"), reject early
  if (!normalised) throw new Error('Invalid joining code. Please check and try again.');

  let groupId = null;
  let groupData = null;

  // 1. Try groupCodes registry (covers all new groups and migrated/claimed codes)
  const codeSnap = await getDoc(doc(db, 'groupCodes', normalised));
  if (codeSnap.exists()) {
    groupId = codeSnap.data().groupId;
    const groupSnap = await getDoc(doc(db, 'groups', groupId));
    if (!groupSnap.exists()) throw new Error('This squad no longer exists.');
    groupData = groupSnap.data();
  } else {
    // 2. Legacy fallback
    // 2a. Check if any group has code == normalised (e.g. stored without hyphen)
    const q1 = query(collection(db, 'groups'), where('code', '==', normalised));
    const snap1 = await getDocs(q1);
    if (!snap1.empty) {
      groupId = snap1.docs[0].id;
      groupData = snap1.docs[0].data();
    } else {
      // 2b. Check if legacy code format matches (e.g. "CLA-1234" for "CLA1234")
      const legacyHyphenCode = toLegacyCodeFormat(normalised);
      if (legacyHyphenCode) {
        const q2 = query(collection(db, 'groups'), where('code', '==', legacyHyphenCode));
        const snap2 = await getDocs(q2);
        if (!snap2.empty) {
          groupId = snap2.docs[0].id;
          groupData = snap2.docs[0].data();
        }
      }
      // 2c. Fallback for rawUpper if different from normalised and legacyHyphenCode
      if (!groupId && rawUpper !== normalised && rawUpper !== legacyHyphenCode) {
        const q3 = query(collection(db, 'groups'), where('code', '==', rawUpper));
        const snap3 = await getDocs(q3);
        if (!snap3.empty) {
          groupId = snap3.docs[0].id;
          groupData = snap3.docs[0].data();
        }
      }
    }
  }

  if (!groupId || !groupData) {
    throw new Error('Invalid joining code. Please check and try again.');
  }

  // Add group to user's list
  const uid = auth.currentUser.uid;
  const userRef = doc(db, 'users', uid);
  const snap = await getDoc(userRef);
  const groups = snap.exists() ? (snap.data().groups || []) : [];

  if (groups.includes(groupId)) throw new Error('You are already in this squad!');

  groups.push(groupId);
  await setDoc(userRef, { groups }, { merge: true });

  await updateGroupProfile(groupId, auth.currentUser.displayName || 'New Member', []);

  return { id: groupId, ...groupData };
}

export async function leaveGroup(groupId) {
  const uid = auth.currentUser.uid;
  // 1. Remove from local user array
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);
  if (snap.exists()) {
    const groups = snap.data().groups.filter(id => id !== groupId);
    await setDoc(userRef, { groups }, { merge: true });
  }
  // 2. Delete member and schedule docs
  await deleteDoc(doc(db, "groups", groupId, "members", uid)).catch(()=>{});
  await deleteDoc(doc(db, "groups", groupId, "schedules", uid)).catch(()=>{});
}

/* =========================================================
   GROUP ADMIN POWERS
========================================================= */
export async function renameGroup(groupId, newName) {
  await updateDoc(doc(db, "groups", groupId), { name: newName });
}

export async function regenerateGroupCode(groupId) {
  // generateUniqueCode() uses checkCodeAvailability() which checks both
  // groupCodes registry AND legacy groups collection — collision-safe.
  const newCode = await generateUniqueCode();
  const batch = writeBatch(db);
  batch.update(doc(db, 'groups', groupId), { code: newCode });
  // Reserve the new code. Old code entry in groupCodes is intentionally NOT
  // deleted (the security rule forbids client deletes). The old code remains
  // reserved but continues to point to the same groupId, so users who cached
  // the old code can still join (they'll be routed to the same group). This is
  // a safe, backward-compatible behaviour. An admin can clean up old entries
  // via the Firebase Console if desired.
  batch.set(doc(db, 'groupCodes', newCode), { groupId, createdAt: new Date().toISOString() });
  try {
    await batch.commit();
  } catch (err) {
    if (err.code === 'permission-denied' || (err.message && err.message.includes('permission'))) {
      throw new Error('Code collision during regeneration — please try again.');
    }
    throw err;
  }
  return newCode;
}

export async function kickMember(groupId, memberUid) {
  await deleteDoc(doc(db, "groups", groupId, "members", memberUid)).catch(()=>{});
  await deleteDoc(doc(db, "groups", groupId, "schedules", memberUid)).catch(()=>{});
}

export async function deleteGroup(groupId) {
  // FireStore doesn't auto-delete subcollections securely from client without a Cloud Function,
  // but we can delete the root group doc. The security rules will instantly lock out all reads,
  // and the client checking `userGroups` will realize the doc is missing and auto-leave.
  await deleteDoc(doc(db, "groups", groupId));
}


/* =========================================================
   PROFILE & SCHEDULE (PER-GROUP SCOPED)
========================================================= */
export async function getGroupProfile(groupId, targetUid = null) {
  const uid = targetUid || auth.currentUser.uid;
  const snap = await getDoc(doc(db, "groups", groupId, "members", uid));
  return snap.exists() ? snap.data() : null;
}

export async function getGroupMemberCount(groupId) {
  const snap = await getDocs(collection(db, "groups", groupId, "members"));
  return snap.size;
}

export async function updateGroupProfile(groupId, name, nicknamesArray) {
  const uid = auth.currentUser.uid;
  const userRef = doc(db, "groups", groupId, "members", uid);
  
  await setDoc(userRef, {
    uid: uid,
    email: auth.currentUser.email,
    name: name.trim(),
    nameLower: name.toLowerCase().trim(),
    nicknames: nicknamesArray.map(n => n.toLowerCase().trim()),
    joinedAt: new Date().toISOString()
  }, { merge: true });
}

export async function saveGroupSchedule(groupId, scheduleData) {
  const uid = auth.currentUser.uid;
  await setDoc(doc(db, "groups", groupId, "schedules", uid), {
    schedule: scheduleData,
    updatedAt: new Date().toISOString()
  }, { merge: true });
  return true;
}

export async function getFriendSchedule(groupId, friendUid) {
  const snap = await getDoc(doc(db, "groups", groupId, "schedules", friendUid));
  return snap.exists() ? snap.data() : null;
}

export async function deleteGroupSchedule(groupId) {
  const uid = auth.currentUser.uid;
  await deleteDoc(doc(db, "groups", groupId, "schedules", uid));
}


/* =========================================================
   QUERIES (PER-GROUP SCOPED)
========================================================= */
export async function getAllGroupStudents(groupId) {
  const membersSnap = await getDocs(collection(db, "groups", groupId, "members"));
  const results = [];
  
  // We need to fetch schedules as well to feed the intersection logic
  for (const mDoc of membersSnap.docs) {
    const mData = mDoc.data();
    if (!mData.name) continue;
    
    // Attempt to grab schedule
    const sSnap = await getDoc(doc(db, "groups", groupId, "schedules", mDoc.id));
    const sched = sSnap.exists() ? sSnap.data().schedule : null;
    
    results.push({ id: mDoc.id, ...mData, schedule: sched });
  }
  
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function searchGroupFriends(groupId, searchQuery = '') {
  const qLower = (searchQuery || '').toLowerCase().trim();
  const membersSnap = await getDocs(collection(db, "groups", groupId, "members"));
  
  const results = [];
  for (const mDoc of membersSnap.docs) {
    const data = mDoc.data();
    if (!data.name) continue;
    
    let matches = false;
    if (!qLower) {
      matches = true;
    } else {
      if (data.nameLower && data.nameLower.includes(qLower)) matches = true;
      if (data.nicknames && data.nicknames.some(n => n.includes(qLower))) matches = true;
    }
    
    if (matches) {
      results.push({ id: mDoc.id, ...data });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGroupSquadStatus(groupId, day, timeQuery) {
  const students = await getAllGroupStudents(groupId);
  const results = [];

  let qStart = 0;
  let qEnd = null;

  if (timeQuery && timeQuery.includes('-')) {
    const [t1, t2] = timeQuery.split('-').map(s => s.trim());
    qStart = timeToMinutes(t1);
    qEnd = timeToMinutes(t2);
  } else if (timeQuery) {
    qStart = timeToMinutes(timeQuery);
    qEnd = qStart + 1;
  }

  students.forEach(student => {
    const check = checkStudentBusy(student.schedule, day, qStart, qEnd);
    if (check.isBusy) {
      results.push({
        name: student.name,
        status: "In Class",
        subject: check.class.subject || "Class",
        room: check.class.room || "",
        startTime: check.class.startTime,
        endTime: check.class.endTime
      });
    } else {
      results.push({
        name: student.name,
        status: "Free",
        subject: "",
        room: "",
        startTime: null,
        endTime: null
      });
    }
  });

  return results.sort((a, b) => {
    if (a.status === "Free" && b.status !== "Free") return -1;
    if (a.status !== "Free" && b.status === "Free") return 1;
    return a.name.localeCompare(b.name);
  });
}
