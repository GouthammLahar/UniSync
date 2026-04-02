import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, setDoc, getDocs, getDoc, updateDoc, deleteDoc, query, where, writeBatch } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { firebaseConfig } from './config.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
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

function generateCode() {
  return "CLA-" + Math.floor(1000 + Math.random() * 9000);
}

export async function createGroup(groupName) {
  const uid = auth.currentUser.uid;
  const groupRef = doc(collection(db, "groups"));
  const groupId = groupRef.id;
  
  const newGroup = {
    name: groupName.trim(),
    code: generateCode(),
    adminUid: uid,
    createdAt: new Date().toISOString()
  };
  
  // 1. Create Group Doc
  await setDoc(groupRef, newGroup);
  
  // 2. Add self to group members
  await updateGroupProfile(groupId, auth.currentUser.displayName || "Admin", []);
  
  // 3. Add group to user's list
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);
  const groups = snap.exists() ? (snap.data().groups || []) : [];
  if (!groups.includes(groupId)) {
    groups.push(groupId);
    await setDoc(userRef, { groups }, { merge: true });
  }
  
  return { id: groupId, ...newGroup };
}

export async function joinGroup(code) {
  const codeUpper = code.trim().toUpperCase();
  const q = query(collection(db, "groups"), where("code", "==", codeUpper));
  const snapshot = await getDocs(q);
  
  if (snapshot.empty) throw new Error("Invalid Group Code!");
  const groupDoc = snapshot.docs[0];
  const groupId = groupDoc.id;
  
  // Add group to user's list
  const uid = auth.currentUser.uid;
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);
  const groups = snap.exists() ? (snap.data().groups || []) : [];
  
  if (groups.includes(groupId)) throw new Error("You are already in this group!");
  
  groups.push(groupId);
  await setDoc(userRef, { groups }, { merge: true });
  
  // Create default member doc
  await updateGroupProfile(groupId, auth.currentUser.displayName || "New Member", []);
  
  return { id: groupId, ...groupDoc.data() };
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
  const newCode = generateCode();
  await updateDoc(doc(db, "groups", groupId), { code: newCode });
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

export async function searchGroupFriends(groupId, searchQuery) {
  const qLower = searchQuery.toLowerCase().trim();
  const membersSnap = await getDocs(collection(db, "groups", groupId, "members"));
  
  const results = [];
  for (const mDoc of membersSnap.docs) {
    const data = mDoc.data();
    if (!data.name) continue;
    
    let matches = false;
    if (data.nameLower && data.nameLower.includes(qLower)) matches = true;
    if (data.nicknames && data.nicknames.some(n => n.includes(qLower))) matches = true;
    
    if (matches) {
       // Attach schedule
       const sSnap = await getDoc(doc(db, "groups", groupId, "schedules", mDoc.id));
       const sched = sSnap.exists() ? sSnap.data().schedule : null;
       results.push({ id: mDoc.id, ...data, schedule: sched });
    }
  }
  return results;
}

export async function getGroupSquadStatus(groupId, day, time) {
  const students = await getAllGroupStudents(groupId);
  const results = [];
  
  students.forEach(student => {
    let statusData = { status: "free" };
    if (student.schedule && student.schedule[day] && student.schedule[day][time]) {
      statusData = student.schedule[day][time];
    }
    
    results.push({
      name: student.name,
      status: statusData.status === "free" ? "Free" : "In Class",
      subject: statusData.subject || "",
      room: statusData.room || ""
    });
  });
  
  return results.sort((a, b) => {
    if (a.status === "Free" && b.status !== "Free") return -1;
    if (a.status !== "Free" && b.status === "Free") return 1;
    return a.name.localeCompare(b.name);
  });
}
