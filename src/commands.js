const { MASTER_SHEET_ID, formatISTDate, formatISTTimestamp, normalizePhone } = require('./config');
const google = require('./google');
const { state, loadMasterState, saveSetting, registerMember, isFullAuthority, isAuthorized } = require('./state');
const gita = require('./categories/gitaAttendance');
const { generateTauntOption, handleAIConversation } = require('./ai');

const HELP_TEXT = `*Bot Commands*
• \`#help\` — List all commands
• \`#status\` — System health & active polls
• \`#sync\` — Reload Master Sheet data
• \`#set_control_group\` — Set this group as Control Group
• \`#find [keyword|all]\` — Search WhatsApp groups
• \`#bind <#> <bindKey>\` — Bind group from last search
• \`#gita [test] [DD/MM/YY] [Session]\` — Send Gita poll (use \`test\` to send here)
• \`#listen [15m|5|forever]\` — Enable chat listening
• \`#stop\` — Stop active listener & notify
• \`#pause_polls\` / \`#resume_polls\` — Pause/resume scheduled polls
• \`#admin add <phone> [FULL|LIMITED]\` — Grant access
• \`#admin remove <phone>\` — Revoke access
• \`#register\` — Bulk register members (phone + name per line)`;

let lastGroupSearch = [];

async function startListener(chatJid, modeArg = '', sendControlMsg) {
  const defaultMin = Number(state.settings.DEFAULT_LISTEN_MIN || 15);
  let listener = { mode: 'TIME', expiresAt: Date.now() + defaultMin * 60000, remaining: null };

  if (modeArg === 'forever' || modeArg === 'continuous') {
    listener = { mode: 'FOREVER', expiresAt: null, remaining: null };
  } else if (/^\d+m$/i.test(modeArg)) {
    const mins = parseInt(modeArg, 10);
    listener = { mode: 'TIME', expiresAt: Date.now() + mins * 60000, remaining: null };
  } else if (/^\d+$/.test(modeArg)) {
    listener = { mode: 'COUNT', expiresAt: null, remaining: parseInt(modeArg, 10) };
  }

  if (listener.mode === 'TIME') {
    const ms = listener.expiresAt - Date.now();
    listener.timer = setTimeout(async () => {
      state.listeners.delete(chatJid);
      await sendControlMsg(`⏹️ Listening stopped for \`${chatJid}\` (timer expired).`);
    }, ms);
  }

  const prev = state.listeners.get(chatJid);
  if (prev?.timer) clearTimeout(prev.timer);
  state.listeners.set(chatJid, listener);

  const label = listener.mode === 'FOREVER' ? 'until stopped' : listener.mode === 'COUNT' ? `for ${listener.remaining} msgs` : `for ${Math.round((listener.expiresAt - Date.now()) / 60000)}m`;
  await sendControlMsg(`👂 Listening enabled for \`${chatJid}\` (${label}).`);
}

async function stopListener(chatJid, reason, sendControlMsg) {
  let stopped = 0;
  if (chatJid && state.listeners.has(chatJid)) {
    const l = state.listeners.get(chatJid);
    if (l.timer) clearTimeout(l.timer);
    state.listeners.delete(chatJid);
    stopped = 1;
  } else {
    for (const [, l] of state.listeners.entries()) {
      if (l.timer) clearTimeout(l.timer);
      stopped++;
    }
    state.listeners.clear();
  }
  await sendControlMsg(`⏹️ Listening stopped (${reason}). Cleared ${stopped} active listener(s).`);
}

async function handleQuoteReply({ quotedId, replyText, sendControlMsg, enqueuePoll }) {
  const prompt = state.pendingPrompts.get(quotedId);
  if (!prompt) return false;
  const txt = replyText.trim();

  if (prompt.type === 'RESOLVE_VOTER') {
    if (/^skip$/i.test(txt)) {
      state.pendingPrompts.delete(quotedId);
      await sendControlMsg('⏭️ Vote skipped.');
      return true;
    }
    let name = '';
    let permanent = true;
    if (/^yes$/i.test(txt) && prompt.suggestedName) {
      name = prompt.suggestedName;
    } else if (/^no\s*=\s*(.+)$/i.test(txt)) {
      name = txt.match(/^no\s*=\s*(.+)$/i)[1].trim();
    } else if (/^today\s*=\s*(.+)$/i.test(txt)) {
      name = txt.match(/^today\s*=\s*(.+)$/i)[1].trim();
      permanent = false;
    } else {
      await sendControlMsg('⚠️ Reply with `Yes`, `No = ExactName`, `Today = ExactName`, or `Skip`.');
      return true;
    }

    if (permanent) {
      const isLid = prompt.voterJid.endsWith('@lid');
      await registerMember(isLid ? '' : prompt.voterJid, isLid ? prompt.voterJid : '', name, prompt.groupKey);
    }
    await gita.markMemberVote({ poll: prompt.poll, officialName: name, symbol: prompt.symbol, sendControlMsg });
    state.pendingPrompts.delete(quotedId);
    await sendControlMsg(`✅ Marked *${name}* (${prompt.symbol}) for ${prompt.poll.targetDate}.`);
    return true;
  }

  if (prompt.type === 'RESOLVE_DUPLICATE_COL') {
    const colLetter = txt.toUpperCase().replace(/[^A-Z]/g, '');
    if (!colLetter) return true;
    await google.safeExecute(
      () => google.updateRange(prompt.poll.targetSheetId, `${prompt.poll.targetTab}!${colLetter}${prompt.rowNum}`, [[prompt.symbol]], 'RAW'),
      `Dup Vote ${colLetter}${prompt.rowNum}`,
      sendControlMsg
    );
    state.pendingPrompts.delete(quotedId);
    await sendControlMsg(`✅ Updated Column *${colLetter}* (${prompt.symbol}).`);
    return true;
  }

  if (prompt.type === 'CONFIRM_SESSION') {
    state.pendingPrompts.delete(quotedId);
    if (/^(cancel|skip|no)$/i.test(txt)) {
      state.dailySentFlags.add(`${prompt.bindKey}:${prompt.targetDate}`);
      await sendControlMsg(`⏹️ Cancelled tonight's 10:00 PM poll for *${prompt.targetDate}*.`);
      return true;
    }
    if (!/^ok$/i.test(txt)) {
      state.settings[`SESSION_OVERRIDE_${prompt.targetDate}`] = txt;
    }
    await sendControlMsg(`✅ Session confirmed for ${prompt.targetDate}: *${/^ok$/i.test(txt) ? prompt.sessionName : txt}*`);
    return true;
  }

  if (prompt.type === 'CONFIRM_DUPLICATE_POLL') {
    state.pendingPrompts.delete(quotedId);
    if (/^yes$/i.test(txt)) {
      const fourth = await generateTauntOption(prompt.sessionOverride || 'Today');
      enqueuePoll(() => gita.dispatchGitaPoll({ ...prompt, fourthOptionOverride: fourth, force: true }));
      await sendControlMsg('✅ Re-dispatching poll.');
    } else {
      await sendControlMsg('⏹️ Duplicate poll cancelled.');
    }
    return true;
  }

  if (prompt.type === 'CONFIRM_JOIN') {
    state.pendingPrompts.delete(quotedId);
    if (/^skip$/i.test(txt)) return true;
    await gita.addNewMemberAlphabetical({
      sheetId: prompt.binding.targetSheetId,
      tabName: prompt.binding.targetTab,
      officialName: txt,
      phoneJid: prompt.phoneJid,
      lid: prompt.lid,
      groupKey: prompt.binding.bindKey,
      sendControlMsg,
    });
    return true;
  }

  if (prompt.type === 'CONFIRM_EXIT') {
    state.pendingPrompts.delete(quotedId);
    const updated = /^yes$/i.test(txt) ? 'CONFIRMED' : 'SKIPPED';
    await google.appendRow(MASTER_SHEET_ID, 'Exit_Log', [
      formatISTTimestamp(),
      prompt.groupName,
      prompt.groupJid,
      prompt.memberName,
      prompt.phoneJid,
      prompt.action,
      updated,
    ]);
    await sendControlMsg(`📝 Exit logged for *${prompt.memberName}* (${updated}).`);
    return true;
  }

  return false;
}

async function processIncomingMessage({ sock, chatJid, senderJid, text, quotedId, sendControlMsg, sendPoll, enqueuePoll }) {
  const controlJid = state.settings.CONTROL_GROUP_JID;
  const isControlGroup = controlJid && chatJid === controlJid;
  const isCommand = text.trim().startsWith('#');

  if (isControlGroup && quotedId && isAuthorized(senderJid, 'CONTROL')) {
    const handled = await handleQuoteReply({ quotedId, replyText: text, sendControlMsg, enqueuePoll });
    if (handled) return;
  }

  if (text.trim().toLowerCase() === '#set_control_group' && isFullAuthority(senderJid)) {
    await saveSetting('CONTROL_GROUP_JID', chatJid, 'JID of the private Control Group');
    await sock.sendMessage(chatJid, { text: `✅ Control Group set to \`${chatJid}\`.` });
    return;
  }

  const listener = state.listeners.get(chatJid);
  if (!isControlGroup && !listener) return;

  const channel = isControlGroup ? 'CONTROL' : chatJid.endsWith('@g.us') ? 'GROUP' : 'DM';
  if (!isAuthorized(senderJid, channel)) return;

  if (listener && listener.mode === 'COUNT') {
    listener.remaining -= 1;
    if (listener.remaining <= 0) await stopListener(chatJid, 'message count reached', sendControlMsg);
  }

  if (!isCommand) {
    const aiReply = await handleAIConversation({ chatJid, senderJid, text, sendControlMsg });
    if (aiReply) await sendControlMsg(aiReply);
    return;
  }

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const fullAuth = isFullAuthority(senderJid);

  if (cmd === '#help') return sendControlMsg(HELP_TEXT);

  if (cmd === '#status') {
    const paused = state.settings.SCHEDULE_PAUSED === 'TRUE' ? 'PAUSED' : 'ACTIVE';
    return sendControlMsg(
      `🟢 *Bot Status*\n• Schedule: ${paused}\n• Active Polls (30d): ${state.activePolls.size}\n• Registered Members: ${state.members.length}\n• Retry Queue: ${google.getRetryCount()}\n• Active Listeners: ${state.listeners.size}\n• Last Sync: ${state.lastSyncAt}`
    );
  }

  if (cmd === '#sync') {
    await loadMasterState();
    return sendControlMsg('✅ Reloaded Master Sheet data.');
  }

  if (cmd === '#pause_polls' && fullAuth) {
    await saveSetting('SCHEDULE_PAUSED', 'TRUE');
    return sendControlMsg('⏸️ Scheduled polls paused. Background vote tracking remains active.');
  }

  if (cmd === '#resume_polls' && fullAuth) {
    await saveSetting('SCHEDULE_PAUSED', 'FALSE');
    return sendControlMsg('▶️ Scheduled polls resumed.');
  }

  if (cmd === '#listen' && fullAuth) {
    return startListener(chatJid, args[0] || '', sendControlMsg);
  }

  if (cmd === '#stop' && fullAuth) {
    return stopListener(args[0] === 'all' ? null : chatJid, 'manual #stop command', sendControlMsg);
  }

  if (cmd === '#find' && fullAuth) {
    const query = args.join(' ').toLowerCase();
    const allGroups = Object.values(await sock.groupFetchAllParticipating());
    lastGroupSearch = (!query || query === 'all')
      ? allGroups
      : allGroups.filter((g) => (g.subject || '').toLowerCase().includes(query));

    if (!lastGroupSearch.length) return sendControlMsg('No matching groups found.');
    const lines = lastGroupSearch.slice(0, 25).map((g, i) => `${i + 1}. *${g.subject}* (\`${g.id}\`)`);
    return sendControlMsg(`*Groups Found:*\n${lines.join('\n')}\n\nUse \`#bind <#> <bindKey>\` to link.`);
  }

  if (cmd === '#bind' && fullAuth) {
    const idx = parseInt(args[0], 10) - 1;
    const bindKey = args[1];
    const target = lastGroupSearch[idx];
    if (!target || !bindKey) return sendControlMsg('Usage: `#bind <#> <bindKey>`');

    const rows = await google.getRows(MASTER_SHEET_ID, 'Group_Bindings!A2:H');
    const rowIdx = rows.findIndex((r) => (r[0] || '').trim() === bindKey);
    if (rowIdx < 0) return sendControlMsg(`Bind key \`${bindKey}\` not found in Group_Bindings.`);
    await google.updateRange(MASTER_SHEET_ID, `Group_Bindings!C${rowIdx + 2}:D${rowIdx + 2}`, [[target.subject, target.id]]);
    await loadMasterState();
    return sendControlMsg(`✅ Bound *${target.subject}* to \`${bindKey}\`.`);
  }

  if (cmd === '#admin' && fullAuth) {
    const sub = (args[0] || '').toLowerCase();
    const phone = normalizePhone(args[1] || '');
    if (sub === 'add' && phone) {
      const role = (args[2] || 'LIMITED').toUpperCase();
      await google.appendRow(MASTER_SHEET_ID, 'Admin_Permissions', [phone, phone, role, 'CONTROL', '']);
      await loadMasterState();
      return sendControlMsg(`✅ Added +${phone} as *${role}*.`);
    }
    if (sub === 'remove' && phone) {
      const rows = await google.getRows(MASTER_SHEET_ID, 'Admin_Permissions!A2:E');
      const idx = rows.findIndex((r) => normalizePhone(r[0]) === phone);
      if (idx >= 0) {
        await google.updateRange(MASTER_SHEET_ID, `Admin_Permissions!A${idx + 2}:E${idx + 2}`, [['', '', '', '', '']]);
        await loadMasterState();
      }
      return sendControlMsg(`🗑️ Removed +${phone}.`);
    }
  }

  if (cmd === '#register' && fullAuth) {
    const lines = text.trim().split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      return sendControlMsg('Usage:\n#register [groupKey]\n9198XXXXXXXX Alok\n98XXXXXXXX Aman');
    }
    const groupKey = args[0] && !/\d{7,}/.test(args[0]) ? args[0] : 'gita_attendance';
    let added = 0;
    const failed = [];
    for (const line of lines) {
      const m = line.match(/^([+\d\s-]+?)[\s,:-]+([A-Za-z].*)$/);
      if (!m) { failed.push(line); continue; }
      let digits = m[1].replace(/\D/g, '');
      if (digits.length === 10) digits = '91' + digits;
      if (digits.length < 10) { failed.push(line); continue; }
      await registerMember(`${digits}@s.whatsapp.net`, '', m[2].trim(), groupKey);
      added++;
    }
    const warn = failed.length ? `\n⚠️ Skipped ${failed.length} line(s): ${failed.slice(0, 5).join(' | ')}` : '';
    return sendControlMsg(`✅ Registered *${added}* member(s) under \`${groupKey}\`.${warn}`);
  }

  if (cmd === '#gita' && isAuthorized(senderJid, channel, 'gita_attendance')) {
    const baseBinding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (!baseBinding) return sendControlMsg('⚠️ `gita_attendance` binding row missing in Master Sheet.');

    const isTest = args[0]?.toLowerCase() === 'test';
    const cleanArgs = isTest ? args.slice(1) : args;
    const binding = isTest
      ? { ...baseBinding, bindKey: 'gita_test', groupJid: chatJid }
      : baseBinding;

    if (!binding.groupJid) return sendControlMsg('⚠️ `gita_attendance` is not bound to a group yet. Use `#find` and `#bind`.');

    const dateMatch = cleanArgs[0] && /^\d{2}\/\d{2}\/\d{2}$/.test(cleanArgs[0]) ? cleanArgs[0] : null;
    const targetDate = dateMatch || formatISTDate();
    const sessionOverride = dateMatch ? cleanArgs.slice(1).join(' ') : cleanArgs.join(' ');
    await sendControlMsg('⏳ Command received, preparing poll...');
    const fourth = await generateTauntOption(sessionOverride || 'Today');

    const res = await gita.dispatchGitaPoll({
      sendPoll,
      sendControlMsg,
      binding,
      targetDate,
      sessionOverride: sessionOverride || undefined,
      fourthOptionOverride: fourth,
      force: isTest,
    });

    if (res.status === 'ALREADY_SENT') {
      const msg = await sendControlMsg(`⚠️ Gita poll for *${targetDate}* was already sent today. Quote-reply *Yes* to send again.`);
      if (msg?.key?.id) {
        state.pendingPrompts.set(msg.key.id, {
          type: 'CONFIRM_DUPLICATE_POLL',
          sendPoll,
          sendControlMsg,
          binding,
          targetDate,
          sessionOverride: sessionOverride || undefined,
        });
      }
    }
  }
}

module.exports = { processIncomingMessage };
