# 🎯 Telegram Habit Tracker (Bento Edition)

> **A beautiful, offline-first habit tracking webapp designed exclusively for Telegram Mini Apps.**

Built with vanilla JavaScript, this lightweight habit tracker combines iOS-native UX patterns with powerful offline capabilities. Track habits, visualize progress with heatmaps, and stay motivated with social accountability features — all from within Telegram.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Telegram](https://img.shields.io/badge/platform-Telegram%20Mini%20App-26A5E4)

---

## ✨ Features

### 🔲 **Bento Grid Dashboard**
- **iOS-inspired card layout** with smooth 60fps animations
- **Three habit types:**
  - ✅ **Boolean** (Done/Skip/Undo)
  - 🔢 **Counter** (track water intake, steps, etc.)
  - ⏱ **Timer** (focus sessions, meditation)
- **Drag & Drop reordering** with SortableJS (native iOS feel)
- **Hero card** displaying daily progress

### 📴 **Offline-First Architecture**
- **Instant loading** from localStorage cache
- **Background revalidation** from API
- **Optimistic UI updates** with automatic rollback on failure
- **Works offline** — syncs when connection returns

### 🎨 **Premium UX**
- **Haptic feedback** (leverages Telegram WebApp API)
- **Adaptive dark/light mode** (follows Telegram theme)
- **Glassmorphism** design with backdrop-filter
- **Touch-optimized** with 250ms drag delay to prevent scroll conflicts
- **5-minute rule modal** — encourages micro-progress over skipping

### 📊 **Progress Tracking**
- **60-day heatmap** with color-coded completion percentage
- **Daily stats strip** with animated progress bar
- **Streak tracking** (coming soon: freeze feature)
- **Confetti animation** on 100% daily completion 🎉

### 👥 **Social Accountability (Phase 4)**
- **Social Shame mode** — share your progress (or lack thereof) with friends
- **Telegram-native sharing** via WebApp API

---

## 🚀 Quick Start

### Deploy to GitHub Pages

1. **Fork this repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/habit-tracker.git
   cd habit-tracker
   ```

2. **Enable GitHub Pages**
   - Go to **Settings** → **Pages**
   - Source: **Deploy from a branch**
   - Branch: `main` → `/public/webapp/v2`
   - Save

3. **Your WebApp URL will be:**
   ```
   https://YOUR_USERNAME.github.io/habit-tracker/
   ```

4. **Link to Telegram Bot** (see below ⬇️)

---

## 🤖 Telegram Bot Setup

### Step 1: Create Your Bot
1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot` and follow the prompts
3. Copy your **Bot Token** (e.g., `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

### Step 2: Set Up Mini App
1. Send `/newapp` to BotFather
2. Select your bot
3. **Web App URL:** Paste your GitHub Pages URL from above
   ```
   https://YOUR_USERNAME.github.io/habit-tracker/
   ```
4. **Short Name:** `habits` (or your choice)
5. **Description:** "Track your daily habits with a beautiful Bento Grid interface"
6. **Photo:** Upload a 512x512 icon (optional)

### Step 3: Launch Your WebApp
- Open your bot in Telegram
- Tap the **Menu button** (☰) or send `/start`
- Select your WebApp from the menu
- **Done!** 🎉

---

## 📁 Project Structure

```
public/webapp/v2/
├── index.html              # App shell (minimal skeleton)
├── app.css                 # Base design tokens & layout
│
├── modules/
│   ├── app.js             # Entry point, boot sequence, event wiring
│   ├── store.js           # State management (Redux-like)
│   ├── renderer.js        # DOM reconciliation & rendering
│   ├── interactions.js    # Event delegation (tap, long-press, keyboard)
│   ├── api.js             # REST client with retry logic
│   ├── utils.js           # Haptic, date helpers, throttle/debounce
│   ├── settings.js        # Settings panel logic
│   │
│   ├── features/
│   │   ├── drag-drop.js   # SortableJS integration
│   │   ├── social-shame.js# Social sharing feature
│   │   ├── heatmap.js     # 60-day completion heatmap
│   │   └── confetti.js    # Celebration animation
│   │
│   └── css/
│       ├── animations.css # Keyframes, transitions
│       ├── bento-grid.css # Grid layout, card styles
│       ├── cards.css      # Habit card variants
│       ├── components.css # Buttons, inputs, chips
│       ├── modals.css     # Sheets, dialogs, overlays
│       └── features.css   # Focus mode, heatmap, settings
```

---

## 🛠 Tech Stack

| Category | Technology |
|----------|-----------|
| **Frontend** | Vanilla JavaScript (ES6 modules) |
| **State** | Custom Redux-like store with optimistic UI |
| **Styling** | CSS Custom Properties + Glassmorphism |
| **Animations** | Native CSS transitions + Confetti.js |
| **Drag & Drop** | [SortableJS](https://sortablejs.github.io/Sortable/) (1.15.2) |
| **Platform** | [Telegram Mini Apps](https://core.telegram.org/bots/webapps) |
| **Storage** | localStorage (offline-first cache) |
| **Deployment** | GitHub Pages (static hosting) |

**No build step required** — pure ES6 modules, runs directly in browser.

---

## 🎯 How It Works

### Boot Sequence (Offline-First)
```javascript
1. Telegram.WebApp.ready() → Expand viewport
2. Load from localStorage cache → Instant UI (skeleton skipped)
3. Fetch from API (background revalidation)
4. API data wins → Update store → Re-render → Save to cache
5. If offline → Work with cached data, show toast
```

### Optimistic UI Pattern
```javascript
User taps habit card
  ↓
Dispatch OPTIMISTIC_APPLY → UI updates instantly
  ↓
API call (sendHabitIntent)
  ↓
Success → FINALIZE (sync server state)
Failure → ROLLBACK (restore previous state) + Toast with Retry
```

### Drag & Drop (iOS Native Feel)
- **250ms delay** — prevents accidental drag on scroll
- **15px touch threshold** — requires 15px movement to start drag (was 5px)
- **touch-action: pan-y** on cards — allows vertical scroll, blocks horizontal pan
- **swapThreshold: 0.65** — requires 65% overlap for smoother grid swaps
- **Haptic feedback** on drag start/end (no spam on onChange)

---

## 🎨 Design Philosophy

### Glassmorphism
```css
backdrop-filter: blur(24px) saturate(180%);
background: rgba(17, 24, 39, 0.55);
border: 1px solid rgba(255, 255, 255, 0.08);
```

### Telegram Theme Adaptation
The app automatically adapts to Telegram's light/dark theme:
```css
--bg:   var(--tg-theme-bg-color,   #0b0f17);  /* Telegram injects this */
--text: var(--tg-theme-text-color, #eef2f7);  /* Fallback for standalone */
```
No JS, no `@media (prefers-color-scheme)` — pure CSS custom property aliasing.

### Haptic Feedback Levels
```javascript
haptic('light')     // Tap feedback
haptic('selection') // Toggle, confirm
haptic('medium')    // Long-press, drag start
haptic('success')   // Habit completed
haptic('error')     // API failure
```

---

## 🔧 Configuration

### API Endpoint
By default, the app expects your backend at `/api/`. To change:

**Edit `modules/api.js`:**
```javascript
const API_BASE = '/api';  // Change to 'https://your-backend.com/api'
```

### Cache Settings
**Edit `modules/store.js`:**
```javascript
const SAVE_DEBOUNCE_MS = 1000;  // Cache save delay (1s)
const CACHE_VERSION = 1;        // Increment to invalidate old cache
```

### Drag & Drop Tuning
**Edit `modules/features/drag-drop.js`:**
```javascript
delay: 250,                 // Drag delay (ms)
touchStartThreshold: 15,    // Movement threshold (px)
swapThreshold: 0.65,        // Overlap required for swap (0-1)
```

---

## 📱 Platform Requirements

- **Telegram** 6.0+ (Mini Apps support)
- **Modern browser** with ES6 modules support
  - Chrome 61+
  - Safari 11+
  - Firefox 60+
- **localStorage** enabled (≈5MB available)

---

## 🐛 Troubleshooting

### "This WebApp only works inside Telegram"
- The app detects `window.Telegram.WebApp`
- If missing, it shows an overlay and hides the app
- **Solution:** Open via Telegram bot menu (see setup above)

### Drag & Drop not working
- **Check SortableJS CDN:** `index.html` line 27
- **Verify grid element:** `#bento-grid` should exist
- **Console errors:** Open DevTools → Check for `[DragDrop]` errors

### Offline mode not persisting
- **Check localStorage quota:** `localStorage.length` in DevTools
- **Incognito/Private mode:** localStorage is disabled
- **Cache version mismatch:** Increment `CACHE_VERSION` in `store.js`

### Haptic feedback not working
- **Desktop browser:** Haptics require mobile Telegram (iOS/Android)
- **Web version:** `Telegram.WebApp.HapticFeedback` is not available

---

## 🚧 Roadmap

- [ ] **Freeze streaks** (planned — 🧊 button in context menu)
- [ ] **Habit editing** in UI (currently DB-only)
- [ ] **Custom routines** builder
- [ ] **Notifications** via Telegram Bot API
- [ ] **Export/Import** habits (JSON)
- [ ] **Multi-language** support (currently Ukrainian)

---

## 📄 License

MIT License — feel free to fork, modify, and deploy your own version!

---

## 🙏 Credits

- **Design inspiration:** iOS Widgets, Linear.app, Raycast
- **Icons:** Emoji (native system fonts)
- **Fonts:** [Inter](https://rsms.me/inter/) (Google Fonts CDN)
- **Libraries:**
  - [SortableJS](https://github.com/SortableJS/Sortable) (MIT)
  - [canvas-confetti](https://github.com/catdad/canvas-confetti) (ISC)

---

## 💬 Support

**Issues?** Open an issue on GitHub.
**Questions?** Reach out via Telegram: [@your_username](https://t.me/your_username)

---

<div align="center">

**Built with ❤️ for the Telegram ecosystem**

[⭐ Star this repo](https://github.com/YOUR_USERNAME/habit-tracker) • [🐛 Report a bug](https://github.com/YOUR_USERNAME/habit-tracker/issues) • [💡 Request a feature](https://github.com/YOUR_USERNAME/habit-tracker/issues)

</div>
