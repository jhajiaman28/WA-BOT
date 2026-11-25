const { MASTER_SHEET_ID, OWNER_PHONE, normalizePhone, formatISTTimestamp } = require('./config');
const google = require('./google');

const state = {
  settings: {},
  bindings: [],
  permissions: [],
  members: [],
  activePolls: new Map(),
  voteCache: new Map(),
  customSchedules: [],
  templates: [],
  trackedGroups: [],
  pendingPrompts: new Map(),
  listeners: new Map(),
  chatHistory: new Map(),
  sentMsgIds: new Set(),
  dailySentFlags: new Set(),
  contacts: new Map(),
  dmJobActive: false,
  dmJobCancel: false,
  lastSyncAt: null,
};

async function loadMasterState() {
  const [settingsRows, bindingRows, permRows, memberRows, pollRows, schedRows, tplRows, voteLogRows, trackedRows] = await Promise.all([
    google.getRows(MASTER_SHEET_ID, 'Settings!A2:C'),
    google.getRows(MASTER_SHEET_ID, 'Group_Bindings!A2:H'),
    google.getRows(MASTER_SHEET_ID, 'Admin_Permissions!A2:E'),
    google.getRows(MASTER_SHEET_ID, 'Member_Registry!A2:E'),
    google.getRows(MASTER_SHEET_ID, 'Active_Polls!A2:J'),
    google.getRows(MASTER_SHEET_ID, 'Custom_Schedules!A2:F').catch(() => []),
    google.getRows(MASTER_SHEET_ID, 'Templates!A2:E').catch(() => []),
    google.getRows(MASTER_SHEET_ID, 'Gita_Vote_Logs!A2:F').catch(() => []),
    google.getRows(MASTER_SHEET_ID, 'Tracked_Groups!A2:G').catch(() => []),
  ]);

  state.settings = {};
  settingsRows.forEach(([k, v]) => { if (k) state.settings[k.trim()] = (v || '').trim(); });

  state.bindings = bindingRows.filter((r) => r[0]).map((r) => ({
    bindKey: (r[0] || '').trim(),
    category: (r[1] || '').trim(),
    groupName: (r[2] || '').trim(),
    groupJid: (r[3] || '').trim(),
    targetSheetId: (r[4] || '').trim(),
    targetTab: (r[5] || '').trim(),
    scheduleCron: (r[6] || '').trim(),
    trackJoins: String(r[7] || '').toUpperCase() === 'TRUE',
  }));

  state.permissions = permRows.filter((r) => r[0]).map((r) => ({
    phone: normalizePhone(r[0]),
    name: (r[1] || '').trim(),
    role: (r[2] || 'LIMITED').trim().toUpperCase(),
    allowedChannels: (r[3] || 'CONTROL').split(',').map((s) => s.trim().toUpperCase()),
    allowedCategories: (r[4] || '').split(',').map((s) => s.trim()).filter(Boolean),
  }));

  state.members = memberRows.filter((r) => r[0] || r[1]).map((r) => ({
    phoneJid: (r[0] || '').trim(),
    lid: (r[1] || '').trim(),
    officialName: (r[2] || '').trim(),
    groupKey: (r[3] || '').trim(),
    addedOn: (r[4] || '').trim(),
  }));

  const now = Date.now();
  state.activePolls.clear();
  pollRows.filter((r) => r[0]).forEach((r) => {
    const expiresAt = Number(r[9] || 0);
    if (!expiresAt || expiresAt > now) {
      state.activePolls.set(r[0].trim(), {
        pollMsgId: r[0].trim(),
        category: (r[1] || '').trim(),
        groupJid: (r[2] || '').trim(),
        targetSheetId: (r[3] || '').trim(),
        targetTab: (r[4] || '').trim(),
        targetDate: (r[5] || '').trim(),
        sessionName: (r[6] || '').trim(),
        ...(() => { const p = JSON.parse(r[7] || '[]'); return Array.isArray(p) ? { options: p, secret: '' } : { options: p.options || [], secret: p.secret || '' }; })(),
        createdAt: Number(r[8] || 0),
        expiresAt,
      });
    }
  });

  state.templates = tplRows.filter((r) => r[0]).map((r, i) => ({
    rowNum: i + 2,
    nickname: (r[0] || '').trim(),
    text: (r[1] || '').trim(),
    version: Number(r[2] || 1),
    status: (r[3] || 'ACTIVE').trim().toUpperCase(),
    updatedAt: (r[4] || '').trim(),
  }));

  state.customSchedules = schedRows.filter((r) => r[0] && r[5] !== 'DONE').map((r) => ({
    id: (r[0] || '').trim(),
    targetJid: (r[1] || '').trim(),
    payload: (r[2] || '').trim(),
    runAtIST: (r[3] || '').trim(),
    repeat: (r[4] || 'ONCE').trim().toUpperCase(),
    status: (r[5] || 'ACTIVE').trim().toUpperCase(),
    notifyControl: String(r[6] || '').toUpperCase() === 'TRUE',
  }));

  state.dailySentFlags.clear();
  for (const poll of state.activePolls.values()) {
    const b = state.bindings.find((x) => x.groupJid === poll.groupJid);
    if (b && poll.targetDate) state.dailySentFlags.add(`${b.bindKey}:${poll.targetDate}`);
  }
  state.trackedGroups = trackedRows.filter((r) => r[1]).map((r) => ({
    groupName: (r[0] || '').trim(),
    groupJid: (r[1] || '').trim(),
    sheetId: (r[2] || '').trim(),
    sheetUrl: (r[3] || '').trim(),
    createdAt: (r[4] || '').trim(),
    status: (r[5] || 'ACTIVE').trim().toUpperCase(),
  }));

  state.voteCache.clear();
  for (const r of voteLogRows) {
    const pollDate = (r[2] || '').trim();
    const memberName = (r[3] || '').trim();
    const sym = (r[5] || '').trim();
    if (!pollDate || !memberName || !sym) continue;
    const poll = [...state.activePolls.values()].find((p) => p.targetDate === pollDate);
    const mem = state.members.find((m) => m.officialName.toLowerCase() === memberName.toLowerCase());
    if (poll && mem) {
      const vJid = mem.phoneJid || mem.lid;
      state.voteCache.set(`${poll.pollMsgId}:${vJid}`, { poll, voterJid: vJid, pushName: memberName, symbol: sym, groupKey: mem.groupKey });
    }
  }

  state.lastSyncAt = formatISTTimestamp();
  console.log(`[State] Loaded: ${state.bindings.length} bindings, ${state.members.length} members, ${state.activePolls.size} active polls.`);
}

async function saveSetting(key, value, desc = '') {
  state.settings[key] = String(value);
  const rows = await google.getRows(MASTER_SHEET_ID, 'Settings!A2:A');
  const idx = rows.findIndex((r) => (r[0] || '').trim() === key);
  if (idx >= 0) {
    await google.updateRange(MASTER_SHEET_ID, `Settings!B${idx + 2}`, [[String(value)]]);
  } else {
    await google.appendRow(MASTER_SHEET_ID, 'Settings', [key, String(value), desc]);
  }
}

async function registerMember(phoneJid, lid, officialName, groupKey) {
  const existing = state.members.find(
    (m) => m.groupKey === groupKey && ((phoneJid && m.phoneJid === phoneJid) || (lid && m.lid === lid))
  );
  if (existing) {
    existing.officialName = officialName;
    if (phoneJid) existing.phoneJid = phoneJid;
    if (lid) existing.lid = lid;
    const rows = await google.getRows(MASTER_SHEET_ID, 'Member_Registry!A2:E');
    const rowIdx = rows.findIndex((r) => r[3] === groupKey && ((phoneJid && r[0] === phoneJid) || (lid && r[1] === lid)));
    if (rowIdx >= 0) {
      await google.updateRange(MASTER_SHEET_ID, `Member_Registry!A${rowIdx + 2}:C${rowIdx + 2}`, [[existing.phoneJid, existing.lid, officialName]]);
    }
    return;
  }
  const addedOn = formatISTTimestamp();
  state.members.push({ phoneJid, lid, officialName, groupKey, addedOn });
  await google.appendRow(MASTER_SHEET_ID, 'Member_Registry', [phoneJid, lid, officialName, groupKey, addedOn]);
}

function findMember(voterJid, groupKey) {
  const clean = normalizePhone(voterJid);
  return state.members.find((m) => {
    if (m.groupKey !== groupKey) return false;
    if (m.phoneJid === voterJid || m.lid === voterJid) return true;
    return clean && (normalizePhone(m.phoneJid) === clean || normalizePhone(m.lid) === clean);
  });
}

async function saveActivePoll(poll) {
  state.activePolls.set(poll.pollMsgId, poll);
  await google.appendRow(MASTER_SHEET_ID, 'Active_Polls', [
    poll.pollMsgId,
    poll.category,
    poll.groupJid,
    poll.targetSheetId,
    poll.targetTab,
    poll.targetDate,
    poll.sessionName,
    JSON.stringify({ options: poll.options, secret: poll.secret || '' }),
    String(poll.createdAt),
    String(poll.expiresAt),
  ]);
}

function isFullAuthority(senderJid) {
  const phone = normalizePhone(senderJid);
  if (OWNER_PHONE && phone === OWNER_PHONE) return true;
  const perm = state.permissions.find((p) => p.phone === phone);
  return perm?.role === 'FULL';
}

function isAuthorized(senderJid, channel = 'CONTROL', category = null) {
  const phone = normalizePhone(senderJid);
  if (OWNER_PHONE && phone === OWNER_PHONE) return true;
  const perm = state.permissions.find((p) => p.phone === phone);
  if (!perm) return false;
  if (perm.role === 'FULL') return true;
  if (!perm.allowedChannels.includes(channel) && !perm.allowedChannels.includes('ALL')) return false;
  if (category && perm.allowedCategories.length && !perm.allowedCategories.includes(category)) return false;
  return true;
}

function pushChatHistory(chatJid, role, text) {
  const hist = state.chatHistory.get(chatJid) || [];
  hist.push({ role, text });
  if (hist.length > 16) hist.shift();
  state.chatHistory.set(chatJid, hist);
}


function isPaused(categoryKey) {
  if (state.settings.EMERGENCY_STOP === 'TRUE') return true;
  if (state.settings.SCHEDULE_PAUSED === 'TRUE') return true;
  if (categoryKey && state.settings[`PAUSED_${categoryKey}`] === 'TRUE') return true;
  return false;
}

module.exports = {
  state,
  loadMasterState,
  saveSetting,
  registerMember,
  findMember,
  saveActivePoll,
  isFullAuthority,
  isAuthorized,
  pushChatHistory,
  isPaused,
};
