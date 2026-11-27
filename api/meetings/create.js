/**
 * api/meetings/create.js — Vercel Serverless: Create a meeting
 * POST /api/meetings/create
 * Body: { meetingData: { ... } }
 */

import { verifyToken, getAdminFirestore, sendFCMToTokens, getTokensForUsers } from '../_utils/admin.js';
import { sendGmailMeetingInvites } from '../_utils/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;
    const { meetingData } = req.body;
    let meetingId = req.body.meetingId;

    if (!meetingData || !meetingData.title || !meetingData.participants?.length) {
      return res.status(400).json({ error: 'Missing required meeting fields' });
    }

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;

    const participants = meetingData.participants;
    if (!participants.includes(uid)) participants.unshift(uid);

    const responses = {};
    participants.forEach(pid => { responses[pid] = pid === uid ? 'accepted' : 'pending'; });

    let finalMeetingData = meetingData;

    if (meetingId) {
      const meetingRef = db.doc(`meetings/${meetingId}`);
      const snap = await meetingRef.get();
      if (!snap.exists) {
        await meetingRef.set({
          ...meetingData,
          participants,
          responses,
          organizerUid: uid,
          status: 'pending',
          reminderSent: false,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      } else {
        finalMeetingData = { ...snap.data(), ...meetingData };
      }
    } else {
      const meetingRef = await db.collection('meetings').add({
        ...meetingData,
        participants,
        responses,
        organizerUid: uid,
        status: 'pending',
        reminderSent: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      meetingId = meetingRef.id;
    }

    // Create in-app notifications for participants (except organizer) with duplicate check
    const others = participants.filter(p => p !== uid);
    for (const pid of others) {
      const existingSnap = await db.collection('notifications')
        .where('recipientId', '==', pid)
        .where('meetingId', '==', meetingId)
        .where('type', '==', 'meeting_invite')
        .limit(1)
        .get();

      if (existingSnap.empty) {
        await db.collection('notifications').add({
          recipientId: pid,
          senderId: uid,
          type: 'meeting_invite',
          title: `Meeting invite: "${meetingData.title}"`,
          message: `${meetingData.organizerName || 'Someone'} invited you to a meeting on ${meetingData.date} at ${meetingData.startTime}.`,
          meetingId,
          read: false,
          createdAt: FieldValue.serverTimestamp()
        });
      }
    }

    // Send FCM push notifications to others
    const tokens = await getTokensForUsers(others);
    if (tokens.length > 0) {
      await sendFCMToTokens(tokens,
        { title: `📅 Meeting Invite: ${meetingData.title}`, body: `Scheduled for ${meetingData.date} at ${meetingData.startTime}` },
        { type: 'meeting_invite', meetingId }
      );
    }

    // Send email invitations via organizer's connected Gmail (non-blocking)
    try {
      await sendGmailMeetingInvites(finalMeetingData, meetingId);
    } catch (emailErr) {
      console.error('[api/meetings/create] Gmail dispatch error:', emailErr);
    }

    return res.status(200).json({ success: true, meetingId });
  } catch (err) {
    console.error('create meeting error:', err);
    return res.status(err.message.includes('token') ? 401 : 500).json({ error: err.message });
  }
}
