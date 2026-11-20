# UniSync — Different schedules. Shared moments.

[![Live Application](https://img.shields.io/badge/Live%20Demo-unisync--live.vercel.app-2ea44f?style=for-the-badge&logo=vercel)](https://unisync-live.vercel.app/)
[![Progressive Web App](https://img.shields.io/badge/PWA-Configured%20for%20Android%20%26%20Desktop-536B5B?style=for-the-badge&logo=pwa)](https://unisync-live.vercel.app/)
[![Firebase](https://img.shields.io/badge/Backend-Firebase%20Auth%20%7C%20Firestore%20%7C%20FCM-FFA611?style=for-the-badge&logo=firebase&logoColor=black)](https://firebase.google.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

> A modern, privacy-focused campus schedule convergence platform designed to discover mutual free periods across fragmented university timetables, organize campus squads, schedule meetings, and collaborate effortlessly in real time.

---

## 📌 Project Overview

**UniSync** is a university scheduling and peer collaboration web application tailored for college campuses. In higher education environments, student peers frequently belong to different course batches, sections, and elective tracks, each with alternating lecture timings (e.g., 50-minute vs. 60-minute periods), lab blocks, and lunch intervals. Finding common free windows for study sessions, project collaboration, or meals traditionally involves cross-referencing multiple timetable spreadsheets or screenshots manually.

UniSync solves this by converting class schedules into normalized time intervals and executing set-intersection math to identify mutual free windows across private student squads. It also supports formal meeting coordination, in-app notifications, background push alerts, and an integrated campus query assistant.

* **Live Deployment**: [https://unisync-live.vercel.app/](https://unisync-live.vercel.app/)
* **Platform Compatibility**: Modern Web Browsers (Desktop & Mobile) and configured Progressive Web App (PWA).

---

## 🎯 Problem Statement & Solution

### The Campus Problem
* **Asynchronous Class Timings**: University schedules alternate between single lecture slots and multi-hour laboratory blocks, causing misalignment between friends across sections.
* **Coordination Overhead**: Students spend considerable time in group chats asking *"Are you free this period?"* or *"When can we all meet?"*.
* **Scattered Timetable Formats**: Timetables are typically published in complex Excel workbooks or university portal tables that cannot be readily compared.

### The UniSync Solution
* **Client-Side Timetable Ingestion**: Ingests university Excel exports (specifically tailored for Lovely Professional University format) and offers a manual slot editor with client-side validation.
* **Deterministic Free-Time Intersection Engine**: High-performance interval math that scans overlapping member schedules and calculates exact shared windows (down to specific minutes and day-wise filters).
* **Invite-Only Campus Squads**: Access control restricting timetable visibility, squad chat, and member lists strictly to verified squad members.
* **Meeting & Notification Workflows**: Centralized meeting creation, RSVP response tracking (accept/decline), in-app notification dropdown with badge counts, and FCM background push notifications.
* **Hybrid Assistant Architecture**: An in-app campus assistant that interprets natural language queries using Gemini for intent classification while resolving all timetable math on the server without sending timetable documents to external APIs.

---

## 🚀 Key Implemented Features

### 1. Timetable Parsing & Flexible Entry
* **Automated Excel Parser**: Ingests official university timetable Excel sheets client-side using `SheetJS (xlsx)` with automatic slot extraction, room assignment, subject tagging, and timing normalization.
* **Manual Period Builder**: Add, edit, or adjust individual courses, lunch breaks, and labs across Monday through Saturday with instantaneous validation.

### 2. Schedule Convergence & Common Free Slots Engine
* Computes mutual free windows among selected squad members or the entire squad.
* Supports **Day-wise Filtering** and **Duration Thresholds** (filtering shared periods $\ge 60$ minutes).
* Displays exact starting/ending times along with member availability badges.

### 3. "Right Now" Live Campus Tracker
* Real-time period resolution engine comparing current wall-clock time against squad timetables.
* Instantly categorizes squad peers into:
  * 🟢 **Free Now**: Currently not attending any scheduled lecture or lab.
  * 🔴 **In Class**: Displays ongoing course name, room/venue code, and remaining time until dismissal.
  * 🟡 **Next Upcoming**: Shows the next scheduled class and countdown.

### 4. Private Campus Squads & Role Controls
* Create private squads with generated 6-character alphanumeric squad codes.
* Join existing squads via invite codes.
* Granular role management: Squad owner permissions (regenerate join codes, kick members, or disband squads).
* Real-time roster updates powered by Firestore document snapshot listeners.

### 5. In-Squad Real-Time Chat
* Fast, lightweight squad discussion channel built directly over Firestore subcollections (`/groups/{groupId}/messages`).
* Strict security validation: verified sender UID, character limits (1–500 chars), non-empty validation, and server-generated timestamps.
* Real-time message streaming with automatic listener teardown when navigating away to conserve database operations.

### 6. Campus Meetings & In-App Notifications
* **Meeting Scheduling**: Organizers select squad members, specify meeting title, description, date, time window, and location.
* **RSVP Tracking**: Invitees accept or decline with atomic participant status updates (`responses` map).
* **In-App Notification Bell**: Dedicated notification bell with unread counters, click-to-navigate deep links, and batch "Mark all read" controls.

### 7. Campus Assistant (Hybrid Architecture)
* Natural language campus bot capable of answering:
  * *"Who is free right now?"*
  * *"When is our squad free tomorrow?"*
  * *"What is my next class?"*
* **Intent-Only Processing**: The assistant backend (`api/assistant/chat.js` and `_nlu.js`) uses Gemini solely to classify the query intent into a structured schema (e.g., `FIND_COMMON_SQUAD_AVAILABILITY`). Student timetable documents and squad schedules are never forwarded to the Gemini API.
* **Deterministic Server-Side Resolution**: All timetable calculations and availability searches are executed deterministically on the Vercel serverless backend using Firestore data.
* **Deterministic Fallback**: When the Gemini API key is unset, disabled, or rate-limited, the system automatically falls back to an internal rule-based regex intent matcher.

### 8. Progressive Web App (PWA) Configuration
* Web App Manifest served from root (`/manifest.json`) specifying `standalone` display and theme color `#536B5B`.
* Standard launcher icons: `icon-192.png` and `icon-512.png` with `purpose: "any"`.
* Dedicated maskable icon: `icon-maskable-512.png` scaled with safe-zone margin on a `#F7F5EF` background with `purpose: "maskable"`.
* Service Worker (`firebase-messaging-sw.js`) registered under root scope `/` with `skipWaiting()` and `clients.claim()` for immediate client control, alongside background Firebase Cloud Messaging handlers.

---

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| **Frontend Core** | Vanilla JavaScript (ES Modules), HTML5, Modern CSS3 (Variables, Flexbox, Grid, Stacking contexts) |
| **Tooling & Bundler** | [Vite 5](https://vitejs.dev/) |
| **Authentication** | [Firebase Authentication](https://firebase.google.com/products/auth) (Google OAuth 2.0 Sign-In) |
| **Database & Realtime** | [Cloud Firestore](https://firebase.google.com/products/firestore) (Live snapshot listeners, batch writes, atomic transactions) |
| **Push Notifications** | [Firebase Cloud Messaging (FCM)](https://firebase.google.com/products/cloud-messaging) & Web Push API (Service Worker) |
| **Spreadsheet Engine** | [SheetJS (xlsx)](https://docs.sheetjs.com/) for client-side timetable extraction |
| **Serverless Backend** | [Vercel Serverless Functions](https://vercel.com/docs/functions) (Node.js runtime with Firebase Admin SDK) |
| **AI / NLU** | [Google Gemini API](https://ai.google.dev/) (`gemini-2.5-flash`) for query intent classification only |
| **Hosting & CI/CD** | [Vercel](https://vercel.com/) with automated Git branch deployments |

---

## 🖼️ Application Artwork & Design Assets

UniSync uses a cohesive editorial design language featuring responsive cards, soft green accents, and Fraunces & Plus Jakarta Sans typography.

| Visual Asset | Location | Purpose |
|---|---|---|
| **Brand Icon** | `logo-icon.svg` | Lightweight vector branding used in navigation headers |
| **Full App Logo** | `logo.png` | High-resolution branding asset |
| **PWA Launcher Icon** | `public/icons/icon-192.png` | Standard 192×192 home-screen app icon |
| **High-Res App Icon** | `public/icons/icon-512.png` | High-density 512×512 display icon |
| **Adaptive Maskable Icon** | `public/icons/icon-maskable-512.png` | Safe-zone padded maskable icon for Android launchers |

---

## 🏗️ System Architecture & Workflow

```mermaid
flowchart TD
    subgraph Client ["Client Layer (Browser / PWA)"]
        UI["Web Interface\n(Vite + Vanilla JS + CSS3)"]
        Parser["Timetable Parser\n(SheetJS Client-side)"]
        Engine["Convergence Engine\n(Interval Set Intersection)"]
        SW["Service Worker\n(firebase-messaging-sw.js)"]
    end

    subgraph Firebase ["Firebase Managed Services"]
        Auth["Firebase Authentication\n(Google Sign-In)"]
        Firestore[("Cloud Firestore\n(Schedules, Squads, Messages, Meetings)")]
        FCM["Firebase Cloud Messaging\n(Web Push Protocol)"]
    end

    subgraph Serverless ["Vercel Serverless Functions (Node.js)"]
        API_Meet["Meetings APIs\n(/api/meetings/*)"]
        API_Notif["Notifications API\n(/api/notifications/*)"]
        API_Cron["Reminder Cron\n(/api/reminders/cron)"]
        API_Bot["Assistant API\n(/api/assistant/chat)"]
        Logic["Deterministic Schedule Logic\n(_logic.js)"]
        AdminSDK["Firebase Admin SDK"]
    end

    subgraph External ["External AI Service"]
        Gemini["Google Gemini API\n(Intent Classification Only)"]
    end

    UI -->|Sign In / Token| Auth
    UI -->|Parse Excel| Parser
    Parser -->|Write User Timetable| Firestore
    UI -->|Listen Realtime Updates| Firestore
    UI -->|Compute Local Free Slots| Engine
    SW -->|Handle Background Push| FCM

    UI -->|Meeting CRUD & RSVPs| API_Meet
    UI -->|Register Push Token| API_Notif
    UI -->|Natural Language Query| API_Bot

    API_Meet --> AdminSDK
    API_Notif --> AdminSDK
    API_Cron --> AdminSDK
    AdminSDK -->|Atomic Writes & Queries| Firestore
    AdminSDK -->|Send Push Messages| FCM

    API_Bot -->|1. Extract Query Intent| Gemini
    API_Bot -->|2. Query Schedules (Server-side)| AdminSDK
    API_Bot -->|3. Evaluate Free Slots| Logic
    Logic -->|4. Return Resolved Answer| UI
```

### Security & Access Control Model
* **Squad Scoping (`firestore.rules`)**:
  * `/groups/{groupId}/schedules/{uid}`: Read-accessible only if the requesting user's UID exists in the squad's `/members` subcollection. Writes are restricted strictly to the authenticated student for their own schedule document.
  * `/groups/{groupId}/messages/{messageId}`: Read and create allowed solely for confirmed squad members, with schema validations on message size, non-empty text, and server timestamp equality.
* **Meeting Privacy**: `/meetings/{meetingId}` documents are readable and editable (for responses) only by authenticated users explicitly listed in the meeting's `participants` array.
* **Assistant Isolation**: `/assistantUsage/{usageId}` documents are completely blocked (`allow read, write: if false;`) from client-side access and managed strictly via the server-side Firebase Admin SDK.

---

## 📂 Project Folder Structure

```tree
Unisync/
├── api/                           # Vercel Serverless Functions (Node.js)
│   ├── _utils/
│   │   └── admin.js               # Firebase Admin SDK initialization & token verification
│   ├── assistant/
│   │   ├── _date.js               # Campus date & time normalization helpers
│   │   ├── _kb.js                 # Campus knowledge base rules
│   │   ├── _logic.js              # Deterministic schedule resolution logic
│   │   ├── _nlu.js                # Gemini intent extraction & deterministic fallback
│   │   ├── _rate-limit.js         # Firestore transaction-based rate limiters
│   │   └── chat.js                # Assistant chat endpoint (/api/assistant/chat)
│   ├── meetings/
│   │   ├── cancel.js              # Meeting cancellation API
│   │   ├── create.js              # Meeting creation API
│   │   └── respond.js             # RSVP response API (accept/decline)
│   ├── notifications/
│   │   ├── register-token.js      # Device FCM token registration
│   │   └── test.js                # Push notification diagnostic test
│   └── reminders/
│       └── cron.js                # Daily scheduled reminder runner
├── public/                        # Static assets served at domain root
│   ├── firebase-messaging-sw.js   # Service Worker handling background FCM notifications
│   ├── icons/                     # PWA PNG application icons
│   │   ├── icon-192.png           # 192x192 regular launcher icon
│   │   ├── icon-512.png           # 512x512 regular splash icon
│   │   └── icon-maskable-512.png  # 512x512 safe-zone padded maskable icon
│   ├── logo.png                   # Brand raster graphic
│   ├── logo-icon.svg              # Brand vector graphic
│   └── manifest.json              # Web App Manifest for PWA installation
├── app.js                         # Core client application router and UI orchestration
├── assistant.js                   # Client-side Smart Assistant drawer controller
├── config.js                      # Client-side Firebase project configuration
├── db.js                          # Client-side Firestore operations & Auth listeners
├── fcm.js                         # FCM client token management & SW registration helper
├── firebase-messaging-sw.js       # Root reference service worker
├── firestore.rules                # Production Firestore security and access rules
├── index.html                     # Single-page application entry point & semantic views
├── meetings-db.js                 # Meetings database operations & realtime listeners
├── meetings.js                    # Meetings view UI controller and modal handlers
├── notifications.js               # Notification bell UI dropdown & unread badge manager
├── schedule-utils.js              # Schedule math, slot formatters, and interval intersection
├── squad-chat.js                  # In-squad live messaging controller
├── style.css                      # Design system stylesheet & responsive media queries
├── timetable-parser.js            # SheetJS university timetable format parsing logic
├── vercel.json                    # Vercel deployment configuration & cron schedule
├── vite.config.js                 # Vite development & API proxy configuration
└── package.json                   # Dependencies and npm build scripts
```

---

## 💻 Local Installation & Setup

### Prerequisites
* **Node.js**: v18.0.0 or higher
* **npm**: v9.0.0 or higher
* A modern browser with ES module support

### Step 1: Clone Repository
```bash
git clone https://github.com/GouthammLahar/UniSync.git
cd UniSync
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Configure Environment Variables
Copy the example environment configuration:
```bash
cp .env.example .env.local
```

Populate the required keys in `.env.local` for local serverless execution (refer to the [Firebase Configuration & Environment Variables](#-firebase-configuration--environment-variables) section below).

### Step 4: Run Local Development Server
```bash
npm run dev
```

The application will be accessible at `http://localhost:5173`.

### Step 5: Build for Production
To compile the client bundle and verify production assets:
```bash
npm run build
```

Production assets are generated in `dist/`. Test the build locally with:
```bash
npm run preview
```

---

## 🔐 Firebase Configuration & Environment Variables

UniSync uses a two-tier configuration setup:
1. **Client-Side Configuration** (`config.js`): Public Firebase project keys utilized by the browser SDK for Authentication, Firestore listeners, and FCM client subscriptions.
2. **Server-Side Environment Variables**: Private service account credentials and API keys used by Vercel Serverless Functions.

### Serverless Environment Variables (`.env.local` / Vercel Dashboard)

| Variable | Required | Description |
|---|---|---|
| `FIREBASE_ADMIN_PROJECT_ID` | **Yes** | Firebase project identifier |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | **Yes** | Service account client email address |
| `FIREBASE_ADMIN_PRIVATE_KEY` | **Yes** | Service account private key string (with escaped `\n` characters) |
| `GEMINI_API_KEY` | Optional | Google Gemini API key used by the Assistant for query intent detection |
| `GEMINI_MODEL` | Optional | Model identifier (defaults to `gemini-2.5-flash`) |
| `ENABLE_GEMINI_AI` | Optional | Boolean flag (`true` or `false`) to enable/disable Gemini NLU |
| `ASSISTANT_USER_DAILY_LIMIT` | Optional | Max assistant queries permitted per user/day (default: `3`) |
| `ASSISTANT_GLOBAL_DAILY_LIMIT` | Optional | Global system-wide query cap per day (default: `300`) |

> **Security Note**: Never commit service account credentials or `.env.local` files to version control. The repository `.gitignore` explicitly excludes all local environment files.

---

## 🌐 Deployment Information

UniSync is configured for automated continuous deployment via **Vercel**.

1. **Continuous Deployment**: Pushes to `main` trigger automated builds on Vercel.
2. **Serverless Routing**: Endpoints under `api/` automatically deploy as Node.js serverless functions:
   * `/api/assistant/chat`
   * `/api/meetings/create`
   * `/api/meetings/respond`
   * `/api/meetings/cancel`
   * `/api/notifications/register-token`
3. **Daily Scheduled Cron**: Defined in `vercel.json`, Vercel invokes `/api/reminders/cron` daily at `07:00 UTC` (`0 7 * * *`) to process scheduled morning reminders.
4. **Security Rules Deployment**: Deploy Firestore security rules using the Firebase CLI:
```bash
firebase deploy --only firestore:rules
```

---

## 📱 Progressive Web App (PWA) Support

UniSync is configured with standard Progressive Web App assets and service worker capabilities:

* **Web App Manifest**: Served at `/manifest.json` with `id: "/"`, `scope: "/"`, `start_url: "/"`, and `display: "standalone"`.
* **Icon Set**: Includes `192x192` and `512x512` standard icons with `"purpose": "any"`, and an adaptive `icon-maskable-512.png` with `"purpose": "maskable"` containing safe-zone margins to prevent clipping on Android launcher shapes.
* **Service Worker Registration**: Automatically registered on page load under the root scope `/` using `skipWaiting()` and `clients.claim()` for client control.
* **Live Installation Note**: The PWA configuration is deployed to production; actual on-device WebAPK installation is pending live production verification.

---

## 🔮 Future Enhancements (Planned)

The following items are planned additions and are separate from currently implemented functionality:
* [ ] **External Calendar Sync**: Two-way synchronization with Google Calendar and Outlook Calendar via iCal feeds.
* [ ] **Multi-University Timetable Formats**: Additional parser modules for varied university timetable layouts.
* [ ] **Inter-Squad Event Discovery**: Open event discovery across campus clubs and study circles.
* [ ] **Offline Caching**: Service Worker CacheStorage strategies for viewing schedules without an active network connection.

---

## 👨‍💻 Author & Project Information

* **Developer**: Padala Gouthamm Lahar
* **Degree**: B.Tech in Computer Science and Engineering (CSE)
* **GitHub**: [@GouthammLahar](https://github.com/GouthammLahar)
* **Repository**: [https://github.com/GouthammLahar/UniSync](https://github.com/GouthammLahar/UniSync)
* **Live App**: [https://unisync-live.vercel.app/](https://unisync-live.vercel.app/)

---

*Developed with a commitment to privacy, clean code architecture, and practical campus utility.*
