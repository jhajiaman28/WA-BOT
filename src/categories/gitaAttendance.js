const { formatISTDate, normalizePhone } = require('../config');
const google = require('../google');
const { state, findMember, registerMember, saveActivePoll } = require('../state');

const CATEGORY = 'gita_attendance';

async function getSheetLayout(sheetId, tabName) {
  const rows = await google.getRows(sheetId, `${tabName}!A1:BZ`);
  const headerRow = rows[1] || [];
  const members = [];
  for (let c = 5; c < headerRow.length; c++) {
    const name = (headerRow[c] || '').trim();
    if (name) members.push({ name, colIndex: c, colLetter: google.colIndexToLetter(c) });
  }
  return { rows, members };
}

function findDateRow(rows, targetDate) {
  for (let r = 2; r < rows.length; r++) {
    if ((rows[r]?.[1] || '').trim() === targetDate) {
      return { rowNum: r + 1, sessionName: (rows[r]?.[3] || '').trim() };
    }
  }
  return null;
}

function buildPollPayload(dateStr, sessionName, fourthOption = '😒Not Interested') {
  const lower = (sessionName || '').toLowerCase();
  const isExam = lower.includes('exam session');
  const isExclusive = lower.includes('exclusive session');
  const options = isExam
    ? ['✅Attempted Both', '🌱Attempted - Novice/नवशिक्षु', '🔰Attempted - Beginner/आरंभक', '❌Busy/Slept/Forget']
    : ['✅Joined', '❌Busy/Slept/Forget'];

  if (!isExam && !isExclusive) {
    options.push('😴Slept During Session');
    options.push('⏳Could not join Full Session');
  }
  options.push(fourthOption || '😒Not Interested');

  const question = sessionName ? `${dateStr} - *${sessionName}*` : `${dateStr} - *Today's Session*`;
  return { question, options, selectableCount: 1 };
}

function mapOptionToSymbol(selectedOption = '') {
  if (selectedOption === '__UNVOTE__') return '➖';
  if (selectedOption.includes('Joined') || selectedOption.includes('Attempted') || selectedOption.includes('Slept During Session') || selectedOption.includes('Could not join Full Session')) return '✅';
  return '❌';
}

async function askSessionConfirmation(sendControlMsg, binding) {
  const today = formatISTDate();
  if (state.dailySentFlags.has(`${binding.bindKey}:${today}`)) return;

  const { rows } = await getSheetLayout(binding.targetSheetId, binding.targetTab);
  const found = findDateRow(rows, today);
  const session = found?.sessionName || '(Blank in sheet)';

  const msg = await sendControlMsg(
    `⏰ *9:00 PM Check (${today})*\nSession in sheet: *${session}*\n\nQuote-reply with a new session name to override, *OK* to confirm, or *Cancel* to skip tonight's poll. (Auto-sends at 10:00 PM if unchanged.)`
  );
  if (msg?.key?.id) {
    state.pendingPrompts.set(msg.key.id, {
      type: 'CONFIRM_SESSION',
      bindKey: binding.bindKey,
      targetDate: today,
      sessionName: found?.sessionName || '',
    });
  }
}

async function dispatchGitaPoll({ sendPoll, sendControlMsg, binding, targetDate, sessionOverride, fourthOptionOverride, force = false, isTest = false }) {
  const dateStr = targetDate || formatISTDate();
  const flagKey = `${binding.bindKey}:${dateStr}`;

  if (!force && state.dailySentFlags.has(flagKey)) {
    return { status: 'ALREADY_SENT', dateStr };
  }

  const { rows, members } = await getSheetLayout(binding.targetSheetId, binding.targetTab);
  const found = findDateRow(rows, dateStr);
  if (!found) {
    await sendControlMsg(`⚠️ Could not find date row *${dateStr}* in *${binding.targetTab}*.`);
    return { status: 'DATE_NOT_FOUND' };
  }

  const sessionName = sessionOverride || found.sessionName;
  const payload = buildPollPayload(dateStr, sessionName, fourthOptionOverride);
  const sent = await sendPoll(binding.groupJid, payload);
  if (!sent?.key?.id) {
    await sendControlMsg(`⚠️ Failed to send Gita poll for *${dateStr}* (WhatsApp socket not ready).`);
    return { status: 'SEND_FAILED' };
  }

  if (isTest) return { status: 'SENT', dateStr, sessionName };

  state.dailySentFlags.add(flagKey);

  // Mark everyone with ➖ upon dispatch
  const updates = members.map((m) => ({
    range: `${binding.targetTab}!${m.colLetter}${found.rowNum}`,
    values: [['➖']],
  }));
  if (updates.length) {
    await google.safeExecute(
      () => google.batchUpdateValues(binding.targetSheetId, updates, 'RAW'),
      `Init ➖ for ${dateStr}`,
      sendControlMsg
    );
  }

  const secretBuf = sent.message?.messageContextInfo?.messageSecret;
  const secret = secretBuf ? Buffer.from(secretBuf).toString('base64') : '';
  const retentionDays = Number(state.settings.POLL_RETENTION_DAYS || 30);
  const now = Date.now();
  await saveActivePoll({
    pollMsgId: sent.key.id,
    category: CATEGORY,
    groupJid: binding.groupJid,
    targetSheetId: binding.targetSheetId,
    targetTab: binding.targetTab,
    targetDate: dateStr,
    sessionName,
    options: payload.options,
    secret,
    createdAt: now,
    expiresAt: now + retentionDays * 86400000,
  });

  return { status: 'SENT', dateStr, sessionName };
}

async function markMemberVote({ poll, officialName, symbol, sendControlMsg }) {
  const { rows, members } = await getSheetLayout(poll.targetSheetId, poll.targetTab);
  const dateRow = findDateRow(rows, poll.targetDate);
  if (!dateRow) {
    await sendControlMsg(`⚠️ Date row *${poll.targetDate}* not found while updating *${officialName}*.`);
    return;
  }

  const matches = members.filter((m) => m.name.toLowerCase() === officialName.trim().toLowerCase());
  if (matches.length === 1) {
    const prevVal = (rows[dateRow.rowNum - 1]?.[matches[0].colIndex] || '').trim();
    if (prevVal === symbol) return;
    const cell = `${poll.targetTab}!${matches[0].colLetter}${dateRow.rowNum}`;
    await google.safeExecute(
      () => google.updateRange(poll.targetSheetId, cell, [[symbol]], 'RAW'),
      `Vote ${officialName} (${poll.targetDate})`,
      sendControlMsg
    );
    const { MASTER_SHEET_ID, formatISTTimestamp } = require('../config');
    google.appendRow(MASTER_SHEET_ID, 'Gita_Vote_Logs', [
      String(Date.now()),
      formatISTTimestamp(),
      poll.targetDate,
      officialName,
      '',
      symbol,
    ]).catch(() => {});
  } else if (matches.length > 1) {
    const list = matches.map((m) => `Col ${m.colLetter} (${m.name})`).join(', ');
    const msg = await sendControlMsg(
      `⚠️ Duplicate name *${officialName}* found in sheet: ${list}.\nQuote-reply with the exact column letter (e.g., *${matches[0].colLetter}*) to mark *${symbol}* for ${poll.targetDate}.`
    );
    if (msg?.key?.id) {
      state.pendingPrompts.set(msg.key.id, { type: 'RESOLVE_DUPLICATE_COL', poll, symbol, rowNum: dateRow.rowNum });
    }
  } else {
    await sendControlMsg(`⚠️ Name *${officialName}* not found in Row 2 of *${poll.targetTab}*.`);
  }
}

async function handleVote({ poll, voterJid, pushName, selectedOptions, sendControlMsg }) {
  if (!selectedOptions?.length) return;
  const symbol = mapOptionToSymbol(selectedOptions[0]);
  const binding = state.bindings.find((b) => b.groupJid === poll.groupJid) || { bindKey: CATEGORY };
  state.voteCache.set(`${poll.pollMsgId}:${voterJid}`, { poll, voterJid, pushName, symbol, groupKey: binding.bindKey });

  const member = findMember(voterJid, binding.bindKey);
  if (member) {
    return markMemberVote({ poll, officialName: member.officialName, symbol, sendControlMsg });
  }

  const { members } = await getSheetLayout(poll.targetSheetId, poll.targetTab);
  const candidate = pushName
    ? members.find((m) => pushName.toLowerCase().includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(pushName.toLowerCase()))
    : null;

  const phone = normalizePhone(voterJid);
  const suggestion = candidate ? `\nSuggested match: *${candidate.name}*` : '';
  const msg = await sendControlMsg(
    `❓ *Unrecognized Voter* (+${phone}, Name: "${pushName || 'Unknown'}") voted *${symbol}* on *${poll.targetDate}*.${suggestion}\n\nQuote-reply:\n• *Yes* (confirm suggested)\n• *No = ExactName* (save permanently)\n• *Today = ExactName* (mark today only)\n• *Skip* (ignore)`
  );

  if (msg?.key?.id) {
    state.pendingPrompts.set(msg.key.id, {
      type: 'RESOLVE_VOTER',
      poll,
      voterJid,
      groupKey: binding.bindKey,
      suggestedName: candidate?.name || '',
      symbol,
    });
  }
}

async function addNewMemberAlphabetical({ sheetId, tabName, officialName, phoneJid, lid, groupKey, sendControlMsg }) {
  const { members } = await getSheetLayout(sheetId, tabName);
  const insertTarget = members.find((m) => m.name.toLowerCase() > officialName.toLowerCase());
  const insertIdx = insertTarget ? insertTarget.colIndex : (members.length ? members[members.length - 1].colIndex + 1 : 5);

  await google.insertColumnAt(sheetId, tabName, insertIdx);
  const colLetter = google.colIndexToLetter(insertIdx);
  await google.updateRange(sheetId, `${tabName}!${colLetter}2`, [[officialName]], 'RAW');
  await registerMember(phoneJid, lid, officialName, groupKey);
  await sendControlMsg(`✅ Added *${officialName}* alphabetically at Column *${colLetter}* and saved to Member_Registry.`);
}


async function syncCachedVotes(sendControlMsg) {
  let checked = 0;
  let fixed = 0;
  const sheetCache = new Map();
  for (const item of state.voteCache.values()) {
    const member = findMember(item.voterJid, item.groupKey);
    if (!member) continue;
    checked++;
    const key = `${item.poll.targetSheetId}:${item.poll.targetTab}`;
    if (!sheetCache.has(key)) {
      sheetCache.set(key, await getSheetLayout(item.poll.targetSheetId, item.poll.targetTab));
    }
    const { rows, members } = sheetCache.get(key);
    const dateRow = findDateRow(rows, item.poll.targetDate);
    const col = members.find((m) => m.name.toLowerCase() === member.officialName.trim().toLowerCase());
    if (!dateRow || !col) continue;
    const currentVal = (rows[dateRow.rowNum - 1]?.[col.colIndex] || '').trim();
    if (currentVal !== item.symbol) {
      await google.updateRange(item.poll.targetSheetId, `${item.poll.targetTab}!${col.colLetter}${dateRow.rowNum}`, [[item.symbol]], 'RAW');
      fixed++;
    }
  }
  await sendControlMsg(`🔄 Vote sync complete: checked *${checked}* vote(s), fixed *${fixed}* mismatch(es) in sheet.`);
}


function getOffsetISTDate(daysOffset = 0) {
  const { getISTNow } = require('../config');
  const d = getISTNow();
  d.setDate(d.getDate() + daysOffset);
  return formatISTDate(d);
}

async function buildDailyReport(binding, targetDate) {
  const dateStr = targetDate || getOffsetISTDate(-1);
  const { rows, members } = await getSheetLayout(binding.targetSheetId, binding.targetTab);
  const found = findDateRow(rows, dateStr);
  if (!found) return { error: `Date row *${dateStr}* not found in *${binding.targetTab}*.` };

  const row = rows[found.rowNum - 1] || [];
  let yes = 0, no = 0, none = 0;
  const lines = members.map((m, i) => {
    const raw = (row[m.colIndex] || '').trim();
    const sym = raw === '✅' ? '✅' : raw === '❌' ? '❌' : '➖';
    if (sym === '✅') yes++;
    else if (sym === '❌') no++;
    else none++;
    return `${i + 1}. ${m.name} ${sym}`;
  });

  const title = found.sessionName ? `${dateStr} - *${found.sessionName}*` : `${dateStr} - *Session*`;
  const text = `${title}\nPoll: ${yes}✅ / ${no}❌ / ${none}➖ (Total ${members.length})\n\n${lines.join('\n')}`;
  return { text, dateStr };
}

function parseDDMMYY(str) {
  const [d, m, y] = str.split('/').map(Number);
  return new Date(2000 + y, m - 1, d);
}

async function buildWeeklyReport(binding, refDateStr) {
  const { getISTNow } = require('../config');
  const ref = refDateStr ? parseDDMMYY(refDateStr) : (() => { const d = getISTNow(); d.setDate(d.getDate() - 1); return d; })();
  const day = ref.getDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(ref);
  mon.setDate(ref.getDate() + diffToMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    weekDates.push(formatISTDate(d));
  }

  const { rows, members } = await getSheetLayout(binding.targetSheetId, binding.targetTab);
  const dayRows = [];
  let firstRowIdx = -1;
  for (let r = 2; r < rows.length; r++) {
    const dStr = (rows[r]?.[1] || '').trim();
    if (weekDates.includes(dStr)) {
      if (firstRowIdx < 0) firstRowIdx = r;
      dayRows.push({
        dateShort: dStr.slice(0, 5),
        dayShort: ((rows[r]?.[2] || '').trim()).slice(0, 3),
        session: (rows[r]?.[3] || '').trim() || 'Session',
        row: rows[r],
      });
    }
  }
  if (!dayRows.length) return { error: `No rows found for week ${weekDates[0]} – ${weekDates[6]}.` };

  let weekLabel = 'Weekly';
  for (let r = firstRowIdx - 1; r >= 0; r--) {
    const cellA = (rows[r]?.[0] || '').trim();
    if (/^week\s+\d+/i.test(cellA)) { weekLabel = cellA; break; }
  }

  const total = dayRows.length;
  const buckets = { full: [], high: [], mod: [], low: [], zero: [] };
  for (const m of members) {
    let count = 0;
    const trail = dayRows.map((dr) => {
      const raw = (dr.row[m.colIndex] || '').trim();
      const sym = raw === '✅' ? '✅' : raw === '❌' ? '❌' : '➖';
      if (sym === '✅') count++;
      return sym;
    }).join('');

    const item = { name: m.name, count, trail };
    if (count === total) buckets.full.push(item);
    else if (count >= Math.ceil(total * 0.7)) buckets.high.push(item);
    else if (count >= Math.ceil(total * 0.4)) buckets.mod.push(item);
    else if (count >= 1) buckets.low.push(item);
    else buckets.zero.push(item);
  }

  const sep = '*───────────────────*';
  const sessLines = dayRows.map((d, i) => `${i + 1}. ${d.dateShort} (${d.dayShort}) — ${d.session}`).join('\n');
  const fmtPlain = (arr) => arr.map((x, i) => `${i + 1}. ${x.name} (${x.count}/${total})`).join('\n');
  const fmtTrail = (arr) => arr.map((x, i) => `${i + 1}. ${x.name} (${x.count}/${total}) — ${x.trail}`).join('\n');

  const sections = [
    `*WEEKLY ATTENDANCE REPORT*`,
    `*${weekLabel} (${weekDates[0]} – ${weekDates[6]})*`,
    sep,
    `\n📅 *Sessions Conducted:*\n${sessLines}`,
    `\n${sep}`,
  ];
  if (buckets.full.length) sections.push(`\n🏆 *100% Attendance (${total}/${total} Sessions) [${buckets.full.length} Members]:*\n${fmtPlain(buckets.full)}`);
  if (buckets.high.length) sections.push(`\n🌟 *High Attendance (5–6/${total} Sessions) [${buckets.high.length} Members]:*\n${fmtTrail(buckets.high)}`);
  if (buckets.mod.length) sections.push(`\n⚡ *Moderate Attendance (3–4/${total} Sessions) [${buckets.mod.length} Members]:*\n${fmtTrail(buckets.mod)}`);
  if (buckets.low.length) sections.push(`\n⚠️ *Low Attendance (1–2/${total} Sessions) [${buckets.low.length} Members]:*\n${fmtTrail(buckets.low)}`);
  if (buckets.zero.length) sections.push(`\n💤 *Zero Attendance (0/${total} Sessions) [${buckets.zero.length} Members]:*\n${fmtPlain(buckets.zero)}`);
  sections.push(`\n${sep}\n📊 *Total Registered Members:* ${members.length}`);

  return { text: sections.join('\n') };
}


async function pruneOldLogs() {
  const { MASTER_SHEET_ID } = require('../config');
  const retentionDays = Number(state.settings.POLL_RETENTION_DAYS || 30);
  const cutoff = Date.now() - retentionDays * 86400000;

  // Prune Active_Polls older than retentionDays
  try {
    const pollRows = await google.getRows(MASTER_SHEET_ID, 'Active_Polls!A2:J');
    const keptPolls = pollRows.filter((r) => !r[9] || Number(r[9]) > Date.now());
    if (keptPolls.length < pollRows.length) {
      const { sheets } = (() => ({ sheets: null }))();
      await google.updateRange(MASTER_SHEET_ID, 'Active_Polls!A2:J' + (pollRows.length + 1), pollRows.map((r) => (!r[9] || Number(r[9]) > Date.now()) ? r : Array(10).fill('')), 'RAW');
    }
  } catch {}

  // Prune Gita_Vote_Logs older than 10 days
  try {
    const logCutoff = Date.now() - 10 * 86400000;
    const logRows = await google.getRows(MASTER_SHEET_ID, 'Gita_Vote_Logs!A2:F');
    const kept = logRows.filter((r) => r[0] && Number(r[0]) >= logCutoff);
    if (kept.length < logRows.length) {
      const padded = [...kept, ...Array(logRows.length - kept.length).fill(Array(6).fill(''))];
      await google.updateRange(MASTER_SHEET_ID, 'Gita_Vote_Logs!A2:F' + (logRows.length + 1), padded, 'RAW');
    }
  } catch {}
}

module.exports = {
  CATEGORY,
  askSessionConfirmation,
  dispatchGitaPoll,
  markMemberVote,
  handleVote,
  addNewMemberAlphabetical,
  syncCachedVotes,
  buildDailyReport,
  buildWeeklyReport,
  pruneOldLogs,
};
