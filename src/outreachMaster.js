const { formatISTDate, formatISTTimestamp, normalizePhone, getISTNow } = require('./config');
const google = require('./google');
const { state, saveSetting } = require('./state');

const DEFAULT_MASTER_OUTREACH_ID = '1PhV_QxyRAt1CkMr1CHRndl8DkAZMueId5vq221R6H9g';
const DEFAULT_TEAM_DASHBOARD_ID = '1VDxAor3uOcIVAi37DVgqOMiGMUBlAS8d5qH_N90rYtU';
const CALL_LOG_FORM_BASE = 'https://docs.google.com/forms/d/e/1FAIpQLSfux-1dgHHAH2NAPxj_lfC6AH1yJsTar6VOQMZAu028I4Y9Zw/viewform?usp=pp_url';
const FORM_ENTRIES = {
  caller: 'entry.509972065',
  name: 'entry.1334767494',
  phone: 'entry.1695730974',
  event: 'entry.303972880',
};

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let dirCache = { map: new Map(), fetchedAt: 0 };
const alertedKeywordGroups = new Set();

function getOutreachSheetId() {
  return state.settings.MASTER_OUTREACH_SHEET_ID || DEFAULT_MASTER_OUTREACH_ID;
}

function getDashboardSheetId() {
  return state.settings.TEAM_DASHBOARD_SHEET_ID || DEFAULT_TEAM_DASHBOARD_ID;
}

function getOutreachControlJid() {
  return state.settings.OUTREACH_CONTROL_JID || state.settings.CONTROL_GROUP_JID || '';
}

function getCallersGroupJid() {
  return state.settings.CALLERS_GROUP_JID || '';
}

function last10(phoneOrJid = '') {
  const digits = normalizePhone(phoneOrJid);
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function pickBetterName(a = '', b = '') {
  const ca = (a || '').trim();
  const cb = (b || '').trim();
  const invalid = (s) => !s || s === '(Pending Name)' || /^\+?\d[\d\s-]+$/.test(s);
  if (invalid(ca) && invalid(cb)) return '';
  if (invalid(ca)) return cb;
  if (invalid(cb)) return ca;
  return cb.length > ca.length ? cb : ca;
}

function buildPrefilledFormUrl({ caller, name, phone, event }) {
  const params = new URLSearchParams();
  params.set(FORM_ENTRIES.caller, caller || '');
  params.set(FORM_ENTRIES.name, name || '');
  params.set(FORM_ENTRIES.phone, phone || '');
  params.set(FORM_ENTRIES.event, event || 'General');
  return `${CALL_LOG_FORM_BASE}&${params.toString()}`;
}

function getExcludePhoneSet() {
  const set = new Set();
  for (const m of state.members) {
    const p10 = last10(m.phoneJid);
    if (p10) set.add(p10);
  }
  return set;
}

async function loadDirectorySources(force = false) {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  if (!force && dirCache.fetchedAt && Date.now() - dirCache.fetchedAt < FOUR_HOURS) {
    return dirCache.map;
  }

  const masterId = getOutreachSheetId();
  const srcRows = await google.getRows(masterId, 'Directory_Sources!A2:G').catch(() => []);
  const map = new Map();

  for (const r of srcRows) {
    const srcName = (r[0] || '').trim();
    const urlOrId = (r[2] || '').trim();
    const tabRange = (r[3] || '').trim();
    const active = String(r[4] || '').trim().toLowerCase() === 'yes';
    if (!active || !urlOrId || !tabRange) continue;

    const m = urlOrId.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const sid = m ? m[1] : urlOrId;
    try {
      const rows = await google.getRows(sid, tabRange);
      for (const row of rows) {
        const rawName = (row[0] || '').trim();
        let p10 = '';
        for (let ci = 1; ci < row.length; ci++) {
          const cand = last10(row[ci] || '');
          if (cand) { p10 = cand; break; }
        }
        if (!p10) continue;
        const prev = map.get(p10) || { name: '', source: srcName };
        map.set(p10, {
          name: pickBetterName(prev.name, rawName) || prev.name,
          source: prev.source || srcName,
        });
      }
    } catch {
      // ignore unshared external sheets
    }
  }

  dirCache = { map, fetchedAt: Date.now() };
  return map;
}

function mergeTags(existing = '', incoming = '') {
  const parts = new Set(
    String(existing || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (incoming && incoming.trim()) parts.add(incoming.trim());
  return [...parts].join(', ');
}

function getActiveEventForGroup(groupName) {
  const globalEvent = (state.settings.OUTREACH_ACTIVE_EVENT || '').trim();
  const expStr = (state.settings.OUTREACH_ACTIVE_EVENT_EXPIRES || '').trim();
  if (globalEvent && expStr && Date.now() > Number(expStr)) {
    saveSetting('OUTREACH_ACTIVE_EVENT', '').catch(() => {});
    return 'General';
  }
  if (!globalEvent) return groupName || 'General';
  const targetGroup = (state.settings.OUTREACH_ACTIVE_EVENT_GROUP || '').trim().toLowerCase();
  if (targetGroup && groupName.toLowerCase().includes(targetGroup)) return globalEvent;
  return `${globalEvent} (Probable)`;
}

async function syncMasterOutreach({ forceDir = false, sendNotice = null }) {
  const masterId = getOutreachSheetId();
  const excludeSet = getExcludePhoneSet();
  const dirMap = await loadDirectorySources(forceDir);

  const [curRows, exitRows] = await Promise.all([
    google.getRows(masterId, 'Master_Outreach!A2:O').catch(() => []),
    google.getRows(masterId, 'Exit_List!A2:Q').catch(() => []),
  ]);

  const byPhone = new Map();
  const orderedPhones = [];
  for (const r of curRows) {
    const p10 = last10(r[2] || '');
    if (!p10) continue;
    const row = Array.from({ length: 15 }, (_, i) => (r[i] || '').trim());
    byPhone.set(p10, row);
    orderedPhones.push(p10);
  }

  const exitByPhone = new Map();
  for (const r of exitRows) {
    const p10 = last10(r[2] || '');
    if (p10) exitByPhone.set(p10, Array.from({ length: 17 }, (_, i) => (r[i] || '').trim()));
  }

  const activeGroups = state.trackedGroups.filter((t) => t.status === 'ACTIVE' && t.includeInOutreach !== false);
  const groupCounts = new Map();
  const liveGroupPhones = new Map();

  for (const tg of activeGroups) {
    const gRows = await google.getRows(tg.sheetId, 'Current_Members!A2:B').catch(() => []);
    const pSet = new Set();
    for (const [gName, gId] of gRows) {
      if (!gId || String(gId).includes('@lid')) continue;
      const p10 = last10(gId);
      if (!p10 || excludeSet.has(p10)) continue;
      pSet.add(p10);

      const dirInfo = dirMap.get(p10);
      const bestName = pickBetterName(gName, dirInfo?.name || '') || '(Pending Name)';
      const eventTag = tg.activeEvent || getActiveEventForGroup(tg.groupName);

      if (!byPhone.has(p10)) {
        if (exitByPhone.has(p10)) {
          const prevExit = exitByPhone.get(p10).slice(0, 15);
          prevExit[1] = pickBetterName(prevExit[1], bestName) || bestName;
          prevExit[4] = mergeTags(prevExit[4], tg.groupName);
          prevExit[5] = mergeTags(prevExit[5], eventTag);
          prevExit[6] = 'Active';
          byPhone.set(p10, prevExit);
          orderedPhones.push(p10);
          exitByPhone.delete(p10);
        } else {
          const newRow = [
            '', bestName, `+91${p10}`, tg.groupName, tg.groupName, eventTag, 'Active',
            '', '', '', 'Not Called', '', '', '', '',
          ];
          byPhone.set(p10, newRow);
          orderedPhones.push(p10);
        }
      } else {
        const existing = byPhone.get(p10);
        existing[1] = pickBetterName(existing[1], bestName) || existing[1];
        existing[4] = mergeTags(existing[4], tg.groupName);
        existing[5] = mergeTags(existing[5], eventTag);
        existing[6] = 'Active';
      }
    }
    groupCounts.set(tg.groupName, pSet.size);
    liveGroupPhones.set(tg.groupName, pSet);
  }

  for (const [p10, info] of dirMap.entries()) {
    if (excludeSet.has(p10) || byPhone.has(p10) || exitByPhone.has(p10)) continue;
    const newRow = [
      '', info.name || '(Pending Name)', `+91${p10}`, 'Directory Only', 'Directory Only', info.source, 'Active',
      '', '', '', 'Not Called', '', '', '', '',
    ];
    byPhone.set(p10, newRow);
    orderedPhones.push(p10);
  }

  let added = 0;
  const finalRows = [];
  for (let i = 0; i < orderedPhones.length; i++) {
    const p10 = orderedPhones[i];
    const row = byPhone.get(p10);
    if (!row) continue;

    const isLocked = Boolean(row[9]) || (row[10] && row[10] !== 'Not Called');
    const joinedList = row[4].split(',').map((s) => s.trim()).filter((s) => s && s !== 'Directory Only');
    if (!isLocked && joinedList.length > 1) {
      let minGroup = joinedList[0];
      let minCount = groupCounts.get(minGroup) ?? Infinity;
      for (const gn of joinedList) {
        const c = groupCounts.get(gn) ?? Infinity;
        if (c < minCount) { minCount = c; minGroup = gn; }
      }
      row[3] = minGroup;
    }

    if (joinedList.length > 0) {
      const stillInAny = joinedList.some((gn) => liveGroupPhones.get(gn)?.has(p10));
      if (!stillInAny && activeGroups.length > 0) row[6] = 'Exited';
    }

    row[0] = String(finalRows.length + 1);
    finalRows.push(row);
    if (i >= curRows.length) added++;
  }

  const headers = ['S. No.', 'Name', 'Phone', 'Primary_Group', 'All_Groups', 'Event / Source', 'Member_Status', 'Role', 'College / Institute', 'Assigned_Caller', 'Call_Status', 'Response', 'Activity_Interest', 'Next_FollowUp_Date', 'Notes & TG_Log'];
  await google.rewriteTab(masterId, 'Master_Outreach', headers, finalRows);

  if (sendNotice && added > 0) {
    await sendNotice(`🔄 *Master Outreach Synced:* +${added} new contact(s), ${finalRows.length} total active.`);
  }
  return { total: finalRows.length, added };
}

async function cleanExitedMembers({ target = 'all', sendNotice }) {
  const masterId = getOutreachSheetId();
  const [curRows, exitRows] = await Promise.all([
    google.getRows(masterId, 'Master_Outreach!A2:O').catch(() => []),
    google.getRows(masterId, 'Exit_List!A2:Q').catch(() => []),
  ]);

  const q = target.trim().toLowerCase();
  const isAll = !q || q === 'all';
  const kept = [];
  let moved = 0;
  const dateStr = formatISTDate();

  for (const r of curRows) {
    const row = Array.from({ length: 15 }, (_, i) => (r[i] || '').trim());
    const isExited = row[6].toLowerCase() === 'exited';
    const matchTarget = isAll ? isExited : (isExited && (row[1].toLowerCase().includes(q) || row[2].includes(q)));

    if (matchTarget) {
      exitRows.push([...row, dateStr, 'Cleaned from Master']);
      moved++;
    } else {
      row[0] = String(kept.length + 1);
      kept.push(row);
    }
  }

  if (!moved) {
    if (sendNotice) await sendNotice(`ℹ️ No matching \`Exited\` rows found for "${target}".`);
    return 0;
  }

  const mHeaders = ['S. No.', 'Name', 'Phone', 'Primary_Group', 'All_Groups', 'Event / Source', 'Member_Status', 'Role', 'College / Institute', 'Assigned_Caller', 'Call_Status', 'Response', 'Activity_Interest', 'Next_FollowUp_Date', 'Notes & TG_Log'];
  const eHeaders = [...mHeaders, 'Exit_Date', 'Exit_Action'];
  await google.rewriteTab(masterId, 'Master_Outreach', mHeaders, kept);
  await google.rewriteTab(masterId, 'Exit_List', eHeaders, exitRows);
  if (sendNotice) await sendNotice(`🧹 Moved *${moved}* exited contact(s) to \`Exit_List\`.`);
  return moved;
}

async function sendWeeklyAvailabilityPoll({ sendPoll, sendNotice }) {
  const callersJid = getCallersGroupJid();
  if (!callersJid) return;
  const payload = {
    question: '📅 Weekly Call Availability — Select all days you can make outreach calls (update anytime before 10:00 AM):',
    options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    selectableCount: 7,
  };
  const sent = await sendPoll(callersJid, payload);
  if (sent?.key?.id) {
    await saveSetting('OUTREACH_AVAIL_POLL_ID', sent.key.id, 'Active weekly caller availability poll');
    await saveSetting('OUTREACH_AVAIL_VOTES', '{}', 'JSON map of caller JID to voted days');
    if (sendNotice) await sendNotice('📅 Posted Weekly Caller Availability Poll in Callers Team group.');
  }
}

async function handleAvailabilityVote({ voterJid, pushName, selectedOptions }) {
  let votes = {};
  try { votes = JSON.parse(state.settings.OUTREACH_AVAIL_VOTES || '{}'); } catch {}
  const p10 = last10(voterJid);
  votes[p10 || voterJid] = { name: pushName || p10, days: selectedOptions || [] };
  await saveSetting('OUTREACH_AVAIL_VOTES', JSON.stringify(votes), 'JSON map of caller JID to voted days');
}

function getAvailableCallersToday(rosterRows) {
  const todayName = DAYS_OF_WEEK[getISTNow().getDay()];
  let votes = {};
  try { votes = JSON.parse(state.settings.OUTREACH_AVAIL_VOTES || '{}'); } catch {}

  const activeRoster = rosterRows
    .filter((r) => (r[0] || '').trim() && String(r[2] || '').trim().toLowerCase() === 'yes')
    .map((r) => ({
      name: (r[0] || '').trim(),
      phone10: last10(r[1] || ''),
      cap: Number(r[3]) || Number(state.settings.OUTREACH_DAILY_CAP || 5),
    }));

  const voteEntries = Object.entries(votes);
  if (!voteEntries.length) return activeRoster;

  return activeRoster.filter((c) => {
    const v = votes[c.phone10] || voteEntries.find(([, val]) => (val.name || '').toLowerCase() === c.name.toLowerCase())?.[1];
    return v && Array.isArray(v.days) && v.days.includes(todayName);
  });
}

async function assignDailyCalls({ sendGroupMentionText, sendNotice }) {
  const masterId = getOutreachSheetId();
  const dashId = getDashboardSheetId();
  const [masterRows, rosterRows] = await Promise.all([
    google.getRows(masterId, 'Master_Outreach!A2:O').catch(() => []),
    google.getRows(masterId, 'Callers_Roster!A2:E').catch(() => []),
  ]);

  const availableCallers = getAvailableCallersToday(rosterRows);
  if (!availableCallers.length) {
    if (sendNotice) await sendNotice('⚠️ No callers marked available for today—skipping daily assignment.');
    return;
  }

  const todayStr = formatISTDate();
  const eligible = [];
  for (let i = 0; i < masterRows.length; i++) {
    const r = Array.from({ length: 15 }, (_, idx) => (masterRows[i][idx] || '').trim());
    if (r[6].toLowerCase() === 'exited' || !last10(r[2])) continue;
    const status = r[10] || 'Not Called';
    const nextDate = r[13] || '';
    const isDueFollowUp = (status === 'Callback Scheduled' || status === 'Not Answered') && (!nextDate || nextDate <= todayStr);
    const isNew = status === 'Not Called';
    if (isNew || isDueFollowUp) eligible.push({ rowIndex: i, row: r });
  }

  const assignedByCaller = new Map(availableCallers.map((c) => [c.name, []]));
  const remainingQueue = [];

  for (const item of eligible) {
    const prevCaller = item.row[9];
    const match = availableCallers.find((c) => c.name.toLowerCase() === prevCaller.toLowerCase());
    if (match && assignedByCaller.get(match.name).length < match.cap) {
      assignedByCaller.get(match.name).push(item);
    } else {
      remainingQueue.push(item);
    }
  }

  let ptr = 0;
  for (const item of remainingQueue) {
    let attempts = 0;
    while (attempts < availableCallers.length) {
      const c = availableCallers[ptr % availableCallers.length];
      ptr++;
      attempts++;
      if (assignedByCaller.get(c.name).length < c.cap) {
        item.row[9] = c.name;
        assignedByCaller.get(c.name).push(item);
        break;
      }
    }
  }

  const todaysCallsRows = [];
  const summaryParts = [];
  const mentions = [];

  for (const c of availableCallers) {
    const list = assignedByCaller.get(c.name) || [];
    if (!list.length) continue;
    if (c.phone10) mentions.push(`91${c.phone10}@s.whatsapp.net`);
    summaryParts.push(`${c.phone10 ? `@91${c.phone10}` : c.name} (${list.length})`);
    list.forEach((item, idx) => {
      const r = item.row;
      const formUrl = buildPrefilledFormUrl({ caller: c.name, name: r[1], phone: r[2], event: r[5] });
      const roleCollege = [r[7], r[8]].filter(Boolean).join(' — ');
      todaysCallsRows.push([c.name, String(idx + 1), r[1], r[2], r[5], roleCollege, formUrl, '⏳ Pending']);
      masterRows[item.rowIndex] = r;
    });
  }

  const tHeaders = ['Caller', 'S. No.', 'Contact Name', 'Phone', 'Event / Source', 'Role / College', 'Log Call Link', 'Logged Today?'];
  await google.rewriteTab(dashId, "Today's Calls", tHeaders, todaysCallsRows);

  const mHeaders = ['S. No.', 'Name', 'Phone', 'Primary_Group', 'All_Groups', 'Event / Source', 'Member_Status', 'Role', 'College / Institute', 'Assigned_Caller', 'Call_Status', 'Response', 'Activity_Interest', 'Next_FollowUp_Date', 'Notes & TG_Log'];
  await google.rewriteTab(masterId, 'Master_Outreach', mHeaders, masterRows);

  const callersJid = getCallersGroupJid();
  if (callersJid && sendGroupMentionText && summaryParts.length) {
    const dashUrl = `https://docs.google.com/spreadsheets/d/${dashId}/edit`;
    await sendGroupMentionText(
      callersJid,
      `☀️ *Today's Calls Assigned (${todayStr}):*\n${summaryParts.join(', ')}\n\n📋 Open *Today's Calls* & tap *Log Call Link* after each call:\n${dashUrl}`,
      mentions
    );
  }
  if (sendNotice) await sendNotice(`✅ Assigned *${todaysCallsRows.length}* calls across *${summaryParts.length}* caller(s).`);
}

async function handleCallerUnavailable({ senderJid, sendGroupMentionText, sendNotice }) {
  const p10 = last10(senderJid);
  const masterId = getOutreachSheetId();
  const dashId = getDashboardSheetId();
  const [rosterRows, todaysRows] = await Promise.all([
    google.getRows(masterId, 'Callers_Roster!A2:E').catch(() => []),
    google.getRows(dashId, "Today's Calls!A2:H").catch(() => []),
  ]);

  const caller = rosterRows.find((r) => last10(r[1] || '') === p10);
  if (!caller) return false;
  const callerName = (caller[0] || '').trim();

  const available = getAvailableCallersToday(rosterRows).filter((c) => c.name.toLowerCase() !== callerName.toLowerCase());
  if (!available.length) {
    if (sendNotice) await sendNotice(`⚠️ *${callerName}* marked unavailable, but no other callers are available today.`);
    return true;
  }

  const newlyAssigned = new Map();
  let idx = 0;
  for (const r of todaysRows) {
    if ((r[0] || '').trim().toLowerCase() === callerName.toLowerCase() && (r[7] || '').includes('Pending')) {
      const nextC = available[idx % available.length];
      idx++;
      r[0] = nextC.name;
      r[6] = buildPrefilledFormUrl({ caller: nextC.name, name: r[2], phone: r[3], event: r[4] });
      newlyAssigned.set(nextC.name, (newlyAssigned.get(nextC.name) || 0) + 1);
    }
  }

  if (idx > 0) {
    const tHeaders = ['Caller', 'S. No.', 'Contact Name', 'Phone', 'Event / Source', 'Role / College', 'Log Call Link', 'Logged Today?'];
    await google.rewriteTab(dashId, "Today's Calls", tHeaders, todaysRows);
    const mentions = [];
    const tags = [];
    for (const [name, cnt] of newlyAssigned.entries()) {
      const cObj = available.find((x) => x.name === name);
      if (cObj?.phone10) {
        mentions.push(`91${cObj.phone10}@s.whatsapp.net`);
        tags.push(`@91${cObj.phone10} (+${cnt})`);
      } else {
        tags.push(`${name} (+${cnt})`);
      }
    }
    const callersJid = getCallersGroupJid();
    if (callersJid && sendGroupMentionText) {
      await sendGroupMentionText(callersJid, `🔄 *${callerName}* is unavailable today. Reassigned *${idx}* pending call(s) to: ${tags.join(', ')}`, mentions);
    }
  }
  return true;
}

async function syncFormResponsesAndReport({ sendNotice, sendReport = false }) {
  const masterId = getOutreachSheetId();
  const dashId = getDashboardSheetId();
  const formRows = await google.getRows(masterId, 'Form Responses 1!A2:I').catch(() => []);
  const masterRows = await google.getRows(masterId, 'Master_Outreach!A2:O').catch(() => []);
  const todaysRows = await google.getRows(dashId, "Today's Calls!A2:H").catch(() => []);

  const latestMap = new Map();
  const dupCounts = new Map();
  for (const f of formRows) {
    const p10 = last10(f[3] || '');
    if (!p10) continue;
    const key = `${p10}:${(f[1] || '').trim().toLowerCase()}`;
    dupCounts.set(key, (dupCounts.get(key) || 0) + 1);
    latestMap.set(p10, {
      date: (f[0] || '').split(' ')[0] || formatISTDate(),
      caller: (f[1] || '').trim(),
      name: (f[2] || '').trim(),
      phone: p10,
      event: (f[4] || '').trim(),
      status: (f[5] || '').trim(),
      response: (f[6] || '').trim(),
      interest: (f[7] || '').trim(),
      notes: (f[8] || '').trim(),
    });
  }

  let updated = 0;
  for (const r of masterRows) {
    const p10 = last10(r[2] || '');
    const sub = latestMap.get(p10);
    if (!sub) continue;
    if (sub.caller) r[9] = sub.caller;
    if (sub.status) r[10] = sub.status;
    if (sub.response) r[11] = sub.response;
    if (sub.interest) r[12] = sub.interest;
    if (sub.notes) r[14] = sub.notes;
    if (!r[13]) {
      const nextD = new Date(getISTNow().getTime() + 15 * 86400000);
      r[13] = formatISTDate(nextD);
    }
    updated++;
  }

  for (const t of todaysRows) {
    const p10 = last10(t[3] || '');
    if (latestMap.has(p10)) t[7] = '✅ Done';
  }

  if (updated > 0) {
    const mHeaders = ['S. No.', 'Name', 'Phone', 'Primary_Group', 'All_Groups', 'Event / Source', 'Member_Status', 'Role', 'College / Institute', 'Assigned_Caller', 'Call_Status', 'Response', 'Activity_Interest', 'Next_FollowUp_Date', 'Notes & TG_Log'];
    await google.rewriteTab(masterId, 'Master_Outreach', mHeaders, masterRows);
    const tHeaders = ['Caller', 'S. No.', 'Contact Name', 'Phone', 'Event / Source', 'Role / College', 'Log Call Link', 'Logged Today?'];
    await google.rewriteTab(dashId, "Today's Calls", tHeaders, todaysRows);
  }

  if (sendReport && sendNotice) {
    const stats = new Map();
    for (const t of todaysRows) {
      const c = (t[0] || '').trim();
      if (!c) continue;
      const cur = stats.get(c) || { total: 0, done: 0 };
      cur.total++;
      if ((t[7] || '').includes('Done')) cur.done++;
      stats.set(c, cur);
    }
    const lines = [...stats.entries()].map(([c, s]) => `• *${c}:* ${s.done}/${s.total} ${s.done === s.total ? '✅' : '⚠️'}`);
    const anomalies = [...dupCounts.values()].filter((v) => v >= 3).length;
    await sendNotice(
      `📊 *Daily Call Accountability Report (${formatISTDate()})*\n${lines.length ? lines.join('\n') : 'No calls assigned today.'}${anomalies ? `\n\n🔔 *${anomalies}* item(s) pending your review (3+ submissions).` : ''}`
    );
  }
}

async function checkKeywordGroupDiscovery({ sock, groupJid, sendNotice }) {
  if (!groupJid || alertedKeywordGroups.has(groupJid)) return;
  const alreadyTracked = state.trackedGroups.some((t) => t.groupJid === groupJid);
  if (alreadyTracked) return;
  const meta = await sock.groupMetadata(groupJid).catch(() => null);
  const name = meta?.subject || '';
  if (!name) return;
  if (/(event|response|outreach|climate|vsc|readspace)/i.test(name)) {
    alertedKeywordGroups.add(groupJid);
    if (sendNotice) {
      await sendNotice(`🔎 Detected group *${name}* (\`${groupJid}\`) matching outreach keywords.\nRun \`#track_members ${groupJid}\` in your Outreach Control group to start tracking it.`);
    }
  }
}

module.exports = {
  getOutreachControlJid,
  getCallersGroupJid,
  syncMasterOutreach,
  cleanExitedMembers,
  sendWeeklyAvailabilityPoll,
  handleAvailabilityVote,
  assignDailyCalls,
  handleCallerUnavailable,
  syncFormResponsesAndReport,
  checkKeywordGroupDiscovery,
};
