const path = require('path');

const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID || '1xT-fNx-Ikq5oenGaB98Fpo4AncL6rbjVdr5d_RvhVRg';

const TABS = [
  'Post_Pipeline',
  'Quiz_Vote_Ledger',
  'Participant_Names',
  'Post_Selection_Log',
  'Review_Activity_Log',
  'Quiz_Archive',
  'Admin_Permissions',
  'Settings',
];

const DEFAULT_SETTINGS = {
  POLL_CONTROL_JID: process.env.POLL_CONTROL_JID || 'SIM_POLL_CONTROL@g.us',
  EMERGENCY_STOP: 'FALSE',
  EVENT_PAUSED: 'FALSE',
  AUTO_FALLBACK: 'FALSE',
  LOW_QUEUE_THRESHOLD: '3',
  TOP_SCORER_COUNT: '5',
  DAY_X_ANCHOR_DATE: '11/11/26',
  DAY_X_ANCHOR_NUM: '33',
  EMOJI_APPROVE: '✅',
  EMOJI_REVISION: '🔄',
  EMOJI_HOLD: '⏳',
  EMOJI_SCHEDULE: '📅',
  EMOJI_SPARE: '📦',
  EMOJI_AUTOPICK: '⭐',
};

const LOCAL_MIRROR_PATH = path.join(__dirname, '..', 'data', 'local_sheet_mirror.json');
const CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, '..', 'credentials.json');

module.exports = {
  MASTER_SHEET_ID,
  TABS,
  DEFAULT_SETTINGS,
  LOCAL_MIRROR_PATH,
  CREDENTIALS_PATH,
};
