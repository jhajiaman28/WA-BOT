const { MASTER_SHEET_ID, formatISTDate, formatISTTimestamp, normalizePhone } = require('./config');
const google = require('./google');
const { state, loadMasterState, saveSetting, registerMember, isFullAuthority, isAuthorized } = require('./state');
const gita = require('./categories/gitaAttendance');
const reminders = require('./reminders');
const groupBroadcast = require('./groupBroadcast');
const memberTracker = require('./memberTracker');
const outreachMaster = require('./outreachMaster');
const dailyPosts = require('./categories/dailyPosts');
const { generateTauntOption, handleAIConversation } = require('./ai');

const HELP_TEXT = `*BOT COMMANDS*

*Polls, Posts & Reports*
• \`#gita [test] [DD/MM/YY] [Session]\` — Gita attendance poll
• \`#daily / #weekly [test] [DD/MM/YY]\` — Attendance report
• \`#study / #vidya [test] [DD/MM/YY]\` — Study Tracker / Vidya poll
• \`#sync_votes\` — Re-check & fix sheet votes

*Outreach & Callers*
• \`#set_outreach_control\` / \`#set_callers_group\` — Bind outreach groups
• \`#outreach_sync\` / \`#outreach_assign\` / \`#outreach_poll\`
• \`#outreach_clean_exits [all|name]\` / \`#outreach_cap <n>\`
• \`#outreach_event <name|clear>\` / \`#outreach_report\`

*DMs, Reminders & Saved Messages*
• \`#dm_group <keyword>\` — Fetch group members & DM with exclusions
• \`#track_members <group> [sheetURL]\` / \`#untrack_members <group>\`
• \`#track_notify <group> <on|off>\` — Toggle entry/exit alerts
• \`#reminders\` — Run inactive-member reminder check now
• \`#dnd add|remove <Name>\` — Toggle No-DM flag
• \`#save_msg <name>\` + text — Save message (keeps old versions)
• \`#msgs\` / \`#del_msg <name> [old]\` — View or delete saved msgs

*Scheduling & Pause*
• \`#schedule <DD/MM/YY HH:MM | HH:MM daily> | <here|key> | <msg|@name|#cmd>\`
• \`#schedules / #unschedule <id>\` — List or cancel schedules
• \`#pause_polls / #resume_polls [key]\` — Pause all or specific

*Groups, Members & System*
• \`#find [keyword|all]\` / \`#bind <#> <bindKey>\` — Link groups
• \`#register\` — Bulk add members (phone + name/line)
• \`#admin add <phone> [FULL|LIMITED] [cats]\` / \`remove <phone>\`
• \`#status\` / \`#sync\` / \`#help\` — Health, reload & help
• \`#listen [15m|5|forever]\` / \`#stop\` — Chat listener
• \`#cancel\` — Cancel active DM/job or pending prompt
• \`#kill\` / \`#wake\` — Full Emergency Stop / Resume bot`;

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

async function handleQuoteReply({ quotedId, replyText, sendControlMsg, enqueuePoll, sendDM, editControlMsg, deleteControlMsg }) {
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

  if (prompt.type === 'TRACK_PICK_GROUP') {
    state.pendingPrompts.delete(quotedId);
    if (/^cancel$/i.test(txt)) { await sendControlMsg('⏹️ Cancelled.'); return true; }
    const g = prompt.groups[parseInt(txt, 10) - 1];
    if (!g) { await sendControlMsg('⚠️ Invalid selection.'); return true; }
    await memberTracker.setupGroupTrackerSheet({ sock: prompt.sock, group: g, customSheetUrl: prompt.customSheetUrl, sendControlMsg, editControlMsg, deleteControlMsg });
    return true;
  }

  if (prompt.type === 'TRACK_CONFIRM_GROUP') {
    state.pendingPrompts.delete(quotedId);
    if (/^cancel$/i.test(txt)) { await sendControlMsg('⏹️ Cancelled.'); return true; }
    if (/^yes$/i.test(txt)) {
      await memberTracker.setupGroupTrackerSheet({ sock: prompt.sock, group: prompt.group, customSheetUrl: prompt.customSheetUrl, sendControlMsg, editControlMsg, deleteControlMsg });
      return true;
    }
    await memberTracker.resolveAndConfirmOther({ sock: prompt.sock, replyText: txt, customSheetUrl: prompt.customSheetUrl, sendControlMsg });
    return true;
  }

  if (prompt.type === 'DM_PICK_GROUP') {
    state.pendingPrompts.delete(quotedId);
    if (/^cancel$/i.test(txt)) { await sendControlMsg('⏹️ Cancelled.'); return true; }
    const g = prompt.groups[parseInt(txt, 10) - 1];
    if (!g) { await sendControlMsg('⚠️ Invalid selection.'); return true; }
    await groupBroadcast.showGroupMembersForDM({ sock: prompt.sock, group: g, sendControlMsg });
    return true;
  }

  if (prompt.type === 'DM_GROUP_SEND') {
    state.pendingPrompts.delete(quotedId);
    await groupBroadcast.executeGroupDM({ prompt, replyText, sendControlMsg, sendDM, editControlMsg });
    return true;
  }

  if (prompt.type === 'CONFIRM_REMINDERS') {
    state.pendingPrompts.delete(quotedId);
    await reminders.processReminderReply({ prompt, replyText: txt, sendControlMsg, sendDM, editControlMsg });
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

async function processIncomingMessage({ sock, chatJid, senderJid, text, quotedId, sendControlMsg, sendPoll, enqueuePoll, sendDM, editControlMsg, deleteControlMsg, sendGroupMentionText }) {
  const controlJid = state.settings.CONTROL_GROUP_JID;
  const outreachControlJid = outreachMaster.getOutreachControlJid();
  const callersGroupJid = outreachMaster.getCallersGroupJid();
  const isOutreachControl = outreachControlJid && chatJid === outreachControlJid;
  const isCallersGroup = callersGroupJid && chatJid === callersGroupJid;
  const isControlGroup = (controlJid && chatJid === controlJid) || isOutreachControl;
  const isCommand = text.trim().startsWith('#');

  if (isControlGroup && quotedId && isAuthorized(senderJid, 'CONTROL')) {
    const handled = await handleQuoteReply({ quotedId, replyText: text, sendControlMsg, enqueuePoll, sendDM, editControlMsg, deleteControlMsg });
    if (handled) return;
  }

  if (text.trim().toLowerCase() === '#set_outreach_control' && isFullAuthority(senderJid)) {
    await saveSetting('OUTREACH_CONTROL_JID', chatJid, 'Dedicated Outreach Control Group JID');
    const sent = await sock.sendMessage(chatJid, { text: `✅ Outreach Control Group set to \`${chatJid}\`.` });
    if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
    return;
  }
  if (text.trim().toLowerCase() === '#set_callers_group' && isFullAuthority(senderJid)) {
    await saveSetting('CALLERS_GROUP_JID', chatJid, 'Callers Team Group JID');
    const sent = await sock.sendMessage(chatJid, { text: `✅ Callers Team Group set to \`${chatJid}\`.` });
    if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
    return;
  }
  if (isCallersGroup && text.trim().toLowerCase() === '#unavailable') {
    await outreachMaster.handleCallerUnavailable({ senderJid, sendGroupMentionText, sendNotice: (t) => sock.sendMessage(outreachMaster.getOutreachControlJid(), { text: t }) });
    return;
  }

  if (text.trim().toLowerCase() === '#set_control_group' && isFullAuthority(senderJid)) {
    await saveSetting('CONTROL_GROUP_JID', chatJid, 'JID of the private Control Group');
    const sent = await sock.sendMessage(chatJid, { text: `✅ Control Group set to \`${chatJid}\`.` });
    if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
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
    const emergency = state.settings.EMERGENCY_STOP === 'TRUE';
    const paused = state.settings.SCHEDULE_PAUSED === 'TRUE' ? 'PAUSED' : 'ACTIVE';
    return sendControlMsg(
      `${emergency ? '🛑 *EMERGENCY STOP ACTIVE* (Send `#wake` to resume)' : '🟢 *Bot Status*'}\n• Schedule: ${paused}\n• Active Polls (30d): ${state.activePolls.size}\n• Registered Members: ${state.members.length}\n• Retry Queue: ${google.getRetryCount()}\n• Active Listeners: ${state.listeners.size}\n• Last Sync: ${state.lastSyncAt}`
    );
  }

  if (cmd === '#kill' && fullAuth) {
    state.dmJobCancel = true;
    state.pendingPrompts.clear();
    for (const [, l] of state.listeners.entries()) { if (l.timer) clearTimeout(l.timer); }
    state.listeners.clear();
    await saveSetting('EMERGENCY_STOP', 'TRUE', 'Full bot shutdown');
    return sendControlMsg('🛑 *EMERGENCY STOP ACTIVATED.* All jobs, polls, listeners & schedules halted. Only `#status`, `#help`, and `#wake` will respond.');
  }

  if (cmd === '#wake' && fullAuth) {
    await saveSetting('EMERGENCY_STOP', 'FALSE', 'Full bot shutdown');
    return sendControlMsg('🟢 *Bot Resumed.* All commands and schedules are active again.');
  }

  if (state.settings.EMERGENCY_STOP === 'TRUE') {
    return sendControlMsg('🛑 Bot is in *EMERGENCY STOP* mode. Send `#wake` to resume (only `#status` and `#help` work right now).');
  }

  if (cmd === '#cancel' && fullAuth) {
    if (state.dmJobActive) state.dmJobCancel = true;
    const cleared = state.pendingPrompts.size;
    state.pendingPrompts.clear();
    return sendControlMsg(`⏹️ Cancelled active job/prompts (cleared ${cleared} pending prompt(s)).`);
  }

  if (cmd === '#sync') {
    await loadMasterState();
    return sendControlMsg('✅ Reloaded Master Sheet data.');
  }

  if (cmd === '#sync_votes') {
    await gita.syncCachedVotes(sendControlMsg);
    return;
  }

  if (cmd === '#pause_polls' && fullAuth) {
    const key = args[0];
    if (key) {
      await saveSetting(`PAUSED_${key}`, 'TRUE', `Pause schedule for ${key}`);
      return sendControlMsg(`⏸️ Paused schedule for *${key}*.`);
    }
    await saveSetting('SCHEDULE_PAUSED', 'TRUE');
    return sendControlMsg('⏸️ All scheduled jobs paused. Background vote tracking remains active.');
  }

  if (cmd === '#resume_polls' && fullAuth) {
    const key = args[0];
    if (key) {
      await saveSetting(`PAUSED_${key}`, 'FALSE', `Pause schedule for ${key}`);
      return sendControlMsg(`▶️ Resumed schedule for *${key}*.`);
    }
    await saveSetting('SCHEDULE_PAUSED', 'FALSE');
    return sendControlMsg('▶️ All scheduled jobs resumed.');
  }

  if (cmd === '#listen' && fullAuth) {
    return startListener(chatJid, args[0] || '', sendControlMsg);
  }

  if (cmd === '#stop' && fullAuth) {
    return stopListener(args[0] === 'all' ? null : chatJid, 'manual #stop command', sendControlMsg);
  }

  if (cmd === '#find' && fullAuth) {
    const query = args.join(' ').toLowerCase();
    await sendControlMsg('🔍 Searching groups...');
    const rawGroups = await Promise.race([
      sock.groupFetchAllParticipating(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('WhatsApp group fetch timed out')), 15000)),
    ]);
    const allGroups = Object.values(rawGroups);
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
    let phone = normalizePhone(args[1] || '');
    if (phone.length === 10) phone = '91' + phone;
    if (sub === 'add' && phone) {
      const role = (args[2] || 'LIMITED').toUpperCase();
      const cats = args.slice(3).join('');
      const rows = await google.getRows(MASTER_SHEET_ID, 'Admin_Permissions!A2:E');
      const idx = rows.findIndex((r) => normalizePhone(r[0]) === phone);
      if (idx >= 0) {
        await google.updateRange(MASTER_SHEET_ID, `Admin_Permissions!A${idx + 2}:E${idx + 2}`, [[phone, phone, role, 'CONTROL', cats]]);
      } else {
        await google.appendRow(MASTER_SHEET_ID, 'Admin_Permissions', [phone, phone, role, 'CONTROL', cats]);
      }
      await loadMasterState();
      return sendControlMsg(`✅ Saved +${phone} as *${role}*${cats ? ` (${cats})` : ''}.`);
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
    await sendControlMsg(`✅ Registered *${added}* member(s) under \`${groupKey}\`.${warn}`);
    if (added > 0 && state.voteCache.size > 0) await gita.syncCachedVotes(sendControlMsg);
    return;
  }

  if ((cmd === '#daily' || cmd === '#weekly') && isAuthorized(senderJid, channel, 'gita_attendance')) {
    const binding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (!binding) return sendControlMsg('⚠️ `gita_attendance` binding missing.');
    const isTest = args[0]?.toLowerCase() === 'test';
    const dateArg = (isTest ? args[1] : args[0]) || '';
    const targetDate = /^\d{2}\/\d{2}\/\d{2}$/.test(dateArg) ? dateArg : undefined;
    const destJid = isTest ? chatJid : binding.groupJid;
    if (!destJid) return sendControlMsg('⚠️ Group not bound yet.');

    const res = cmd === '#daily'
      ? await gita.buildDailyReport(binding, targetDate)
      : await gita.buildWeeklyReport(binding, targetDate);
    if (res.error) return sendControlMsg(`⚠️ ${res.error}`);
    const sent = await sock.sendMessage(destJid, { text: res.text });
    if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
    if (!isTest) await sendControlMsg(`✅ Sent ${cmd.slice(1)} report to *${binding.groupName || destJid}*.`);
    return;
  }

  if (cmd === '#study' && isAuthorized(senderJid, channel, 'study_tracker')) {
    const bindings = state.bindings.filter((b) => (b.bindKey === 'study_tracker' || b.category === 'study_tracker') && b.groupJid);
    const isTest = args[0]?.toLowerCase() === 'test';
    const dateArg = (isTest ? args[1] : args[0]) || '';
    const targetDate = /^\d{2}\/\d{2}\/\d{2}$/.test(dateArg) ? dateArg : undefined;
    const textBody = dailyPosts.buildStudyTrackerText(targetDate);
    if (isTest) {
      const sent = await sock.sendMessage(chatJid, { text: textBody });
      if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
      return;
    }
    if (!bindings.length) return sendControlMsg('⚠️ `study_tracker` is not bound to any group yet. Use `#find` and `#bind`.');
    for (const b of bindings) {
      enqueuePoll(async () => {
        const sent = await sock.sendMessage(b.groupJid, { text: textBody });
        if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
        await sendControlMsg(`✅ Sent Study Tracker to *${b.groupName || b.groupJid}*.`);
      });
    }
    return;
  }

  if (cmd === '#vidya' && isAuthorized(senderJid, channel, 'vidya_avidya')) {
    const bindings = state.bindings.filter((b) => (b.bindKey === 'vidya_avidya' || b.category === 'vidya_avidya') && b.groupJid);
    const isTest = args[0]?.toLowerCase() === 'test';
    const dateArg = (isTest ? args[1] : args[0]) || '';
    const targetDate = /^\d{2}\/\d{2}\/\d{2}$/.test(dateArg) ? dateArg : undefined;
    const payload = dailyPosts.buildVidyaPollPayload(targetDate);
    if (isTest) {
      await sendPoll(chatJid, payload);
      return;
    }
    if (!bindings.length) return sendControlMsg('⚠️ `vidya_avidya` is not bound to any group yet. Use `#find` and `#bind`.');
    for (const b of bindings) {
      enqueuePoll(async () => {
        const sent = await sendPoll(b.groupJid, payload);
        if (sent?.key?.id) await sendControlMsg(`✅ Sent Vidya-Avidya poll to *${b.groupName || b.groupJid}*.`);
        else await sendControlMsg(`⚠️ Failed to send Vidya-Avidya poll to *${b.groupName || b.groupJid}*.`);
      });
    }
    return;
  }

  if (cmd === '#schedule' && fullAuth) {
    const raw = text.trim().slice('#schedule'.length).trim();
    const segs = raw.split('|').map((x) => x.trim());
    if (segs.length < 3) {
      return sendControlMsg('Usage:\n`#schedule DD/MM/YY HH:MM | here | Message or #cmd`\n`#schedule HH:MM daily | bindKey | Message or #cmd`');
    }
    const [timePart, targetPart, ...payloadParts] = segs;
    const payload = payloadParts.join(' | ');
    const isDaily = /daily$/i.test(timePart);
    let runAtIST = timePart.replace(/\s*daily$/i, '').trim();
    if (!isDaily && /^\d{1,2}:\d{2}$/.test(runAtIST)) {
      const [hh, mm] = runAtIST.split(':');
      runAtIST = `${formatISTDate()} ${hh.padStart(2, '0')}:${mm}`;
    }
    const repeat = isDaily ? 'DAILY' : 'ONCE';
    let targetJid = chatJid;
    if (targetPart.toLowerCase() !== 'here') {
      const b = state.bindings.find((x) => x.bindKey === targetPart);
      targetJid = b?.groupJid || targetPart;
    }
    const id = 'SCH' + Date.now().toString().slice(-5);
    await google.appendRow(MASTER_SHEET_ID, 'Custom_Schedules', [id, targetJid, payload, runAtIST, repeat, 'ACTIVE']);
    state.customSchedules.push({ id, targetJid, payload, runAtIST, repeat, status: 'ACTIVE' });
    return sendControlMsg(`⏰ Scheduled *${id}* (${repeat} at \`${runAtIST}\` IST).`);
  }

  if (cmd === '#schedules' && fullAuth) {
    if (!state.customSchedules.length) return sendControlMsg('No active custom schedules.');
    const lines = state.customSchedules.map((s) => `• *${s.id}* (${s.repeat} @ \`${s.runAtIST}\`): ${s.payload.slice(0, 40)}`);
    return sendControlMsg(`*Active Custom Schedules:*\n${lines.join('\n')}\n\nUse \`#unschedule <ID>\` to cancel.`);
  }

  if (cmd === '#unschedule' && fullAuth) {
    const id = (args[0] || '').trim();
    const rows = await google.getRows(MASTER_SHEET_ID, 'Custom_Schedules!A2:F');
    const idx = rows.findIndex((r) => (r[0] || '').trim() === id);
    if (idx < 0) return sendControlMsg(`Schedule \`${id}\` not found.`);
    await google.updateRange(MASTER_SHEET_ID, `Custom_Schedules!F${idx + 2}`, [['DONE']]);
    state.customSchedules = state.customSchedules.filter((s) => s.id !== id);
    return sendControlMsg(`🗑️ Cancelled schedule *${id}*.`);
  }

  if (cmd === '#save_msg' && fullAuth) {
    const nickname = (args[0] || '').trim();
    const body = text.split(/\r?\n/).slice(1).join('\n').trim();
    if (!nickname || !body) {
      return sendControlMsg('Usage:\n`#save_msg nickname`\nYour message text here...');
    }
    const rows = await google.getRows(MASTER_SHEET_ID, 'Templates!A2:E').catch(() => []);
    let maxVer = 0;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][0] || '').trim().toLowerCase() === nickname.toLowerCase()) {
        maxVer = Math.max(maxVer, Number(rows[i][2] || 1));
        if ((rows[i][3] || '').toUpperCase() === 'ACTIVE') {
          await google.updateRange(MASTER_SHEET_ID, `Templates!D${i + 2}`, [['OLD']], 'RAW');
        }
      }
    }
    const newVer = maxVer + 1;
    await google.appendRow(MASTER_SHEET_ID, 'Templates', [nickname, body, String(newVer), 'ACTIVE', formatISTTimestamp()]);
    await loadMasterState();
    return sendControlMsg(`💾 Saved *${nickname}* (v${newVer} ACTIVE${maxVer ? `, v${maxVer} kept as OLD` : ''}).`);
  }

  if (cmd === '#msgs' && fullAuth) {
    if (!state.templates.length) return sendControlMsg('No saved messages yet. Use `#save_msg <name>`.');
    const grouped = new Map();
    for (const t of state.templates) {
      if (!grouped.has(t.nickname)) grouped.set(t.nickname, []);
      grouped.get(t.nickname).push(t);
    }
    const blocks = [];
    for (const [name, list] of grouped.entries()) {
      const sorted = [...list].sort((a, b) => b.version - a.version);
      const lines = sorted.map((t) => `[${t.status} v${t.version}] ${t.text}`);
      blocks.push(`*${name}*\n${lines.join('\n')}`);
    }
    return sendControlMsg(`📚 *Saved Messages:*\n\n${blocks.join('\n\n')}`);
  }

  if (cmd === '#del_msg' && fullAuth) {
    const nickname = (args[0] || '').trim().toLowerCase();
    const onlyOld = (args[1] || '').toLowerCase() === 'old';
    if (!nickname) return sendControlMsg('Usage: `#del_msg <nickname> [old]`');
    const rows = await google.getRows(MASTER_SHEET_ID, 'Templates!A2:E').catch(() => []);
    const kept = rows.filter((r) => {
      const match = (r[0] || '').trim().toLowerCase() === nickname;
      if (!match) return true;
      return onlyOld ? (r[3] || '').toUpperCase() === 'ACTIVE' : false;
    });
    const padded = [...kept, ...Array(Math.max(0, rows.length - kept.length)).fill(Array(5).fill(''))];
    if (rows.length) await google.updateRange(MASTER_SHEET_ID, `Templates!A2:E${rows.length + 1}`, padded, 'RAW');
    await loadMasterState();
    return sendControlMsg(`🗑️ Deleted ${onlyOld ? 'old versions of ' : ''}*${nickname}*.`);
  }

  if (cmd === '#dnd' && fullAuth) {
    const sub = (args[0] || '').toLowerCase();
    const name = args.slice(1).join(' ').trim();
    if (!['add', 'remove'].includes(sub) || !name) return sendControlMsg('Usage: `#dnd add|remove <Name>`');
    const tracker = await reminders.loadTracker();
    const rec = tracker.find((t) => t.name.toLowerCase() === name.toLowerCase()) || {
      name, count: 0, lastDate: '', step: 0, dnd: false, mode: 'NORMAL',
    };
    rec.dnd = sub === 'add';
    await reminders.saveTrackerEntry(rec);
    return sendControlMsg(`🔕 No-DM for *${rec.name}*: *${rec.dnd ? 'ON' : 'OFF'}*.`);
  }

  if (cmd === '#reminders' && fullAuth) {
    const binding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (!binding) return sendControlMsg('⚠️ `gita_attendance` binding missing.');
    await reminders.runDailyReminderCheck({ sendControlMsg, binding });
    return;
  }

  if (cmd === '#track_members' && fullAuth) {
    const urlIdx = args.findIndex((a) => a.includes('docs.google.com/spreadsheets'));
    const customSheetUrl = urlIdx >= 0 ? args[urlIdx] : '';
    const query = (urlIdx >= 0 ? args.slice(0, urlIdx) : args).join(' ');
    await memberTracker.startTrackingGroup({ sock, query, customSheetUrl, sendControlMsg });
    return;
  }

  if (cmd === '#untrack_members' && fullAuth) {
    await memberTracker.untrackGroup({ query: args.join(' '), sendControlMsg });
    return;
  }

  if (cmd === '#outreach_sync' && fullAuth) {
    const res = await outreachMaster.syncMasterOutreach({ forceDir: true, sendNotice: (t) => sock.sendMessage(chatJid, { text: t }) });
    return sock.sendMessage(chatJid, { text: `✅ Outreach Master synced: *${res.total}* total active contacts (+${res.added} new).` });
  }

  if (cmd === '#outreach_assign' && fullAuth) {
    await outreachMaster.assignDailyCalls({ sendGroupMentionText, sendNotice: (t) => sock.sendMessage(chatJid, { text: t }) });
    return;
  }

  if (cmd === '#outreach_poll' && fullAuth) {
    await outreachMaster.sendWeeklyAvailabilityPoll({ sendPoll, sendNotice: (t) => sock.sendMessage(chatJid, { text: t }) });
    return;
  }

  if (cmd === '#outreach_clean_exits' && fullAuth) {
    await outreachMaster.cleanExitedMembers({ target: args.join(' ') || 'all', sendNotice: (t) => sock.sendMessage(chatJid, { text: t }) });
    return;
  }

  if (cmd === '#outreach_cap' && fullAuth) {
    const cap = parseInt(args[0], 10);
    if (!cap || cap < 1) return sock.sendMessage(chatJid, { text: 'Usage: `#outreach_cap <number>`' });
    await saveSetting('OUTREACH_DAILY_CAP', String(cap), 'Default daily calls per caller');
    return sock.sendMessage(chatJid, { text: `✅ Outreach daily call cap set to *${cap}*.` });
  }

  if (cmd === '#outreach_event' && fullAuth) {
    const ev = args.join(' ').trim();
    if (!ev || ev.toLowerCase() === 'clear') {
      await saveSetting('OUTREACH_ACTIVE_EVENT', '');
      return sock.sendMessage(chatJid, { text: '⏹️ Cleared active outreach event.' });
    }
    await saveSetting('OUTREACH_ACTIVE_EVENT', ev);
    await saveSetting('OUTREACH_ACTIVE_EVENT_EXPIRES', String(Date.now() + 6 * 86400000));
    return sock.sendMessage(chatJid, { text: `🏷️ Active outreach event set to *${ev}* (auto-expires in 6 days).` });
  }

  if (cmd === '#outreach_report' && fullAuth) {
    await outreachMaster.syncFormResponsesAndReport({ sendNotice: (t) => sock.sendMessage(chatJid, { text: t }), sendReport: true });
    return;
  }

  if (cmd === '#track_notify' && fullAuth) {
    const toggle = (args[args.length - 1] || '').toLowerCase();
    if (!['on', 'off'].includes(toggle) || args.length < 2) {
      return sendControlMsg('Usage: `#track_notify <group_keyword> <on|off>`');
    }
    const query = args.slice(0, -1).join(' ');
    await memberTracker.toggleNotify({ query, enabled: toggle === 'on', sendControlMsg });
    return;
  }

  if (cmd === '#dm_group' && fullAuth) {
    await groupBroadcast.startGroupDMFlow({ sock, chatJid, query: args.join(' '), sendControlMsg });
    return;
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
      isTest,
    });

    if (res.status === 'SENT' && !isTest) {
      await sendControlMsg(`✅ Sent Gita poll (*${res.dateStr}* — *${res.sessionName || 'Session'}*) to *${binding.groupName || binding.groupJid}*.`);
    } else if (res.status === 'ALREADY_SENT') {
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
