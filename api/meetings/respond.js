/**
 * api/meetings/respond.js — Vercel Serverless: Respond to meeting invitation
 * POST /api/meetings/respond
 * Body: { meetingId, response: 'accepted'|'rejected' }
 */

import { verifyToken, getAdminFirestore, sendFCMToTokens, getTokensForUsers } from '../_utils/admin.js';
import { sendGmailMeetingResponse, sendGmailMeetingConfirmed } from '../_utils/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;
    const { meetingId, response } = req.body;

    if (!meetingId || !['accepted', 'rejected'].includes(response)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
    const meetingRef = db.doc(`meetings/${meetingId}`);
    const snap = await meetingRef.get();

    if (!snap.exists) return res.status(404).json({ error: 'Meeting not found' });
    const meeting = snap.data();
    if (!meeting.participants.includes(uid)) return res.status(403).json({ error: 'Not a participant' });

    const updatedResponses = { ...meeting.responses, [uid]: response };
    const allAccepted = meeting.participants.every(p => updatedResponses[p] === 'accepted');
    const newStatus = allAccepted ? 'confirmed' : meeting.status;
    const statusTransitionToConfirmed = allAccepted && meeting.status !== 'confirmed';

    await meetingRef.update({
      [`responses.${uid}`]: response,
      status: newStatus,
      updatedAt: FieldValue.serverTimestamp()
    });

    // Notify organizer with duplicate check
    const participantNames = meeting.participantNames || {};
    const myName = participantNames[uid] || decoded.name || 'A participant';
    const notifType = response === 'accepted' ? 'meeting_accepted' : 'meeting_rejected';
    
    const existingOrgNotif = await db.collection('notifications')
      .where('recipientId', '==', meeting.organizerUid)
      .where('meetingId', '==', meetingId)
      .where('senderId', '==', uid)
      .where('type', '==', notifType)
      .limit(1)
      .get();

    if (existingOrgNotif.empty) {
      await db.collection('notifications').add({
        recipientId: meeting.organizerUid,
        senderId: uid,
        type: notifType,
        title: `${myName} ${response === 'accepted' ? 'accepted' : 'declined'} "${meeting.title}"`,
        message: `Response for meeting on ${meeting.date}`,
        meetingId,
        read: false,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    // Send email notification to organizer from responder's Gmail (non-blocking)
    try {
      await sendGmailMeetingResponse(meeting, meetingId, uid, response);
    } catch (emailErr) {
      console.error('[api/meetings/respond] Organizer email dispatch error:', emailErr);
    }

    // If all accepted and transitioned to confirmed, notify all participants
    if (statusTransitionToConfirmed) {
      for (const pid of meeting.participants) {
        if (pid !== uid) {
          const existingConfNotif = await db.collection('notifications')
            .where('recipientId', '==', pid)
            .where('meetingId', '==', meetingId)
            .where('type', '==', 'meeting_confirmed')
            .limit(1)
            .get();

          if (existingConfNotif.empty) {
            await db.collection('notifications').add({
              recipientId: pid,
              senderId: uid,
              type: 'meeting_confirmed',
              title: `"${meeting.title}" is confirmed!`,
              message: `All participants accepted. Meeting on ${meeting.date} at ${meeting.startTime}.`,
              meetingId,
              read: false,
              createdAt: FieldValue.serverTimestamp()
            });
          }
        }
      }

      const tokens = await getTokensForUsers(meeting.participants.filter(p => p !== uid));
      if (tokens.length > 0) {
        await sendFCMToTokens(tokens,
          { title: `🎉 Meeting Confirmed: ${meeting.title}`, body: `See you on ${meeting.date} at ${meeting.startTime}!` },
          { type: 'meeting_confirmed', meetingId }
        );
      }

      // Send confirmed email to all participants from organizer's connected Gmail (non-blocking)
      try {
        await sendGmailMeetingConfirmed(meeting, meetingId);
      } catch (emailErr) {
        console.error('[api/meetings/respond] Confirmed email dispatch error:', emailErr);
      }
    }

    return res.status(200).json({ success: true, allAccepted, newStatus });
  } catch (err) {
    console.error('respond meeting error:', err);
    return res.status(err.message.includes('token') ? 401 : 500).json({ error: err.message });
  }
}
