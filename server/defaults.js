/* ==========================================================================
   Default reference data — seeded into data/db.json on first start.
   Everything here is editable afterwards from the Admin dashboard.
   ========================================================================== */
'use strict';

/* Ships, scenarios (HEP / SSEP), incident types, trades and the organisation
   plans — carried over from the paper sheets. */
const base = require('./defaults-base.json');

/* --------------------------------------------------------------------------
   Environment parameters the moderator can drive during a live session.
   lowIsBad: the value is dangerous when it falls (O2, visibility, pressure).
   appliesTo: FF | DC | BOTH — which incident types show the control.
   -------------------------------------------------------------------------- */
const envParams = [
  { id: 'fireIntensity', name: 'Fire intensity',        unit: '/10',  min: 0,  max: 10,   step: 1,   value: 4,    warn: 6,    danger: 8,    appliesTo: 'FF' },
  { id: 'smoke',         name: 'Smoke density',         unit: '%',    min: 0,  max: 100,  step: 5,   value: 40,   warn: 60,   danger: 85,   appliesTo: 'FF' },
  { id: 'temperature',   name: 'Compartment temp.',     unit: '°C',   min: 20, max: 600,  step: 10,  value: 80,   warn: 150,  danger: 300,  appliesTo: 'FF' },
  { id: 'co2',           name: 'CO₂ concentration',     unit: '%',    min: 0,  max: 50,   step: 0.5, value: 0.5,  warn: 2,    danger: 4,    appliesTo: 'BOTH' },
  { id: 'o2',            name: 'Oxygen',                unit: '%',    min: 0,  max: 21,   step: 0.1, value: 20.9, warn: 19.5, danger: 16,   appliesTo: 'BOTH', lowIsBad: true },
  { id: 'co',            name: 'Carbon monoxide',       unit: 'ppm',  min: 0,  max: 2000, step: 10,  value: 50,   warn: 200,  danger: 1200, appliesTo: 'FF' },
  { id: 'visibility',    name: 'Visibility',            unit: 'm',    min: 0,  max: 30,   step: 1,   value: 10,   warn: 5,    danger: 2,    appliesTo: 'BOTH', lowIsBad: true },
  { id: 'waterLevel',    name: 'Water level',           unit: 'cm',   min: 0,  max: 200,  step: 5,   value: 0,    warn: 30,   danger: 80,   appliesTo: 'DC' },
  { id: 'leakRate',      name: 'Leak rate',             unit: 'L/min',min: 0,  max: 3000, step: 50,  value: 0,    warn: 500,  danger: 1500, appliesTo: 'DC' },
  { id: 'firemain',      name: 'Fire-main pressure',    unit: 'bar',  min: 0,  max: 10,   step: 0.5, value: 7,    warn: 5,    danger: 3,    appliesTo: 'BOTH', lowIsBad: true }
];

/* --------------------------------------------------------------------------
   Injects — events the moderator can fire into a live session.
   effect.set / effect.add change environment values; effect.severity
   escalates the incident.
   -------------------------------------------------------------------------- */
const injects = [
  { id: 'reignition',  name: 'Re-ignition',                   appliesTo: 'FF',   description: 'Fire re-ignites after being reported out.',               effect: { add: { fireIntensity: 3, temperature: 60 } } },
  { id: 'spread',      name: 'Fire spreads to adjacent compt', appliesTo: 'FF',  description: 'Boundary breached — fire in the adjacent compartment.',    effect: { add: { fireIntensity: 2, smoke: 20 }, severity: 'major' } },
  { id: 'flashover',   name: 'Flashover risk',                appliesTo: 'FF',   description: 'Rapid temperature rise at deckhead level.',               effect: { add: { temperature: 200 } } },
  { id: 'secondleak',  name: 'Second leak / pipe burst',      appliesTo: 'DC',   description: 'A second pipe fractures in the compartment.',             effect: { add: { leakRate: 800 }, severity: 'major' } },
  { id: 'shoringfail', name: 'Shoring failure',               appliesTo: 'DC',   description: 'A shore slips; bulkhead deflection increases.',           effect: { add: { waterLevel: 20, leakRate: 300 } } },
  { id: 'casualty',    name: 'Casualty',                      appliesTo: 'BOTH', description: 'Unconscious sailor found in the compartment.',            effect: {} },
  { id: 'hoseburst',   name: 'Hose burst / low pressure',     appliesTo: 'BOTH', description: 'Hose bursts; fire-main pressure drops.',                  effect: { set: { firemain: 2 } } },
  { id: 'balowair',    name: 'BA low-air warning',            appliesTo: 'BOTH', description: "A BA wearer's low-pressure whistle sounds.",              effect: {} },
  { id: 'powerfail',   name: 'Power / lighting failure',      appliesTo: 'BOTH', description: 'Compartment lighting fails; emergency lighting only.',    effect: { set: { visibility: 2 } } },
  { id: 'commsfail',   name: 'Communications failure',        appliesTo: 'BOTH', description: 'Loss of comms with the Attack Party.',                    effect: {} },
  { id: 'electrical',  name: 'Electrical short / arcing',     appliesTo: 'BOTH', description: 'Arcing from a damaged cable run.',                        effect: {} }
];

/* --------------------------------------------------------------------------
   Training / drill modes — chosen per session.
   -------------------------------------------------------------------------- */
const modes = [
  { id: 'guided',   name: 'Guided Training',   difficulty: 'Basic',        hints: true,  timeLimitMin: 0,  scored: false, allowPause: true,  announced: true,
    description: 'Step-by-step prompts in the headset. For first-time hands and new joiners.' },
  { id: 'practice', name: 'Practice Drill',    difficulty: 'Intermediate', hints: false, timeLimitMin: 0,  scored: false, allowPause: true,  announced: true,
    description: 'Full drill without prompts; the moderator can pause and coach.' },
  { id: 'timed',    name: 'Timed Evaluation',  difficulty: 'Advanced',     hints: false, timeLimitMin: 20, scored: true,  allowPause: false, announced: true,
    description: 'Scored against time limits and checkpoints. No pausing.' },
  { id: 'surprise', name: 'Surprise Drill',    difficulty: 'Advanced',     hints: false, timeLimitMin: 0,  scored: true,  allowPause: false, announced: false,
    description: 'Unannounced; location is revealed only when the alarm is raised.' },
  { id: 'demo',     name: 'Demonstration',     difficulty: 'Basic',        hints: true,  timeLimitMin: 0,  scored: false, allowPause: true,  announced: true,
    description: 'Moderator-led walkthrough; participants observe.' }
];

/* --------------------------------------------------------------------------
   Sensory cues — switched on/off and dialled up/down live.
   -------------------------------------------------------------------------- */
const cues = [
  { id: 'flames',       channel: 'Visual',    name: 'Flames',                       appliesTo: 'FF',   hardware: '',               enabled: true,  intensity: 60 },
  { id: 'smokeVis',     channel: 'Visual',    name: 'Smoke',                        appliesTo: 'FF',   hardware: '',               enabled: true,  intensity: 50 },
  { id: 'waterIngress', channel: 'Visual',    name: 'Water ingress / spray',        appliesTo: 'DC',   hardware: '',               enabled: true,  intensity: 60 },
  { id: 'emergLight',   channel: 'Visual',    name: 'Emergency lighting',           appliesTo: 'BOTH', hardware: '',               enabled: false, intensity: 40 },
  { id: 'strobe',       channel: 'Visual',    name: 'Alarm strobe',                 appliesTo: 'BOTH', hardware: '',               enabled: true,  intensity: 70 },
  { id: 'generalAlarm', channel: 'Audio',     name: 'General alarm',                appliesTo: 'BOTH', hardware: '',               enabled: true,  intensity: 80 },
  { id: 'pipe',         channel: 'Audio',     name: 'Pipe — "Fire, fire, fire…"',   appliesTo: 'FF',   hardware: '',               enabled: true,  intensity: 80 },
  { id: 'crackle',      channel: 'Audio',     name: 'Fire crackle',                 appliesTo: 'FF',   hardware: '',               enabled: true,  intensity: 50 },
  { id: 'waterRush',    channel: 'Audio',     name: 'Rushing water',                appliesTo: 'DC',   hardware: '',               enabled: true,  intensity: 60 },
  { id: 'radio',        channel: 'Audio',     name: 'Radio chatter',                appliesTo: 'BOTH', hardware: '',               enabled: false, intensity: 40 },
  { id: 'rumble',       channel: 'Haptic',    name: 'Controller rumble (hose / tools)', appliesTo: 'BOTH', hardware: 'VR controllers', enabled: true, intensity: 50 },
  { id: 'heatVest',     channel: 'Haptic',    name: 'Heat vest',                    appliesTo: 'FF',   hardware: 'Heat vest',      enabled: false, intensity: 40 },
  { id: 'floorVib',     channel: 'Haptic',    name: 'Deck vibration',               appliesTo: 'BOTH', hardware: 'Haptic floor',   enabled: false, intensity: 30 },
  { id: 'radiantHeat',  channel: 'Thermal',   name: 'Radiant heat panel',           appliesTo: 'FF',   hardware: 'Heat panel',     enabled: false, intensity: 30 },
  { id: 'smokeScent',   channel: 'Olfactory', name: 'Smoke scent',                  appliesTo: 'FF',   hardware: 'Scent emitter',  enabled: false, intensity: 30 }
];

/* --------------------------------------------------------------------------
   Feedback mechanisms — how trainees are told how they are doing.
   -------------------------------------------------------------------------- */
const feedback = [
  { id: 'hud',        name: 'Headset prompts (HUD)',    enabled: true,  description: 'On-screen hints in the headset; follows the drill mode.' },
  { id: 'baGauge',    name: 'BA air gauge warnings',    enabled: true,  description: 'Low-air alerts for BA wearers.' },
  { id: 'checkpoint', name: 'Checkpoint timing',        enabled: true,  description: 'Times alarm-to-close-up, first attack, fire out / leak stopped.' },
  { id: 'scoring',    name: 'Performance scoring',      enabled: false, description: 'Score per party against the drill mode time limits.' },
  { id: 'whisper',    name: 'Moderator messages',       enabled: true,  description: 'Moderator can message all hands, a party or one person.' },
  { id: 'debrief',    name: 'After-action debrief',     enabled: true,  description: 'Timeline of events and remarks in the session report.' }
];

const settings = {
  allowSelfRegistration: true,
  onlyDutyOfficerCreatesSessions: true
};

module.exports = { ...base, envParams, injects, modes, cues, feedback, settings };
