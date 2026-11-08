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
  const omitSlept = lower.includes('exam session') || lower.includes('exclusive session');
  const options = ['✅Joined', '❌Busy/Slept/Forget'];
  if (!omitSlept) options.push('😴Slept During Session');
  options.push(fourthOption || '😒Not Interested');

  const question = sessionName ? `${dateStr} - *${sessionName}*` : `${dateStr} - *Today's Session*`;
  return { question, options, selectableCount: 1 };
}

function mapOptionToSymbol(selectedOption = '') {
  if (selectedOption.includes('Joined') || selectedOption.includes('Slept During Session')) return '✅';
  return '❌';
}

async function askSessionConfirmation(sendControlMsg, binding) {
  const today = formatISTDate();
  if (state.dailySentFlags.has(`${binding.bindKey}:${today}`)) return;

  const { rows } = await getSheetLayout(binding.targetSheetId, binding.targetTab);
  const found = findDateRow(rows, today);
  const session = found?.sessionName || '(Blank in sheet)';

  const msg = await sendControlMsg(
    `⏰ *9:45 PM Check (${today})*\nSession in sheet: *${session}*\n\nQuote-reply with a new session name to override, or reply *OK* to confirm. (Auto-sends at 10:00 PM if unchanged.)`
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

async function dispatchGitaPoll({ sendPoll, sendControlMsg, binding, targetDate, sessionOverride, fourthOptionOverride, force = false }) {
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
  if (!sent?.key?.id) return { status: 'SEND_FAILED' };

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
    const cell = `${poll.targetTab}!${matches[0].colLetter}${dateRow.rowNum}`;
    await google.safeExecute(
      () => google.updateRange(poll.targetSheetId, cell, [[symbol]], 'RAW'),
      `Vote ${officialName} (${poll.targetDate})`,
      sendControlMsg
    );
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

module.exports = {
  CATEGORY,
  askSessionConfirmation,
  dispatchGitaPoll,
  markMemberVote,
  handleVote,
  addNewMemberAlphabetical,
};
