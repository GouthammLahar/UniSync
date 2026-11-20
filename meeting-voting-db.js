/**
 * meeting-voting-db.js — UniSync Meeting Voting System Database Layer
 *
 * Voting architecture:
 *   meetings/{meetingId}            — extended with votingOptions, votingDeadline,
 *                                     status (voting_open|voting_closed|confirmed|cancelled),
 *                                     finalOptionIndex, confirmedAt
 *   meetings/{meetingId}/votes/{userId} — one doc per participant, auth UID as doc ID
 *
 * All destructive writes use Firestore transactions for concurrency safety.
 * Notifications are idempotent: confirmation writes a `confirmedAt` sentinel before
 * notifying so repeated calls are no-ops.
 */

import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, runTransaction, writeBatch, query, where, Timestamp
} from 'firebase/firestore';
import { getApp } from 'firebase/app';
import { auth } from './db.js?v=10';
import { createNotification } from './meetings-db.js?v=10';

const db = getFirestore(getApp());

/* =========================================================
   HELPERS
========================================================= */

/**
 * Returns true if deadline has passed.
 * Accepts Firestore Timestamp, Date, epoch number, or ISO string.
 * Invalid non-null deadline values return true (expired) to prevent treating
 * corrupted/invalid deadlines as unlimited voting periods.
 */
export function isDeadlinePassed(deadline) {
  if (!deadline) return false;
  let dateObj = null;
  if (typeof deadline?.toDate === 'function') {
    dateObj = deadline.toDate();
  } else if (deadline instanceof Date) {
    dateObj = deadline;
  } else if (typeof deadline === 'number') {
    dateObj = new Date(deadline);
  } else if (typeof deadline === 'string') {
    dateObj = new Date(deadline);
  }
  if (!dateObj || isNaN(dateObj.getTime())) {
    // Corrupted/invalid deadline: treat as passed/expired
    return true;
  }
  return dateObj.getTime() <= Date.now();
}

/**
 * Creates an idempotent in-app notification using a deterministic document ID.
 * If the notification document already exists, this write is a no-op / safe overwrite.
 */
export async function createIdempotentNotification(notifId, notifData) {
  const notifRef = doc(db, 'notifications', notifId);
  try {
    await setDoc(notifRef, {
      ...notifData,
      read: false,
      createdAt: serverTimestamp()
    });
  } catch (e) {
    console.warn('Idempotent notification already exists or setDoc skipped:', e.message);
  }
}

/** Validate optionIndex is an integer within bounds. */
function validateOptionIndex(index, optionsLength) {
  if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('Invalid option index');
  if (index < 0 || index >= optionsLength) throw new Error('Option index out of range');
}

/* =========================================================
   MEETING CREATION WITH VOTING
========================================================= */

/**
 * Creates a meeting document with voting fields appended.
 * Extends the existing createMeeting() flow — do NOT use createMeeting() from
 * meetings-db.js when creating a voting meeting; call this instead.
 *
 * @param {Object} meetingData — all fields from the creation form + votingOptions, votingDeadline
 * @returns {string} new meeting doc ID
 */
export async function createVotingMeeting(meetingData) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  const participants = [...(meetingData.participants || [])];
  if (!participants.includes(uid)) participants.unshift(uid);

  // Build responses map — creator is auto-accepted for the existing flow
  const responses = {};
  participants.forEach(pid => { responses[pid] = pid === uid ? 'accepted' : 'pending'; });

  // Validate voting options
  const votingOptions = (meetingData.votingOptions || []).map(opt => ({
    label:    opt.label || '',
    date:     opt.date  || null,       // "YYYY-MM-DD"
    startTime:opt.startTime || null,   // "HH:MM"
    endTime:  opt.endTime   || null
  }));
  if (votingOptions.length < 1) throw new Error('At least one voting option is required');

  // Validate and normalize voting deadline to a Firestore Timestamp or null
  let votingDeadline = null;
  if (meetingData.votingDeadline) {
    if (typeof meetingData.votingDeadline?.toDate === 'function') {
      votingDeadline = meetingData.votingDeadline;
    } else if (meetingData.votingDeadline instanceof Date && !isNaN(meetingData.votingDeadline.getTime())) {
      votingDeadline = Timestamp.fromDate(meetingData.votingDeadline);
    } else if (typeof meetingData.votingDeadline === 'string' && meetingData.votingDeadline.trim()) {
      const parsed = new Date(meetingData.votingDeadline);
      if (isNaN(parsed.getTime())) {
        throw new Error('Invalid voting deadline format.');
      }
      votingDeadline = Timestamp.fromDate(parsed);
    } else {
      throw new Error('Invalid voting deadline.');
    }

    if (votingDeadline.toDate().getTime() <= Date.now()) {
      throw new Error('Voting deadline must be set in the future.');
    }
  }

  const meetingRef = doc(collection(db, 'meetings'));
  await setDoc(meetingRef, {
    // Existing fields (compatible with current meeting card renderer)
    title:            meetingData.title,
    description:      meetingData.description || '',
    organizerUid:     uid,
    organizerName:    meetingData.organizerName || auth.currentUser?.displayName || 'Organizer',
    groupId:          meetingData.groupId   || null,
    groupName:        meetingData.groupName || null,
    participants,
    participantNames: meetingData.participantNames || {},
    responses,
    // For voting meetings, date/startTime/endTime are set when confirmed
    date:             null,
    startTime:        null,
    endTime:          null,
    durationMins:     meetingData.durationMins || 60,
    location:         meetingData.location || '',
    notes:            meetingData.notes    || '',
    meetingType:      meetingData.meetingType || 'group',
    reminderSent:     false,

    // --- Voting fields ---
    isVotingMeeting:   true,
    votingOptions,                                   // Array of option objects
    votingDeadline,                                  // Firestore Timestamp or null
    status:            'voting_open',
    finalOptionIndex:  null,
    confirmedAt:       null,
    createdAt:         serverTimestamp(),
    updatedAt:         serverTimestamp()
  });

  return meetingRef.id;
}

/* =========================================================
   VOTE CASTING (subcollection: meetings/{id}/votes/{uid})
========================================================= */

/**
 * Casts or changes a vote. Uses a Firestore transaction to safely overwrite any
 * previous vote by the same participant. Enforces deadline and participant checks.
 *
 * @param {string} meetingId
 * @param {number} optionIndex — 0-based index into meeting.votingOptions
 */
export async function castVote(meetingId, optionIndex) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  const meetingRef = doc(db, 'meetings', meetingId);
  const voteRef    = doc(db, 'meetings', meetingId, 'votes', uid);

  await runTransaction(db, async (tx) => {
    const meetingSnap = await tx.get(meetingRef);
    if (!meetingSnap.exists()) throw new Error('Meeting not found');

    const meeting = meetingSnap.data();

    // Participant check
    if (!meeting.participants?.includes(uid)) {
      throw new Error('You are not a participant in this meeting');
    }

    // Status check
    if (meeting.status !== 'voting_open') {
      throw new Error('Voting is not open for this meeting');
    }

    // Deadline check
    if (meeting.votingDeadline && isDeadlinePassed(meeting.votingDeadline)) {
      throw new Error('Voting deadline has passed');
    }

    // Option bounds check
    validateOptionIndex(optionIndex, (meeting.votingOptions || []).length);

    // Write / overwrite vote doc (uid is the doc ID — prevents duplicates)
    tx.set(voteRef, {
      uid,
      optionIndex,
      votedAt:   serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    // Touch meeting updatedAt so listeners refresh
    tx.update(meetingRef, { updatedAt: serverTimestamp() });
  });
}

/* =========================================================
   VOTE READING
========================================================= */

/**
 * Fetches all votes for a meeting. Returns array of { uid, optionIndex, votedAt }.
 */
export async function getVotes(meetingId) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  // Confirm caller is participant before reading votes
  const meetingSnap = await getDoc(doc(db, 'meetings', meetingId));
  if (!meetingSnap.exists()) throw new Error('Meeting not found');
  if (!meetingSnap.data().participants?.includes(uid)) {
    throw new Error('Not a participant');
  }

  const votesSnap = await getDocs(collection(db, 'meetings', meetingId, 'votes'));
  return votesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Listens to real-time vote updates for a meeting.
 * @returns unsubscribe function
 */
export function listenToVotes(meetingId, callback) {
  const votesCol = collection(db, 'meetings', meetingId, 'votes');
  return onSnapshot(votesCol, snap => {
    const votes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(votes);
  }, err => console.error('votes listener error:', err));
}

/* =========================================================
   CREATOR CONTROLS
========================================================= */

/**
 * Creator closes voting (sets status to 'voting_closed').
 * Only the meeting organizer can call this.
 */
export async function closeVoting(meetingId) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  await runTransaction(db, async (tx) => {
    const ref  = doc(db, 'meetings', meetingId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Meeting not found');

    const data = snap.data();
    if (data.organizerUid !== uid) throw new Error('Only the organizer can close voting');
    if (data.status === 'confirmed' || data.status === 'cancelled') {
      throw new Error(`Cannot close voting for a ${data.status} meeting`);
    }
    if (!['voting_open', 'voting_closed'].includes(data.status)) {
      throw new Error('Meeting is not in a votable state');
    }

    tx.update(ref, {
      status:    'voting_closed',
      updatedAt: serverTimestamp()
    });
  });
}

/**
 * Creator confirms the final meeting time (idempotent).
 * Sets date/startTime/endTime from chosen votingOption.
 * Sends notifications only once with deterministic notification IDs.
 *
 * @param {string} meetingId
 * @param {number} chosenOptionIndex
 */
export async function confirmMeeting(meetingId, chosenOptionIndex) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  let meeting = null;
  let alreadyConfirmed = false;

  await runTransaction(db, async (tx) => {
    const ref  = doc(db, 'meetings', meetingId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Meeting not found');

    meeting = snap.data();
    if (meeting.organizerUid !== uid) throw new Error('Only the organizer can confirm the meeting');

    // Reject confirmation on cancelled meetings
    if (meeting.status === 'cancelled') {
      throw new Error('Cannot confirm a cancelled meeting');
    }

    // Idempotency: if already confirmed, return without altering option or sending notifications
    if (meeting.status === 'confirmed') {
      alreadyConfirmed = true;
      return;
    }

    if (!['voting_open', 'voting_closed'].includes(meeting.status)) {
      throw new Error('Meeting is not in a confirmable state');
    }

    const options = meeting.votingOptions || [];
    validateOptionIndex(chosenOptionIndex, options.length);

    const chosen = options[chosenOptionIndex];

    tx.update(ref, {
      status:           'confirmed',
      finalOptionIndex: chosenOptionIndex,
      date:             chosen.date      || null,
      startTime:        chosen.startTime || null,
      endTime:          chosen.endTime   || null,
      confirmedAt:      serverTimestamp(),
      updatedAt:        serverTimestamp()
    });
  });

  if (alreadyConfirmed) return; // idempotent — notifications already sent

  // Send notifications to all participants (excluding organizer) using deterministic notification IDs
  if (meeting) {
    const chosen   = meeting.votingOptions[chosenOptionIndex];
    const dateStr  = chosen.date || '';
    const timeStr  = chosen.startTime
      ? ` at ${chosen.startTime}`
      : '';
    const others = (meeting.participants || []).filter(pid => pid !== uid);
    for (const recipientId of others) {
      const notifId = `notif_${meetingId}_confirmed_${recipientId}`;
      await createIdempotentNotification(notifId, {
        recipientId,
        senderId: uid,
        type: 'meeting_confirmed',
        title: `"${meeting.title}" is confirmed!`,
        message: `Meeting confirmed for ${dateStr}${timeStr}.`,
        meetingId
      });
    }
  }
}

/**
 * Creator cancels a voting proposal (idempotent).
 */
export async function cancelVotingMeeting(meetingId) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  let alreadyCancelled = false;
  let meeting = null;

  await runTransaction(db, async (tx) => {
    const ref  = doc(db, 'meetings', meetingId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Meeting not found');

    meeting = snap.data();
    if (meeting.organizerUid !== uid) throw new Error('Only the organizer can cancel this meeting');
    if (meeting.status === 'cancelled') {
      alreadyCancelled = true;
      return; // already cancelled
    }
    if (meeting.status === 'confirmed') {
      throw new Error('Cannot cancel a meeting that is already confirmed');
    }

    tx.update(ref, {
      status:    'cancelled',
      updatedAt: serverTimestamp()
    });
  });

  if (alreadyCancelled) return;

  // Notify participants with deterministic IDs
  if (meeting) {
    const others = (meeting.participants || []).filter(pid => pid !== uid);
    for (const recipientId of others) {
      const notifId = `notif_${meetingId}_cancelled_${recipientId}`;
      await createIdempotentNotification(notifId, {
        recipientId,
        senderId: uid,
        type: 'meeting_cancelled',
        title: `"${meeting.title}" has been cancelled`,
        message: `The meeting proposal was cancelled by the organizer.`,
        meetingId
      });
    }
  }
}

/* =========================================================
   VOTE TALLYING UTILITY
========================================================= */

/**
 * Tallies votes and determines results.
 * @param {Array} votes   - from listenToVotes / getVotes
 * @param {Array} options - meeting.votingOptions
 * @param {Array} participants - meeting.participants
 * @returns {Object} tally
 */
export function tallyVotes(votes, options, participants) {
  const counts = new Array(options.length).fill(0);
  const votersByOption = options.map(() => []);
  const votedUids = new Set();

  for (const v of votes) {
    if (typeof v.optionIndex === 'number' && v.optionIndex >= 0 && v.optionIndex < options.length) {
      counts[v.optionIndex]++;
      votersByOption[v.optionIndex].push(v.uid);
      votedUids.add(v.uid);
    }
  }

  const pendingUids = (participants || []).filter(uid => !votedUids.has(uid));
  const totalVotes  = counts.reduce((s, c) => s + c, 0);
  const maxCount    = Math.max(...counts);

  // Find all options tied at the max
  const winners = counts
    .map((c, i) => ({ index: i, count: c }))
    .filter(o => o.count === maxCount && maxCount > 0);

  const isTie   = winners.length > 1;
  const isZero  = totalVotes === 0;

  return { counts, votersByOption, pendingUids, totalVotes, maxCount, winners, isTie, isZero };
}


