/**
 * api/meetings/update.js — Vercel Serverless: Update / reschedule a meeting
 * POST /api/meetings/update
 * Body: { meetingId, updates: { title?, description?, date?, startTime?, endTime?, durationMins?, location?, notes? } }
 */

import { verifyToken, getAdminFirestore, sendFCMToTokens, getTokensForUsers } from '../_utils/admin.js';
import { sendGmailMeetingUpdated } from '../_utils/gmail.js';

const ALLOWED_FIELDS = ['title', 'description', 'date', 'startTime', 'endTime', 'durationMins', 'location', 'notes'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;
    const { meetingId, updates } = req.body || {};

    if (!meetingId || typeof meetingId !== 'string' || !updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'meetingId and updates object are required' });
    }

    const sanitizedUpdates = {};
    for (const key of ALLOWED_FIELDS) {
      if (updates[key] !== undefined) {
        sanitizedUpdates[key] = typeof updates[key] === 'string' ? updates[key].trim() : updates[key];
      }
    }

    if (Object.keys(sanitizedUpdates).length === 0) {
      return res.status(400).json({ error: 'No valid updatable fields provided' });
    }
    if (sanitizedUpdates.title !== undefined && !sanitizedUpdates.title) {
      return res.status(400).json({ error: 'Meeting title cannot be empty' });
    }

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
    const meetingRef = db.doc(`meetings/${meetingId}`);

    const txResult = await db.runTransaction(async (tx) => {
      const snap = await tx.get(meetingRef);
      if (!snap.exists) {
        return { errorStatus: 404, error: 'Meeting not found' };
      }

      const meeting = snap.data();
      if (meeting.organizerUid !== uid) {
        return { errorStatus: 403, error: 'Only the meeting organizer can update this meeting' };
      }
      if (meeting.status === 'cancelled') {
        return { errorStatus: 400, error: 'Cannot update a cancelled meeting' };
      }

      const scheduleChanged =
        (sanitizedUpdates.date !== undefined && sanitizedUpdates.date !== meeting.date) ||
        (sanitizedUpdates.startTime !== undefined && sanitizedUpdates.startTime !== meeting.startTime) ||
        (sanitizedUpdates.endTime !== undefined && sanitizedUpdates.endTime !== meeting.endTime);

      const detailsChanged =
        (sanitizedUpdates.title !== undefined && sanitizedUpdates.title !== meeting.title) ||
        (sanitizedUpdates.description !== undefined && sanitizedUpdates.description !== meeting.description) ||
        (sanitizedUpdates.location !== undefined && sanitizedUpdates.location !== meeting.location) ||
        (sanitizedUpdates.notes !== undefined && sanitizedUpdates.notes !== meeting.notes);

      if (!scheduleChanged && !detailsChanged) {
        return { unchanged: true, meeting };
      }

      const nextVersion = (meeting.updateVersion || 0) + 1;
      const participants = meeting.participants || [];
      const nextResponses = { ...(meeting.responses || {}) };
      let nextStatus = meeting.status;

      if (scheduleChanged) {
        for (const pid of participants) {
          nextResponses[pid] = pid === uid ? 'accepted' : 'pending';
        }
        nextStatus = 'pending';
      }

      const firestorePatch = {
        ...sanitizedUpdates,
        responses: nextResponses,
        status: nextStatus,
        updateVersion: nextVersion,
        updatedAt: FieldValue.serverTimestamp(),
        ...(scheduleChanged ? { reminderSent: false } : {})
      };

      tx.update(meetingRef, firestorePatch);

      const updatedMeeting = {
        ...meeting,
        ...sanitizedUpdates,
        responses: nextResponses,
        status: nextStatus,
        updateVersion: nextVersion
      };

      return { ok: true, updatedMeeting, scheduleChanged, nextVersion };
    });

    if (txResult.errorStatus) {
      return res.status(txResult.errorStatus).json({ error: txResult.error });
    }
    if (txResult.unchanged) {
      return res.status(200).json({ success: true, unchanged: true });
    }

    const { updatedMeeting, scheduleChanged, nextVersion } = txResult;
    const others = (updatedMeeting.participants || []).filter(p => p !== uid);

    for (const pid of others) {
      await db.collection('notifications').add({
        recipientId: pid,
        senderId: uid,
        type: 'meeting_updated',
        title: `${scheduleChanged ? 'Rescheduled' : 'Updated'}: "${updatedMeeting.title}"`,
        message: `${updatedMeeting.organizerName || 'Organizer'} updated the meeting (${updatedMeeting.date} at ${updatedMeeting.startTime}).`,
        meetingId,
        read: false,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    const tokens = await getTokensForUsers(others);
    if (tokens.length > 0) {
      await sendFCMToTokens(
        tokens,
        {
          title: `🔄 Meeting ${scheduleChanged ? 'Rescheduled' : 'Updated'}: ${updatedMeeting.title}`,
          body: `${updatedMeeting.date} at ${updatedMeeting.startTime}`
        },
        { type: 'meeting_updated', meetingId }
      );
    }

    try {
      await sendGmailMeetingUpdated(updatedMeeting, meetingId, {
        version: nextVersion,
        scheduleChanged
      });
    } catch (emailErr) {
      console.error('[api/meetings/update] Gmail dispatch error:', emailErr);
    }

    return res.status(200).json({
      success: true,
      updateVersion: nextVersion,
      scheduleChanged
    });
  } catch (err) {
    console.error('update meeting error:', err);
    return res.status(err.message?.includes('token') ? 401 : 500).json({ error: err.message });
  }
}
