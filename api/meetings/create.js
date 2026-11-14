/**
 * api/meetings/create.js — Vercel Serverless: Create a meeting
 * POST /api/meetings/create
 * Body: { meetingData: { ... } }
 */

import { verifyToken, getAdminFirestore, sendFCMToTokens, getTokensForUsers } from '../_utils/admin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;
    const { meetingData } = req.body;

    if (!meetingData || !meetingData.title || !meetingData.participants?.length) {
      return res.status(400).json({ error: 'Missing required meeting fields' });
    }

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;

    const participants = meetingData.participants;
    if (!participants.includes(uid)) participants.unshift(uid);

    const responses = {};
    participants.forEach(pid => { responses[pid] = pid === uid ? 'accepted' : 'pending'; });

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

    // Create in-app notifications for participants (except organizer)
    const others = participants.filter(p => p !== uid);
    for (const pid of others) {
      await db.collection('notifications').add({
        recipientId: pid,
        senderId: uid,
        type: 'meeting_invite',
        title: `Meeting invite: "${meetingData.title}"`,
        message: `${meetingData.organizerName || 'Someone'} invited you to a meeting on ${meetingData.date} at ${meetingData.startTime}.`,
        meetingId: meetingRef.id,
        read: false,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    // Send FCM push notifications to others
    const tokens = await getTokensForUsers(others);
    if (tokens.length > 0) {
      await sendFCMToTokens(tokens,
        { title: `📅 Meeting Invite: ${meetingData.title}`, body: `Scheduled for ${meetingData.date} at ${meetingData.startTime}` },
        { type: 'meeting_invite', meetingId: meetingRef.id }
      );
    }

    return res.status(200).json({ success: true, meetingId: meetingRef.id });
  } catch (err) {
    console.error('create meeting error:', err);
    return res.status(err.message.includes('token') ? 401 : 500).json({ error: err.message });
  }
}
