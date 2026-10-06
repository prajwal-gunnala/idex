# Emergency Party Board

HEP / SSEP firefighting & damage-control training board with VR session control.
Runs on one laptop with no internet and no extra software beyond Node.js 18+.

## Start

```bash
cd ~/Documents/HEP
npm start
```

Then open **http://localhost:8080**. Headsets, tablets and phones on the same
network use the "Same network" address printed in the terminal.

Sign in as **admin** with password **123456**.
Every new account gets the password **123456** unless another is set, and only a
name is needed to create one; people can sign in with their name or login.
Change the default with `HEP_DEFAULT_PASSWORD=… npm start`.

| Setting      | Default           | Change with                      |
|--------------|-------------------|----------------------------------|
| Port         | 8080              | `PORT=9000 npm start`            |
| Listen on    | all interfaces    | `HOST=127.0.0.1 npm start` (this laptop only) |
| Database     | `data/db.json`    | `HEP_DB=/path/to/db.json npm start` |

**Back-up:** copy `data/db.json`. Stop the server (Ctrl+C) before restoring a copy.

## Roles

| Role            | Who                     | Can                                                                 |
|-----------------|-------------------------|---------------------------------------------------------------------|
| Administrator   | Training / moderator    | Everything below, plus the Management Centre and all moderator tools |
| Officer         | Officer of the Day      | Create a session **when on duty today**, assign hands, run the drill, write the report |
| Participant     | Ship's company          | Register, wait for assignment, see live conditions and messages, write party + personal remarks, mark own part complete |

Administrators create accounts of any role and change roles in
**Management Centre → Users & Roles**, and set who is Officer of the Day for
each ship and date in **Management Centre → Officer of the Day**.

## A drill, start to finish

1. **Participants** register on the sign-in page and see *Waiting for assignment*.
2. The **Officer of the Day** signs in → *Create session* → the session runner opens
   with a 6-character session code. Every VR drill is a new session.
3. Scenario (Ship in Harbour / Ship at Sea) → Firefighting or Damage Control →
   location → **assign hands** from the dropdowns (Attack Party and Attack 'BA' are required).
   Participants see their billet appear immediately.
4. **VR Scenario:** pick the drill mode, press *Start VR session*.
5. The **administrator** opens *Training In-Session Tools* to steer the drill live:
   minor / major, CO₂, O₂, smoke, temperature, visibility, flooding …, injects
   (re-ignition, casualty, hose burst …), sensory cues, and messages.
6. Participants write **party remarks** (shared with their party) and **personal
   remarks**, then mark their part complete.
7. The officer records the Attack Party's report and the minor / major assessment,
   timings and remarks, then **closes the session**. The report (with the
   organisation chart, muster card and full event timeline) prints to PDF.

## Demo data

With the server running:

```bash
node server/demo-sessions.js
```

creates the demo accounts (if missing), puts both demo officers on today's roster and
builds three sessions through the API: a closed minor galley fire (HEP), a closed major
engine-room flood at sea (SSEP) and a live major engine-room fire (HEP) left running.
Run it again for three more. Remove the accounts with *Remove demo hands*; delete
sessions from Training Session Management.

## Management Centre (administrator)

- **Users & Roles:** accounts, roles, on/off, password reset, demo hands for practice
  (password `123456`), whether participants may self-register.
- **Officer of the Day:** a 14-day roster per ship.
- **Ships & Compartments:** units, which scenarios they use, and incident locations.
- **Organisation Plans:** parties, number of hands, designations, required flags and notes,
  with a live drawing. New sessions use the saved plan; past sessions keep the version they ran with.
- **Trades & Designations:** billet codes and their full names.

Also: **Training / Drill Modes**, **Sensory Cues & Feedback**, and the inject and
environment-parameter libraries under **Training In-Session Tools**.

## Online demo (GitHub Pages)

Every push to `main` publishes a browser-only demo to GitHub Pages
(`.github/workflows/pages.yml`). It runs the same API as the server, but inside
the page, with no server at all:

- The database lives in that browser's `localStorage`. Each visitor and device
  gets its own copy, and nothing is shared between devices.
- A first visit builds the demo accounts and the three demo sessions. *Reset demo*
  in the strip at the top starts over.
- Each tab signs in separately, so the admin, an officer and a participant can be
  open side by side in one browser and see each other's changes live.
- The VR headset interface needs the real server and does not work in the demo.

Build it locally with `npm run build:pages` (output in `_site/`) and serve that
folder with any static web server.

## VR headset interface

Each session has a **session code** and a **VR key**, both shown on the VR Scenario step.

```http
GET  /api/vr/{CODE}/state            X-VR-Key: {key}
```
Returns status, severity, drill mode, compartment, environment values, sensory cues
(on / intensity), recent messages and the roster. Poll every second or two.

```http
POST /api/vr/{CODE}/events           X-VR-Key: {key}
Content-Type: application/json

{ "type": "extinguisher", "text": "CO2 extinguisher discharged", "userId": "optional" }
```
Adds the event to the session timeline (Annex C of the report).

## Layout

```
server/server.js     web server, live updates, passwords (Node built-ins only)
server/app.js        the API itself, shared with the GitHub Pages demo
server/store.js      JSON database with safe writes
server/defaults.js   starting data: plans, ships, modes, cues, injects, environment
public/              pages: sign-in, dashboard, session runner, participant
pages/               browser-only back end for the GitHub Pages demo
scripts/             build-pages.js: builds the demo into _site/
data/db.json         created on first start
```

The server has no HTTPS and is meant for a closed ship / training network.
