const { formatISTDate, formatISTTimestamp, normalizePhone, MASTER_SHEET_ID } = require('./config');
const google = require('./google');
const { state } = require('./state');

const EXTERNAL_DIRECTORY_SHEETS = [
  { sheetId: '1UswDXWaXQkAROITS-bdoB05WBWdjPsAEp6_NmSoYGks', range: 'Outreach Tracker!B2:C' },
];

async function loadExternalDirectory() {
  const map = new Map();
  for (const src of EXTERNAL_DIRECTORY_SHEETS) {
    try {
      const rows = await google.getRows(src.sheetId, src.range);
      for (const [name, phone] of rows) {
        const clean = normalizePhone(phone);
        const last10 = clean.length >= 10 ? clean.slice(-10) : '';
        const cleanName = (name || '').trim();
        if (last10 && cleanName && !/^\+?\d[\d\s-]+$/.test(cleanName)) {
          map.set(last10, cleanName);
        }
      }
    } catch {
      // ignore if external sheet isn't shared yet
    }
  }
  return map;
}

async function resolvePhoneJid(participantObj, sock, groupKey = '') {
  const rawId = typeof participantObj === 'string' ? participantObj : participantObj?.id;
  if (!rawId) return '';
  if (typeof participantObj === 'object' && participantObj?.phoneNumber) {
    return participantObj.phoneNumber;
  }
  if (rawId.endsWith('@s.whatsapp.net')) return rawId;

  if (rawId.endsWith('@lid')) {
    try {
      const mapped = await sock?.signalRepository?.lidMapping?.getPNForLID?.(rawId);
      if (mapped) return mapped;
    } catch {}
    const reg = state.members.find((m) => (!groupKey || m.groupKey === groupKey) && m.lid === rawId && m.phoneJid);
    if (reg?.phoneJid) return reg.phoneJid;
  }
  return rawId;
}

function resolveName(rawJid, resolvedJid, groupKey = '', extMap = new Map()) {
  const cleanRaw = normalizePhone(rawJid);
  const cleanRes = normalizePhone(resolvedJid);
  const reg = state.members.find((m) =>
    (!groupKey || m.groupKey === groupKey) &&
    (m.phoneJid === resolvedJid || m.lid === rawJid || (cleanRes && normalizePhone(m.phoneJid) === cleanRes))
  );
  if (reg?.officialName) return reg.officialName;

  const last10 = cleanRes.length >= 10 ? cleanRes.slice(-10) : '';
  if (last10 && extMap.has(last10)) return extMap.get(last10);

  const cached = state.contacts.get(resolvedJid) || state.contacts.get(rawJid) || (cleanRes ? state.contacts.get(`${cleanRes}@s.whatsapp.net`) : '');
  return cached || '(Pending Name)';
}

function formatID(jid) {
  if (!jid) return '';
  if (jid.endsWith('@lid')) return jid;
  const clean = normalizePhone(jid);
  return clean ? `+${clean}` : jid;
}

function splitDateTime() {
  const full = formatISTTimestamp();
  const [datePart, ...rest] = full.split(',');
  return { date: (datePart || formatISTDate()).trim(), time: rest.join(',').trim() };
}

class LiveProgress {
  constructor(sendControlMsg, editControlMsg, deleteControlMsg) {
    this.send = sendControlMsg;
    this.edit = editControlMsg;
    this.del = deleteControlMsg;
    this.msg = null;
    this.sentAt = 0;
  }

  async update(text) {
    if (!this.msg?.key) {
      this.msg = await this.send(text);
      this.sentAt = Date.now();
      return;
    }
    const over14Min = Date.now() - this.sentAt > 14 * 60 * 1000;
    const ok = !over14Min ? await this.edit(this.msg.key, text) : false;
    if (!ok) {
      await this.del(this.msg.key);
      this.msg = await this.send(text);
      this.sentAt = Date.now();
    }
  }
}

async function ensureTrackerTabs(sheetId, groupName) {
  await google.renameSpreadsheetIfUntitled(sheetId, `Members - ${groupName}`).catch(() => {});
  const existing = await google.getRows(sheetId, 'Current_Members!A1:E1').catch(() => null);
  if (!existing) {
    await google.createTabIfMissing(sheetId, 'Current_Members');
    await google.updateRange(sheetId, 'Current_Members!A1:E1', [['Name', 'Phone_or_ID', 'Entry_Type', 'Joined_Date', 'Joined_Time']], 'RAW');
  }
  const exited = await google.getRows(sheetId, 'Exited_Members!A1:E1').catch(() => null);
  if (!exited) {
    await google.createTabIfMissing(sheetId, 'Exited_Members');
    await google.updateRange(sheetId, 'Exited_Members!A1:E1', [['Name', 'Phone_or_ID', 'Exit_Date', 'Exit_Time', 'Action']], 'RAW');
  }
  await google.formatTrackerSheet(sheetId).catch(() => {});
}

async function askGroupConfirmation({ sock, group, customSheetUrl, sendControlMsg }) {
  const count = group.participants?.length || '?';
  const m = await sendControlMsg(
    `📌 *Confirm Group to Track:*\n• Name: *${group.subject}*\n• JID: \`${group.id}\`\n• Members: *${count}*\n\nQuote-reply *Yes* to create its sheet, or reply with the exact *Group Name* / *Group JID* to pick another, or *Cancel*.`
  );
  if (m?.key?.id) {
    state.pendingPrompts.set(m.key.id, { type: 'TRACK_CONFIRM_GROUP', sock, group, customSheetUrl });
  }
}

async function startTrackingGroup({ sock, query, customSheetUrl, sendControlMsg }) {
  await sendControlMsg('🔍 Searching groups...');
  if (query && query.includes('@g.us')) {
    const meta = await sock.groupMetadata(query.trim()).catch(() => null);
    if (!meta) return sendControlMsg(`⚠️ Could not find group with JID \`${query.trim()}\`.`);
    return askGroupConfirmation({ sock, group: meta, customSheetUrl, sendControlMsg });
  }

  const rawGroups = await Promise.race([
    sock.groupFetchAllParticipating(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Group fetch timed out')), 15000)),
  ]);
  const all = Object.values(rawGroups);
  const matches = query ? all.filter((g) => (g.subject || '').toLowerCase().includes(query.toLowerCase())) : all;

  if (!matches.length) return sendControlMsg(`⚠️ No group matched "${query}".`);
  if (matches.length === 1) return askGroupConfirmation({ sock, group: matches[0], customSheetUrl, sendControlMsg });

  const list = matches.slice(0, 15).map((g, i) => `${i + 1}. *${g.subject}* (${g.participants?.length || 0} members)`).join('\n');
  const m = await sendControlMsg(`*Multiple groups matched:*\n${list}\n\nQuote-reply with the number (e.g. *1*) to confirm, or *Cancel*.`);
  if (m?.key?.id) {
    state.pendingPrompts.set(m.key.id, { type: 'TRACK_PICK_GROUP', sock, groups: matches.slice(0, 15), customSheetUrl });
  }
}

async function resolveAndConfirmOther({ sock, replyText, customSheetUrl, sendControlMsg }) {
  const input = replyText.trim();
  if (input.includes('@g.us')) {
    const meta = await sock.groupMetadata(input).catch(() => null);
    if (!meta) return sendControlMsg(`⚠️ Could not find group JID \`${input}\`.`);
    return askGroupConfirmation({ sock, group: meta, customSheetUrl, sendControlMsg });
  }
  const rawGroups = await sock.groupFetchAllParticipating();
  const all = Object.values(rawGroups);
  const exact = all.find((g) => (g.subject || '').toLowerCase() === input.toLowerCase())
    || all.find((g) => (g.subject || '').toLowerCase().includes(input.toLowerCase()));
  if (!exact) return sendControlMsg(`⚠️ No group matched "${input}". Try sending the exact Group JID (\`...@g.us\`).`);
  return askGroupConfirmation({ sock, group: exact, customSheetUrl, sendControlMsg });
}

async function setupGroupTrackerSheet({ sock, group, customSheetUrl, sendControlMsg, editControlMsg, deleteControlMsg }) {
  const existing = state.trackedGroups.find((t) => t.groupJid === group.id && t.status === 'ACTIVE');
  if (existing) return sendControlMsg(`ℹ️ *${group.subject}* is already tracked:\n${existing.sheetUrl}`);

  const progress = new LiveProgress(sendControlMsg, editControlMsg, deleteControlMsg);
  await progress.update(`⏳ Command received for *${group.subject}*...`);

  let sheetId = '';
  if (customSheetUrl) {
    await progress.update(`🗂️ Naming sheet, setting up tabs & formatting...`);
    const m = customSheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    sheetId = m ? m[1] : customSheetUrl.trim();
    await ensureTrackerTabs(sheetId, group.subject);
  } else {
    await progress.update(`📄 Creating new Google Sheet & formatting tabs...`);
    sheetId = await google.createTrackerSpreadsheet(`Members - ${group.subject}`);
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  await progress.update(`👥 Fetching members & matching known directories...`);
  const meta = await sock.groupMetadata(group.id);
  const extMap = await loadExternalDirectory();
  const binding = state.bindings.find((b) => b.groupJid === group.id);
  const groupKey = binding?.bindKey || '';
  const { date, time } = splitDateTime();

  const initialRows = [];
  for (const p of meta.participants || []) {
    const resolvedJid = await resolvePhoneJid(p, sock, groupKey);
    initialRows.push([resolveName(p.id, resolvedJid, groupKey, extMap), formatID(resolvedJid), 'Initial', date, time]);
  }

  await progress.update(`✍️ Adding *${initialRows.length}* existing members to *Current_Members*...`);
  if (initialRows.length) {
    await google.updateRange(sheetId, 'Current_Members!A2', initialRows, 'RAW');
    await google.formatTrackerSheet(sheetId).catch(() => {});
  }

  await progress.update(`🔗 Saving tracker to Master Sheet...`);
  const createdAt = formatISTTimestamp();
  await google.appendRow(MASTER_SHEET_ID, 'Tracked_Groups', [group.subject, group.id, sheetId, sheetUrl, createdAt, 'ACTIVE', 'FALSE']);
  state.trackedGroups.push({ groupName: group.subject, groupJid: group.id, sheetId, sheetUrl, createdAt, status: 'ACTIVE', notifyControl: false });

  await progress.update(`✅ Done! Now tracking *${group.subject}* (*${initialRows.length}* initial members).\n📊 Sheet: ${sheetUrl}`);
}

async function untrackGroup({ query, sendControlMsg }) {
  const target = state.trackedGroups.find(
    (t) => t.status === 'ACTIVE' && (t.groupName.toLowerCase().includes(query.toLowerCase()) || t.groupJid === query)
  );
  if (!target) return sendControlMsg(`⚠️ No active tracked group matched "${query}".`);

  const rows = await google.getRows(MASTER_SHEET_ID, 'Tracked_Groups!A2:G');
  const idx = rows.findIndex((r) => (r[1] || '').trim() === target.groupJid && (r[5] || '').trim() === 'ACTIVE');
  if (idx >= 0) await google.updateRange(MASTER_SHEET_ID, `Tracked_Groups!F${idx + 2}`, [['PAUSED']]);
  target.status = 'PAUSED';
  return sendControlMsg(`⏸️ Stopped member tracking for *${target.groupName}*.`);
}

async function toggleNotify({ query, enabled, sendControlMsg }) {
  const target = state.trackedGroups.find(
    (t) => t.status === 'ACTIVE' && (t.groupName.toLowerCase().includes(query.toLowerCase()) || t.groupJid === query)
  );
  if (!target) return sendControlMsg(`⚠️ No active tracked group matched "${query}".`);

  const rows = await google.getRows(MASTER_SHEET_ID, 'Tracked_Groups!A2:G');
  const idx = rows.findIndex((r) => (r[1] || '').trim() === target.groupJid && (r[5] || '').trim() === 'ACTIVE');
  if (idx >= 0) await google.updateRange(MASTER_SHEET_ID, `Tracked_Groups!G${idx + 2}`, [[enabled ? 'TRUE' : 'FALSE']]);
  target.notifyControl = enabled;
  return sendControlMsg(`🔔 Entry/Exit alerts for *${target.groupName}* turned *${enabled ? 'ON' : 'OFF'}*.`);
}

async function handleParticipantEvent({ groupJid, participants, action, sendControlMsg, sock }) {
  const tracked = state.trackedGroups.find((t) => t.groupJid === groupJid && t.status === 'ACTIVE');
  if (!tracked) return;

  const extMap = await loadExternalDirectory();
  const binding = state.bindings.find((b) => b.groupJid === groupJid);
  const groupKey = binding?.bindKey || '';
  const { date, time } = splitDateTime();

  const curRows = await google.getRows(tracked.sheetId, 'Current_Members!A2:E').catch(() => []);
  const exitRows = await google.getRows(tracked.sheetId, 'Exited_Members!A2:E').catch(() => []);
  let curChanged = false;
  let exitChanged = false;

  for (const p of participants) {
    const resolvedJid = await resolvePhoneJid(p, sock, groupKey);
    const idStr = formatID(resolvedJid);
    const rawIdStr = formatID(p);

    if (action === 'add') {
      const exIdx = exitRows.findIndex((r) => (r[1] || '').trim() === idStr || (r[1] || '').trim() === rawIdStr);
      if (exIdx >= 0) { exitRows.splice(exIdx, 1); exitChanged = true; }
      const already = curRows.some((r) => (r[1] || '').trim() === idStr || (r[1] || '').trim() === rawIdStr);
      const name = resolveName(p, resolvedJid, groupKey, extMap);
      if (!already) {
        curRows.push([name, idStr, 'Joined', date, time]);
        curChanged = true;
      }
      if (tracked.notifyControl && sendControlMsg) {
        await sendControlMsg(`👋 *Joined* *${tracked.groupName}*: ${name} (${idStr})`);
      }
    } else if (action === 'remove' || action === 'leave') {
      const curIdx = curRows.findIndex((r) => (r[1] || '').trim() === idStr || (r[1] || '').trim() === rawIdStr);
      const name = curIdx >= 0 ? curRows[curIdx][0] : resolveName(p, resolvedJid, groupKey, extMap);
      if (curIdx >= 0) { curRows.splice(curIdx, 1); curChanged = true; }
      const exIdx = exitRows.findIndex((r) => (r[1] || '').trim() === idStr || (r[1] || '').trim() === rawIdStr);
      const actLabel = action === 'remove' ? 'Removed' : 'Left';
      if (exIdx >= 0) exitRows[exIdx] = [name, idStr, date, time, actLabel];
      else exitRows.push([name, idStr, date, time, actLabel]);
      exitChanged = true;
      if (tracked.notifyControl && sendControlMsg) {
        await sendControlMsg(`🚪 *${actLabel}* *${tracked.groupName}*: ${name} (${idStr})`);
      }
    }
  }

  if (curChanged) await google.rewriteTab(tracked.sheetId, 'Current_Members', ['Name', 'Phone_or_ID', 'Entry_Type', 'Joined_Date', 'Joined_Time'], curRows);
  if (exitChanged) await google.rewriteTab(tracked.sheetId, 'Exited_Members', ['Name', 'Phone_or_ID', 'Exit_Date', 'Exit_Time', 'Action'], exitRows);
}

async function syncOfflineChanges(sock) {
  const active = state.trackedGroups.filter((t) => t.status === 'ACTIVE');
  if (!active.length || !sock) return;

  const extMap = await loadExternalDirectory();
  const { date, time } = splitDateTime();

  for (const tracked of active) {
    try {
      const meta = await sock.groupMetadata(tracked.groupJid);
      const binding = state.bindings.find((b) => b.groupJid === tracked.groupJid);
      const groupKey = binding?.bindKey || '';

      const liveEntries = [];
      const liveAllIds = new Set();
      for (const p of meta.participants || []) {
        const resolvedJid = await resolvePhoneJid(p, sock, groupKey);
        const idStr = formatID(resolvedJid);
        const rawIdStr = formatID(p.id);
        liveAllIds.add(idStr);
        liveAllIds.add(rawIdStr);
        liveEntries.push({ rawJid: p.id, resolvedJid, idStr, rawIdStr });
      }

      const curRows = await google.getRows(tracked.sheetId, 'Current_Members!A2:E').catch(() => []);
      const exitRows = await google.getRows(tracked.sheetId, 'Exited_Members!A2:E').catch(() => []);
      let curChanged = false;
      let exitChanged = false;

      const keptCur = [];
      for (const r of curRows) {
        const rowId = (r[1] || '').trim();
        if (!rowId) continue;
        if (!liveAllIds.has(rowId)) {
          const exIdx = exitRows.findIndex((e) => (e[1] || '').trim() === rowId);
          const row = [r[0] || '(Pending Name)', rowId, date, time, 'Left/Removed (Offline Sync)'];
          if (exIdx >= 0) exitRows[exIdx] = row;
          else exitRows.push(row);
          curChanged = true;
          exitChanged = true;
        } else {
          const match = liveEntries.find((e) => e.idStr === rowId || e.rawIdStr === rowId);
          if (match) {
            if (rowId.endsWith('@lid') && !match.idStr.endsWith('@lid')) {
              r[1] = match.idStr;
              curChanged = true;
            }
            if (!r[0] || r[0] === '(Pending Name)') {
              const resolvedName = resolveName(match.rawJid, match.resolvedJid, groupKey, extMap);
              if (resolvedName !== '(Pending Name)') { r[0] = resolvedName; curChanged = true; }
            }
          }
          keptCur.push(r);
        }
      }

      const curSet = new Set(keptCur.map((r) => (r[1] || '').trim()));
      for (const e of liveEntries) {
        if (!curSet.has(e.idStr) && !curSet.has(e.rawIdStr)) {
          const exIdx = exitRows.findIndex((x) => (x[1] || '').trim() === e.idStr || (x[1] || '').trim() === e.rawIdStr);
          if (exIdx >= 0) { exitRows.splice(exIdx, 1); exitChanged = true; }
          keptCur.push([resolveName(e.rawJid, e.resolvedJid, groupKey, extMap), e.idStr, 'Joined (Offline Sync)', date, time]);
          curChanged = true;
        }
      }

      if (curChanged) await google.rewriteTab(tracked.sheetId, 'Current_Members', ['Name', 'Phone_or_ID', 'Entry_Type', 'Joined_Date', 'Joined_Time'], keptCur);
      if (exitChanged) await google.rewriteTab(tracked.sheetId, 'Exited_Members', ['Name', 'Phone_or_ID', 'Exit_Date', 'Exit_Time', 'Action'], exitRows);
    } catch (err) {
      console.error(`[MemberTracker OfflineSync] ${tracked.groupName}:`, err.message);
    }
  }
}

module.exports = {
  startTrackingGroup,
  setupGroupTrackerSheet,
  resolveAndConfirmOther,
  untrackGroup,
  toggleNotify,
  handleParticipantEvent,
  syncOfflineChanges,
};
