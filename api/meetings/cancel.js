/**
 * api/meetings/cancel.js — Vercel Serverless: Cancel a meeting
 * POST /api/meetings/cancel
 * Body: { meetingId }
 */

import { verifyToken, getAdminFirestore, sendFCMToTokens, getTokensForUsers } from '../_utils/admin.js';
import { sendGmailMeetingCancelled } from '../_utils/gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const decoded = await verifyToken(req);
    const uid = decoded.uid;
    const { meetingId } = req.body;

    if (!meetingId) return res.status(400).json({ error: 'meetingId required' });

    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
    const meetingRef = db.doc(`meetings/${meetingId}`);
    const snap = await meetingRef.get();

    if (!snap.exists) return res.status(404).json({ error: 'Meeting not found' });
    const meeting = snap.data();
    if (meeting.organizerUid !== uid) return res.status(403).json({ error: 'Only organizer can cancel' });

    await meetingRef.update({
      status: 'cancelled',
      updatedAt: FieldValue.serverTimestamp()
    });

    // Notify all other participants with duplicate check
    const others = (meeting.participants || []).filter(p => p !== uid);
    for (const pid of others) {
      const existingCancelNotif = await db.collection('notifications')
        .where('recipientId', '==', pid)
        .where('meetingId', '==', meetingId)
        .where('type', '==', 'meeting_cancelled')
        .limit(1)
        .get();

      if (existingCancelNotif.empty) {
        await db.collection('notifications').add({
          recipientId: pid,
          senderId: uid,
          type: 'meeting_cancelled',
          title: `"${meeting.title}" has been cancelled`,
          message: `The meeting scheduled on ${meeting.date} was cancelled by the organizer.`,
          meetingId,
          read: false,
          createdAt: FieldValue.serverTimestamp()
        });
      }
    }

    const tokens = await getTokensForUsers(others);
    if (tokens.length > 0) {
      await sendFCMToTokens(tokens,
        { title: `❌ Meeting Cancelled: ${meeting.title}`, body: `The meeting on ${meeting.date} has been cancelled.` },
        { type: 'meeting_cancelled', meetingId }
      );
    }

    // Send email cancellation to all participants via organizer's Gmail (non-blocking)
    try {
      await sendGmailMeetingCancelled(meeting, meetingId);
    } catch (emailErr) {
      console.error('[api/meetings/cancel] Cancelled email dispatch error:', emailErr);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('cancel meeting error:', err);
    return res.status(err.message.includes('token') ? 401 : 500).json({ error: err.message });
  }
}
