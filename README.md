# Family Calendar

A simple shared calendar for one family. Everyone can add, edit, and delete personal and family activities, and see the same calendar on every device. It is a single web page plus one small server function, with no build step.

## Features

- **Month view** with previous, next, and Today buttons. Click a day to add an event, or click an event to edit or delete it.
- **Events** with a title, a start and end date, optional start and end times, a family member, and notes.
  - **All day** option that hides the time fields.
  - **Multi-day** events appear on every day they cover.
  - **Repeat** weekly or monthly, with an optional "repeat until" date.
  - **Time dropdowns** in 15-minute steps, shown as 12-hour times. Picking a start time fills in an end time one hour later.
- **Family members** with their own colors. Add, rename, recolor, or remove them, and filter the calendar by person.
- **Conflict warnings.** Any two events whose times overlap are flagged, whoever they are for. A red box in the event form warns while you edit, overlapping events get a warning mark in the calendar, and a banner above the calendar lists conflicts in the next 90 days.
- **Light and dark mode.** Follows the device setting, with a toggle to override it.
- **Export and import** the whole calendar as a JSON file, for backups.
- **Mobile friendly.** On phones the month grid shows colored dots, and tapping a day opens that day's list below the grid.

## Sharing across devices

Events are stored in a Redis database through one serverless function, `api/calendar.js`.

- The page loads the calendar when it opens, saves after every change, and checks for updates every 15 seconds and whenever you switch back to the tab.
- If the server can't be reached, the page keeps working from the browser's own storage and syncs again later.
- Events already saved in a browser are merged in the first time that device syncs.
- If two people save at the same moment, the last save wins.

## Passcode and privacy

Set the `FAMCAL_PASSCODE` environment variable to require a passcode. Without it, anyone who has the link can read and change the calendar.

- The passcode is checked on the server. Devices never store it. After a correct passcode the server issues a sign-in token that is valid for **24 hours**, then the passcode is asked for again.
- Changing the passcode signs every device out.
- After **5 wrong passcodes** from one internet address, that address is locked out for 15 minutes.
- A **Lock** button signs the device out immediately, and a device locks itself after **15 minutes** without use. While locked, the calendar is completely hidden behind the sign-in page.

## Setting it up

You need a free [Vercel](https://vercel.com) account and a Redis database.

1. Put the files in a GitHub repository and import it as a new Vercel project. No build settings are needed.
2. In the Vercel project, open **Storage** (or the Marketplace) and connect a Redis database to the project. This adds a `REDIS_URL` environment variable automatically. The function also accepts `KV_REST_API_URL` and `KV_REST_API_TOKEN` (Upstash style).
3. Add an environment variable named `FAMCAL_PASSCODE` with a long passphrase, then redeploy so it takes effect.
4. Open the project's URL and enter the passcode when asked.

Every push to the main branch redeploys the site.

To change the passcode later, edit `FAMCAL_PASSCODE` in Vercel's environment variables and redeploy.

### Using it without a server

Open `index.html` in a browser. It works on its own, but events are kept only in that browser on that device, with no sharing between devices. Use **Export** and **Import** to move a calendar around.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole app: page, styles, and scripts. |
| `api/calendar.js` | Serverless function that stores and returns the calendar, and handles the passcode, sign-in tokens, and lockout. |
| `package.json` | Declares the `redis` library the function uses. |
| `mockup.html` | Phone mock-ups. Opens the app in iPhone and Galaxy frames with sample events (`index.html?demo`). |

## Notes and limits

- It holds a single calendar. Everyone who knows the passcode sees and edits the same events.
- All events are stored as one value in Redis (`famcal:data`), which is plenty for a family.
- Repeating events are one series: editing or deleting one changes all of its dates.
- There are no email resets. If the passcode is lost, change it in Vercel.
