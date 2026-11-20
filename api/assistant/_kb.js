/**
 * api/assistant/_kb.js
 * Verified knowledge base for UniSync features and navigation.
 * All answers are factual and match the current UniSync codebase exactly.
 */

export const KNOWLEDGE_BASE = {
  squads: {
    title: 'Squads & Circles',
    answer: `**Managing Campus Squads in UniSync:**
1. **Create a Squad:** Go to **My Squads** in the top navigation or account dropdown. Enter your group name (e.g., "CS Section B") and tap **Create Squad**. UniSync generates a private 6-character code (e.g., \`CLA-1234\`).
2. **Join a Squad:** On the **My Squads** page, paste the 6-character code given by your friend and tap **Join Squad**.
3. **Switch Active Squad:** Use the squad dropdown selector in the top-left navigation bar to switch your active squad at any time.`
  },
  timetable: {
    title: 'Timetable Import & Management',
    answer: `**Managing Your Timetable in UniSync:**
1. **Excel Import:** Go to **My Timetable** and drag & drop your university Excel sheet (\`.xlsx\`). UniSync automatically parses your periods, course codes, and classrooms into an interactive preview table.
2. **Manual Entry:** Click **+ Add Class Manually** to add individual periods with custom start and end times (e.g. 08:30–09:20), day of the week, subject, room, and type (Lecture, Tutorial, Lab).
3. **Save:** After verifying or modifying any cell in the table editor, click **✓ Looks good, Save Timetable**.`
  },
  friends: {
    title: 'Finding Friends & Comparing Schedules',
    answer: `**Find Friends & Compare Free Time:**
1. Navigate to **Find Friends** from the navigation bar.
2. Search squad members by name or nickname.
3. Click on any friend's card to view their weekly timetable.
4. Click **⚡ Compare Free Time with Me** to view common free periods side-by-side.`
  },
  meetings: {
    title: 'Scheduling Meetings',
    answer: `**Coordinating Meetings in UniSync:**
1. Go to **Meetings** from the navigation bar.
2. Click **+ Schedule Meeting**.
3. Fill in meeting details (Title, Type: Group/Friend, Duration, Preferred Day).
4. Tap **🔍 Find Available Slots** — UniSync calculates exact mutual free intervals across all selected members so no one has class.
5. Choose a recommended slot and tap **Send Invitations**. Participants receive instant notifications and can accept or decline.`
  },
  free_time: {
    title: 'Free Slots Engine',
    answer: `**Free-Time Discovery:**
1. Visit **Free Slots** from the navigation bar.
2. Select any combination of squad friends.
3. UniSync's convergence engine checks overlapping 45m, 50m, and 60m class blocks and highlights uninterrupted time windows where everyone is out of class.`
  },
  privacy: {
    title: 'Campus Privacy & Data Security',
    answer: `**Privacy & Data Protection in UniSync:**
- Schedules are isolated strictly inside private, invite-only squads.
- Firestore security rules ensure that only verified members of your active squad can read your timetable.
- No public search or global user directories exist.
- When you leave a squad, your schedule document in that squad is immediately deleted.`
  },
  general: {
    title: 'Welcome to UniSync',
    answer: `**UniSync** is your campus timetable collaboration and free-time discovery hub.
- **My Timetable:** Import via Excel (.xlsx) or add classes manually.
- **Free Slots:** Discover mutual free windows with friends.
- **Squad:** Check real-time presence and live period status across your group.
- **Meetings:** Propose meeting times that automatically avoid everyone's classes.
- **Find Friends:** Search squad peers and compare schedules.`
  }
};

export function getHelpResponse(topic) {
  const item = KNOWLEDGE_BASE[topic] || KNOWLEDGE_BASE.general;
  return item.answer;
}
