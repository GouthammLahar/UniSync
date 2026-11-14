/**
 * api/reminders/cron.js — Vercel Cron: Send meeting reminders
 * Runs every 5 minutes via vercel.json cron config.
 * Sends FCM + in-app reminders for meetings starting in 15, 30, or 60 minutes.
 */

import { getAdminFirestore, sendFCMToTokens, getTokensForUsers } from '../_utils/admin.js';

// Secret to verify this is a Vercel Cron call (optional but recommended)
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  // Verify cron authorization
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const db = getAdminFirestore();
    const FieldValue = (await import('firebase-admin/firestore')).FieldValue;

    const now = new Date();
    // IST offset = UTC+5:30
    const istOffset = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + istOffset);

    const reminderWindows = [15, 30, 60]; // minutes before meeting

    // Query upcoming confirmed meetings that haven't had reminders sent
    const snap = await db.collection('meetings')
      .where('status', '==', 'confirmed')
      .where('reminderSent', '==', false)
      .get();

    if (snap.empty) return res.status(200).json({ message: 'No meetings to remind', processed: 0 });

    let processed = 0;

    for (const docSnap of snap.docs) {
      const meeting = docSnap.data();
      const meetingId = docSnap.id;

      // Parse meeting date+time in IST
      const [y, mo, d] = (meeting.date || '').split('-').map(Number);
      const [h, m] = (meeting.startTime || '00:00').split(':').map(Number);
      if (!y || !mo || !d) continue;

      const meetingTimeIST = new Date(Date.UTC(y, mo - 1, d, h - 5, m - 30)); // Convert IST to UTC for comparison
      const diffMins = (meetingTimeIST.getTime() - now.getTime()) / 60000;

      // Check if the meeting falls within any reminder window (±3 min tolerance)
      const shouldRemind = reminderWindows.some(w => diffMins >= (w - 3) && diffMins <= (w + 3));

      if (!shouldRemind) continue;

      const participants = meeting.participants || [];
      const nearestWindow = reminderWindows.find(w => diffMins >= (w - 3) && diffMins <= (w + 3));

      // Create in-app reminder notifications for all participants
      for (const pid of participants) {
        await db.collection('notifications').add({
          recipientId: pid,
          senderId: meeting.organizerUid,
          type: 'meeting_reminder',
          title: `⏰ Reminder: "${meeting.title}" in ${nearestWindow} min`,
          message: `Your meeting starts at ${meeting.startTime}${meeting.location ? ' at ' + meeting.location : ''}.`,
          meetingId,
          read: false,
          createdAt: FieldValue.serverTimestamp()
        });
      }

      // Send FCM push reminders
      const tokens = await getTokensForUsers(participants);
      if (tokens.length > 0) {
        await sendFCMToTokens(tokens,
          {
            title: `⏰ Meeting in ${nearestWindow} min: ${meeting.title}`,
            body: `Starting at ${meeting.startTime}${meeting.location ? ' · ' + meeting.location : ''}`
          },
          { type: 'meeting_reminder', meetingId }
        );
      }

      // Mark reminder as sent to prevent duplicates
      await docSnap.ref.update({ reminderSent: true });
      processed++;
    }

    return res.status(200).json({ message: 'Reminders processed', processed });
  } catch (err) {
    console.error('cron reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
}
