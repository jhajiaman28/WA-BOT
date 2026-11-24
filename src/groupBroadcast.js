const { normalizePhone } = require('./config');
const { state } = require('./state');

function resolveMemberLabel(jid, groupKey) {
  const clean = normalizePhone(jid);
  const reg = state.members.find((m) =>
    (!groupKey || m.groupKey === groupKey) &&
    (m.phoneJid === jid || m.lid === jid || (clean && (normalizePhone(m.phoneJid) === clean || normalizePhone(m.lid) === clean)))
  );
  if (reg?.officialName) return `${reg.officialName} (+${clean})`;
  const cached = state.contacts.get(jid) || state.contacts.get(`${clean}@s.whatsapp.net`);
  if (cached) return `${cached} (+${clean})`;
  return jid.endsWith('@lid') ? `Privacy-ID (${jid.split('@')[0]})` : `+${clean}`;
}

async function startGroupDMFlow({ sock, chatJid, query, sendControlMsg }) {
  await sendControlMsg('🔍 Fetching group & member list...');
  const rawGroups = await Promise.race([
    sock.groupFetchAllParticipating(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Group fetch timed out')), 15000)),
  ]);
  const all = Object.values(rawGroups);
  const matches = query
    ? all.filter((g) => (g.subject || '').toLowerCase().includes(query.toLowerCase()))
    : all;

  if (!matches.length) return sendControlMsg(`⚠️ No group matched "${query}".`);
  if (matches.length > 1) {
    const list = matches.slice(0, 15).map((g, i) => `${i + 1}. *${g.subject}* (${g.participants?.length || 0} members)`).join('\n');
    const m = await sendControlMsg(`*Multiple groups matched:*\n${list}\n\nQuote-reply with the number (e.g. *1*) to load its members, or *Cancel*.`);
    if (m?.key?.id) {
      state.pendingPrompts.set(m.key.id, { type: 'DM_PICK_GROUP', sock, groups: matches.slice(0, 15) });
    }
    return;
  }
  return showGroupMembersForDM({ sock, group: matches[0], sendControlMsg });
}

async function showGroupMembersForDM({ sock, group, sendControlMsg }) {
  const meta = await sock.groupMetadata(group.id);
  const myPhone = normalizePhone(sock.user?.id || '');
  const binding = state.bindings.find((b) => b.groupJid === group.id);
  const groupKey = binding?.bindKey || '';

  const members = (meta.participants || [])
    .map((p) => p.id)
    .filter((jid) => normalizePhone(jid) !== myPhone);

  const lines = members.map((jid, i) => `${i + 1}. ${resolveMemberLabel(jid, groupKey)}`);
  // Send in chunks of 45 lines so WhatsApp never truncates
  for (let i = 0; i < lines.length; i += 45) {
    const chunk = lines.slice(i, i + 45).join('\n');
    const header = i === 0 ? `👥 *${group.subject}* (${members.length} members)\n\n` : '';
    await sendControlMsg(`${header}${chunk}`);
  }

  const promptMsg = await sendControlMsg(
    `✉️ *Ready to DM ${group.subject} (${members.length} members)*\nQuote-reply to THIS message with:\n• Optional first line: \`Skip 2, 5, 11\` or \`Only 1, 3\`\n• Followed by your exact message text\n• Or reply *Cancel*`
  );
  if (promptMsg?.key?.id) {
    state.pendingPrompts.set(promptMsg.key.id, {
      type: 'DM_GROUP_SEND',
      groupName: group.subject,
      members,
      groupKey,
    });
  }
}

async function executeGroupDM({ prompt, replyText, sendControlMsg, sendDM, editControlMsg }) {
  const rawLines = replyText.split(/\r?\n/);
  if (rawLines.length === 1 && /^cancel$/i.test(rawLines[0].trim())) {
    await sendControlMsg('⏹️ Cancelled group DM.');
    return;
  }

  const excluded = new Set();
  const onlySet = new Set();
  let msgStartIdx = 0;

  const first = rawLines[0].trim();
  if (/^skip\s+[\d,\s]+$/i.test(first)) {
    first.match(/\d+/g)?.forEach((n) => excluded.add(Number(n) - 1));
    msgStartIdx = 1;
  } else if (/^only\s+[\d,\s]+$/i.test(first)) {
    first.match(/\d+/g)?.forEach((n) => onlySet.add(Number(n) - 1));
    msgStartIdx = 1;
  }

  const msgText = rawLines.slice(msgStartIdx).join('\n').trim();
  if (!msgText) {
    await sendControlMsg('⚠️ Message text is empty. Cancelled.');
    return;
  }

  const queue = [];
  const manualExcluded = [];
  const lidSkipped = [];

  prompt.members.forEach((jid, idx) => {
    const label = resolveMemberLabel(jid, prompt.groupKey);
    if (excluded.has(idx) || (onlySet.size > 0 && !onlySet.has(idx))) {
      manualExcluded.push(label);
    } else if (jid.endsWith('@lid')) {
      lidSkipped.push(label);
    } else {
      queue.push({ jid, label });
    }
  });

  if (!queue.length) {
    await sendControlMsg('⚠️ No valid phone-number recipients left after exclusions.');
    return;
  }

  state.dmJobActive = true;
  state.dmJobCancel = false;
  const progressMsg = await sendControlMsg(
    `📤 Starting safe batch DM to *${queue.length}* members (~${Math.ceil((queue.length * 19) / 60)} min).\nSend \`#cancel\` anytime to abort.`
  );

  const sentList = [];
  const failedList = [];

  for (let i = 0; i < queue.length; i++) {
    if (state.dmJobCancel || state.settings.EMERGENCY_STOP === 'TRUE') {
      await sendControlMsg(`🛑 Group DM aborted at *${sentList.length}/${queue.length}*.`);
      break;
    }

    const item = queue[i];
    const ok = await sendDM(item.jid, msgText);
    if (ok) sentList.push(item.label);
    else failedList.push(item.label);

    if ((i + 1) % 5 === 0 && i + 1 < queue.length) {
      const status = `⏳ Group DM progress: *${i + 1}/${queue.length}* processed (${sentList.length} sent)...`;
      const edited = progressMsg?.key ? await editControlMsg(progressMsg.key, status) : false;
      if (!edited) await sendControlMsg(status);
    }

    if (i + 1 < queue.length) {
      const isBatchBreak = (i + 1) % 25 === 0;
      const delay = isBatchBreak ? 120000 : (12000 + Math.floor(Math.random() * 10000));
      if (isBatchBreak) await sendControlMsg(`☕ Batch ${Math.floor((i + 1) / 25)} done (${i + 1}/${queue.length}). Taking a 2-min safety breather...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  state.dmJobActive = false;
  state.dmJobCancel = false;

  const report = [
    `📊 *Group DM Report — ${prompt.groupName}*`,
    `• ✅ Sent: *${sentList.length}*`,
    `• ⏭️ Manually Excluded: *${manualExcluded.length}*`,
    `• 🔒 @lid Skipped: *${lidSkipped.length}*`,
    `• ❌ Failed: *${failedList.length}*`,
  ];
  if (lidSkipped.length) report.push(`\n*Skipped (@lid):* ${lidSkipped.slice(0, 15).join(', ')}`);
  if (failedList.length) report.push(`\n*Failed:* ${failedList.join(', ')}`);
  await sendControlMsg(report.join('\n'));
}

module.exports = { startGroupDMFlow, showGroupMembersForDM, executeGroupDM };
