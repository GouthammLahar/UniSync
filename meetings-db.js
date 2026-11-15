/**
 * meetings-db.js — UniSync Meeting Scheduler Database Layer
 * All Firestore interactions for meetings and notifications.
 */

import {
  getFirestore, collection, doc, addDoc, updateDoc, getDoc, getDocs,
  onSnapshot, serverTimestamp, query, where, orderBy, limit,
  writeBatch
} from 'firebase/firestore';
import { getApp } from 'firebase/app';
import { auth } from './db.js?v=9';

// Reuse the already-initialized Firestore instance
const db = getFirestore(getApp());

/* =========================================================
   MEETINGS COLLECTION
========================================================= */

/**
 * Creates a new meeting document in Firestore.
 * @param {Object} meetingData
 * @returns {string} new meeting document ID
 */
export async function createMeeting(meetingData) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  const participants = meetingData.participants || [];
  if (!participants.includes(uid)) participants.unshift(uid);

  // Build initial responses map — organizer auto-accepts
  const responses = {};
  participants.forEach(pid => {
    responses[pid] = pid === uid ? 'accepted' : 'pending';
  });

  const docRef = await addDoc(collection(db, 'meetings'), {
    title: meetingData.title,
    description: meetingData.description || '',
    organizerUid: uid,
    organizerName: meetingData.organizerName || auth.currentUser?.displayName || 'Organizer',
    groupId: meetingData.groupId || null,
    groupName: meetingData.groupName || null,
    participants,
    participantNames: meetingData.participantNames || {},
    responses,
    date: meetingData.date,           // "YYYY-MM-DD"
    startTime: meetingData.startTime, // "HH:MM"
    endTime: meetingData.endTime,     // "HH:MM"
    durationMins: meetingData.durationMins || 60,
    location: meetingData.location || '',
    notes: meetingData.notes || '',
    meetingType: meetingData.meetingType || 'friend',
    status: 'pending',               // pending | confirmed | cancelled | completed
    reminderSent: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return docRef.id;
}

/**
 * Fetches all meetings where the current user is a participant.
 */
export async function getMeetingsForUser(uid) {
  const q = query(
    collection(db, 'meetings'),
    where('participants', 'array-contains', uid)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Responds to a meeting (accept or reject).
 * Auto-confirms meeting if all participants accepted.
 */
export async function respondToMeeting(meetingId, uid, response) {
  const meetingRef = doc(db, 'meetings', meetingId);
  const snap = await getDoc(meetingRef);
  if (!snap.exists()) throw new Error('Meeting not found');

  const data = snap.data();
  if (!data.participants.includes(uid)) throw new Error('Not a participant');

  const updatedResponses = { ...data.responses, [uid]: response };
  
  // Check if all participants have accepted
  const allAccepted = data.participants.every(pid => updatedResponses[pid] === 'accepted');
  const newStatus = allAccepted ? 'confirmed' : (response === 'rejected' ? data.status : data.status);

  await updateDoc(meetingRef, {
    [`responses.${uid}`]: response,
    status: newStatus,
    updatedAt: serverTimestamp()
  });

  return { allAccepted, newStatus };
}

/**
 * Cancels a meeting — only the organizer can do this.
 */
export async function cancelMeeting(meetingId, uid) {
  const meetingRef = doc(db, 'meetings', meetingId);
  const snap = await getDoc(meetingRef);
  if (!snap.exists()) throw new Error('Meeting not found');
  if (snap.data().organizerUid !== uid) throw new Error('Only the organizer can cancel this meeting');

  await updateDoc(meetingRef, {
    status: 'cancelled',
    updatedAt: serverTimestamp()
  });
}

/**
 * Gets a single meeting by ID.
 */
export async function getMeeting(meetingId) {
  const snap = await getDoc(doc(db, 'meetings', meetingId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Listens to real-time updates of meetings for the current user.
 * @returns unsubscribe function
 */
export function listenToUserMeetings(uid, callback) {
  const q = query(
    collection(db, 'meetings'),
    where('participants', 'array-contains', uid)
  );
  return onSnapshot(q, snap => {
    const meetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(meetings);
  }, err => console.error('meetings listener error:', err));
}


/* =========================================================
   NOTIFICATIONS COLLECTION
========================================================= */

/**
 * Creates an in-app notification for a recipient.
 */
export async function createNotification(recipientId, senderId, type, title, message, meetingId = null) {
  await addDoc(collection(db, 'notifications'), {
    recipientId,
    senderId,
    type,       // 'meeting_invite' | 'meeting_accepted' | 'meeting_rejected' | 'meeting_confirmed' | 'meeting_cancelled' | 'meeting_reminder'
    title,
    message,
    meetingId,
    read: false,
    createdAt: serverTimestamp()
  });
}

/**
 * Listens to real-time notifications for the current user.
 * @returns unsubscribe function
 */
export function listenToNotifications(uid, callback) {
  const q = query(
    collection(db, 'notifications'),
    where('recipientId', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(30)
  );
  return onSnapshot(q, snap => {
    const notifs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(notifs);
  }, err => console.error('notifications listener error:', err));
}

/**
 * Marks a single notification as read.
 */
export async function markNotificationRead(notifId) {
  await updateDoc(doc(db, 'notifications', notifId), { read: true });
}

/**
 * Marks ALL unread notifications for a user as read.
 */
export async function markAllNotificationsRead(uid) {
  const q = query(
    collection(db, 'notifications'),
    where('recipientId', '==', uid),
    where('read', '==', false)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
}

/**
 * Creates notifications for all meeting participants (except organizer).
 */
export async function notifyMeetingParticipants(meetingId, meeting, type, title, message) {
  const uid = auth.currentUser?.uid;
  const others = (meeting.participants || []).filter(pid => pid !== uid);
  for (const recipientId of others) {
    await createNotification(recipientId, uid, type, title, message, meetingId);
  }
}

/* =========================================================
   FCM TOKEN STORAGE
========================================================= */

export async function saveFCMToken(uid, token) {
  const tokenDocRef = doc(db, 'fcmTokens', `${uid}_web`);
  await updateDoc(tokenDocRef, { token, updatedAt: serverTimestamp() }).catch(async () => {
    // Doc doesn't exist yet — create it
    const { setDoc } = await import('firebase/firestore');
    await setDoc(tokenDocRef, {
      userId: uid,
      token,
      platform: 'web',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });
}

export async function deleteFCMToken(uid) {
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(doc(db, 'fcmTokens', `${uid}_web`)).catch(() => {});
}
