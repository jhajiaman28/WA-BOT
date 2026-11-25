const { formatISTDate, formatISTTimestamp, normalizePhone, MASTER_SHEET_ID } = require('./config');
const google = require('./google');
const { state } = require('./state');

function resolveName(jid, groupKey = '') {
  const clean = normalizePhone(jid);
  const reg = state.members.find((m) =>
    (!groupKey || m.groupKey === groupKey) &&
    (m.phoneJid === jid || m.lid === jid || (clean && (normalizePhone(m.phoneJid) === clean || normalizePhone(m.lid) === clean)))
  );
  if (reg?.officialName) return reg.officialName;
  const cached = state.contacts.get(jid) || (clean ? state.contacts.get(`${clean}@s.whatsapp.net`) : '');
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

async function ensureTrackerTabs(sheetId) {
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
}

async function askGroupConfirmation({ sock, group, customSheetUrl, sendControlMsg }) {
  const count = group.participants?.length || '?';
  const m = await sendControlMsg(
    `📌 *Confirm Group to Track:*\n• Name: *${group.subject}*\n• JID: \`${group.id}\`\n• Members: *${count}*\n\nQuote-reply *Yes* to create its sheet, or reply with the exact *Group Name* / *Group JID* to pick another, or *Cancel*.`
  );
  if (m?.key?.id) {
    state.pendingPrompts.set(m.key.id, {
      type: 'TRACK_CONFIRM_GROUP',
      sock,
      group,
      customSheetUrl,
    });
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
  if (matches.length === 1) {
    return askGroupConfirmation({ sock, group: matches[0], customSheetUrl, sendControlMsg });
  }

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
  if (existing) {
    return sendControlMsg(`ℹ️ *${group.subject}* is already tracked:\n${existing.sheetUrl}`);
  }

  const progress = new LiveProgress(sendControlMsg, editControlMsg, deleteControlMsg);
  await progress.update(`⏳ Command received for *${group.subject}*...`);

  let sheetId = '';
  if (customSheetUrl) {
    await progress.update(`🗂️ Setting up tabs & headers in provided sheet...`);
    const m = customSheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    sheetId = m ? m[1] : customSheetUrl.trim();
    await ensureTrackerTabs(sheetId);
  } else {
    await progress.update(`📄 Creating new Google Sheet & formatting tabs...`);
    sheetId = await google.createTrackerSpreadsheet(`Members - ${group.subject}`);
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  await progress.update(`👥 Fetching existing members from *${group.subject}*...`);
  const meta = await sock.groupMetadata(group.id);
  const binding = state.bindings.find((b) => b.groupJid === group.id);
  const groupKey = binding?.bindKey || '';
  const { date, time } = splitDateTime();

  const initialRows = (meta.participants || []).map((p) => [
    resolveName(p.id, groupKey),
    formatID(p.id),
    'Initial',
    date,
    time,
  ]);

  await progress.update(`✍️ Adding *${initialRows.length}* existing members to *Current_Members*...`);
  if (initialRows.length) {
    await google.updateRange(sheetId, 'Current_Members!A2', initialRows, 'RAW');
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
  const val = enabled ? 'TRUE' : 'FALSE';
  if (idx >= 0) await google.updateRange(MASTER_SHEET_ID, `Tracked_Groups!G${idx + 2}`, [[val]]);
  target.notifyControl = enabled;
  return sendControlMsg(`🔔 Entry/Exit alerts for *${target.groupName}* turned *${enabled ? 'ON' : 'OFF'}*.`);
}

async function handleParticipantEvent({ groupJid, participants, action, sendControlMsg }) {
  const tracked = state.trackedGroups.find((t) => t.groupJid === groupJid && t.status === 'ACTIVE');
  if (!tracked) return;

  const binding = state.bindings.find((b) => b.groupJid === groupJid);
  const groupKey = binding?.bindKey || '';
  const { date, time } = splitDateTime();

  const curRows = await google.getRows(tracked.sheetId, 'Current_Members!A2:E').catch(() => []);
  const exitRows = await google.getRows(tracked.sheetId, 'Exited_Members!A2:E').catch(() => []);
  let curChanged = false;
  let exitChanged = false;

  for (const p of participants) {
    const idStr = formatID(p);
    if (action === 'add') {
      const exIdx = exitRows.findIndex((r) => (r[1] || '').trim() === idStr);
      if (exIdx >= 0) { exitRows.splice(exIdx, 1); exitChanged = true; }
      const already = curRows.some((r) => (r[1] || '').trim() === idStr);
      const name = resolveName(p, groupKey);
      if (!already) {
        curRows.push([name, idStr, 'Joined', date, time]);
        curChanged = true;
      }
      if (tracked.notifyControl && sendControlMsg) {
        await sendControlMsg(`👋 *Joined* *${tracked.groupName}*: ${name} (${idStr})`);
      }
    } else if (action === 'remove' || action === 'leave') {
      const curIdx = curRows.findIndex((r) => (r[1] || '').trim() === idStr);
      const name = curIdx >= 0 ? curRows[curIdx][0] : resolveName(p, groupKey);
      if (curIdx >= 0) { curRows.splice(curIdx, 1); curChanged = true; }
      const exIdx = exitRows.findIndex((r) => (r[1] || '').trim() === idStr);
      const actLabel = action === 'remove' ? 'Removed' : 'Left';
      if (exIdx >= 0) {
        exitRows[exIdx] = [name, idStr, date, time, actLabel];
      } else {
        exitRows.push([name, idStr, date, time, actLabel]);
      }
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
  if (!active.length) return;

  const { date, time } = splitDateTime();
  for (const tracked of active) {
    try {
      const meta = await sock.groupMetadata(tracked.groupJid);
      const liveIds = new Set((meta.participants || []).map((p) => formatID(p.id)));
      const liveMap = new Map((meta.participants || []).map((p) => [formatID(p.id), p.id]));
      const binding = state.bindings.find((b) => b.groupJid === tracked.groupJid);
      const groupKey = binding?.bindKey || '';

      const curRows = await google.getRows(tracked.sheetId, 'Current_Members!A2:E').catch(() => []);
      const exitRows = await google.getRows(tracked.sheetId, 'Exited_Members!A2:E').catch(() => []);
      let curChanged = false;
      let exitChanged = false;

      const keptCur = [];
      for (const r of curRows) {
        const idStr = (r[1] || '').trim();
        if (!idStr) continue;
        if (!liveIds.has(idStr)) {
          const exIdx = exitRows.findIndex((e) => (e[1] || '').trim() === idStr);
          const row = [r[0] || '(Pending Name)', idStr, date, time, 'Left/Removed (Offline Sync)'];
          if (exIdx >= 0) exitRows[exIdx] = row;
          else exitRows.push(row);
          curChanged = true;
          exitChanged = true;
        } else {
          if (r[0] === '(Pending Name)' && liveMap.has(idStr)) {
            const resolved = resolveName(liveMap.get(idStr), groupKey);
            if (resolved !== '(Pending Name)') { r[0] = resolved; curChanged = true; }
          }
          keptCur.push(r);
        }
      }

      const curSet = new Set(keptCur.map((r) => (r[1] || '').trim()));
      for (const [idStr, jid] of liveMap.entries()) {
        if (!curSet.has(idStr)) {
          const exIdx = exitRows.findIndex((e) => (e[1] || '').trim() === idStr);
          if (exIdx >= 0) { exitRows.splice(exIdx, 1); exitChanged = true; }
          keptCur.push([resolveName(jid, groupKey), idStr, 'Joined (Offline Sync)', date, time]);
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
