const { MASTER_SHEET_ID, formatISTDate, formatISTTimestamp } = require('./config');
const google = require('./google');
const { state, registerMember } = require('./state');
const { adaptRepeatReminder } = require('./ai');

const ESCALATION_DAYS = [3, 5, 7, 10, 14];

async function loadTracker() {
  const rows = await google.getRows(MASTER_SHEET_ID, 'Reminder_Tracker!A2:G').catch(() => []);
  return rows.filter((r) => r[0]).map((r, i) => ({
    rowNum: i + 2,
    name: (r[0] || '').trim(),
    count: Number(r[1] || 0),
    lastDate: (r[2] || '').trim(),
    step: Number(r[3] || 0),
    dnd: String(r[4] || '').toUpperCase() === 'TRUE',
    mode: (r[5] || 'NORMAL').trim().toUpperCase(),
    updated: (r[6] || '').trim(),
  }));
}

async function saveTrackerEntry(entry) {
  const rows = await google.getRows(MASTER_SHEET_ID, 'Reminder_Tracker!A2:G').catch(() => []);
  const idx = rows.findIndex((r) => (r[0] || '').trim().toLowerCase() === entry.name.toLowerCase());
  const rowVals = [entry.name, String(entry.count), entry.lastDate, String(entry.step), entry.dnd ? 'TRUE' : 'FALSE', entry.mode, formatISTTimestamp()];
  if (idx >= 0) {
    await google.updateRange(MASTER_SHEET_ID, `Reminder_Tracker!A${idx + 2}:G${idx + 2}`, [rowVals], 'RAW');
  } else {
    await google.appendRow(MASTER_SHEET_ID, 'Reminder_Tracker', rowVals);
  }
}

function getMemberStreakAndVotes(rows, colIdx, todayStr) {
  const dataRows = [];
  for (let r = 2; r < rows.length; r++) {
    const dStr = (rows[r]?.[1] || '').trim();
    if (/^\d{2}\/\d{2}\/\d{2}$/.test(dStr)) {
      const val = (rows[r]?.[colIdx] || '').trim();
      if (val === '✅' || val === '❌' || val === '➖') {
        dataRows.push({ date: dStr, val });
      }
      if (dStr === todayStr) break;
    }
  }
  let streak = 0;
  for (let i = dataRows.length - 1; i >= 0; i--) {
    if (dataRows[i].val === '➖') streak++;
    else break;
  }
  const last7 = dataRows.slice(-7);
  const recentVotes = last7.filter((x) => x.val === '✅' || x.val === '❌').length;
  return { streak, recentVotes };
}

function getTemplateText(nickname = 'default') {
  const active = state.templates.find((t) => t.nickname.toLowerCase() === nickname.toLowerCase() && t.status === 'ACTIVE');
  if (active) return active.text;
  const fallback = state.templates.find((t) => t.nickname === 'default' && t.status === 'ACTIVE');
  return fallback?.text || 'Namaste {Name} Ji,\nPlease cast your vote on the Gita Community poll when you get a moment.';
}

async function runDailyReminderCheck({ sendControlMsg, binding }) {
  if (!binding?.targetSheetId) return;
  const rows = await google.getRows(binding.targetSheetId, `${binding.targetTab}!A1:BZ`);
  const headerRow = rows[1] || [];
  const today = formatISTDate();
  const tracker = await loadTracker();
  const candidates = [];

  for (let c = 5; c < headerRow.length; c++) {
    const name = (headerRow[c] || '').trim();
    if (!name) continue;
    const { streak, recentVotes } = getMemberStreakAndVotes(rows, c, today);
    let rec = tracker.find((t) => t.name.toLowerCase() === name.toLowerCase()) || {
      name, count: 0, lastDate: '', step: 0, dnd: false, mode: 'NORMAL',
    };

    // Anti-gaming reset: requires 4+ actual votes in last 7 days to reset escalation
    if (rec.mode === 'ESCALATE' && recentVotes >= 4 && streak === 0) {
      rec.mode = 'NORMAL';
      rec.step = 0;
      await saveTrackerEntry(rec);
    }

    if (streak < 3) continue;
    if (rec.lastDate === today) continue;

    // Determine if due today based on escalation steps [3, 5, 7, 10, 14]
    const nextTarget = ESCALATION_DAYS.find((d) => d > rec.step) || 14;
    if (streak < nextTarget && rec.count > 0) continue;
    if (rec.count === 0 && streak < 3) continue;

    const reg = state.members.find(
      (m) => m.groupKey === binding.bindKey && m.officialName.toLowerCase() === name.toLowerCase()
    );
    const phoneJid = reg?.phoneJid || (reg?.lid ? reg.lid : '');
    candidates.push({
      name,
      streak,
      reminderNum: rec.count + 1,
      isDay14: streak >= 14,
      dnd: rec.dnd,
      phoneJid,
      rec,
    });
  }

  if (!candidates.length) return;

  const hasRepeat = candidates.some((c) => c.reminderNum > 1 && !c.dnd);
  const sampleRepeat = hasRepeat ? await adaptRepeatReminder(getTemplateText('default'), 2) : '';

  const lines = candidates.map((c, i) => {
    const tags = [`Day ${c.streak} • Reminder #${c.reminderNum}`];
    if (c.isDay14) tags.push('🚨 Day 14 - Removal Warning');
    if (c.dnd) tags.push('No-DM');
    if (!c.phoneJid) tags.push(`⚠️ No Phone (Reply: ${i + 1} = 98XXXXXXXX)`);
    return `${i + 1}. *${c.name}* (${tags.join(' | ')})`;
  });

  const previewNote = sampleRepeat ? `\n\n_Repeat preview:_ "${sampleRepeat.split('\n')[0]}..."` : '';
  const msg = await sendControlMsg(
    `🔔 *9:30 AM Inactive Reminder Check (${today})*\n${lines.join('\n')}${previewNote}\n\nQuote-reply: *Yes*, *Skip 2*, *Only 1,3*, *Include 4*, *DND 4*, *5 = 98XXXXXXXX*, *3 | strict*, or *No*`
  );

  if (msg?.key?.id) {
    state.pendingPrompts.set(msg.key.id, {
      type: 'CONFIRM_REMINDERS',
      binding,
      candidates,
      today,
    });
  }
}

async function processReminderReply({ prompt, replyText, sendControlMsg, sendDM, editControlMsg }) {
  const lines = replyText.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && /^(no|cancel|skip)$/i.test(lines[0])) {
    await sendControlMsg('⏹️ Cancelled today\'s reminders.');
    return;
  }

  const { candidates, binding, today } = prompt;
  const selected = new Set();
  const excluded = new Set();
  const overrides = new Map();
  let selectAllNonDnd = false;

  for (const line of lines) {
    if (/^yes$/i.test(line)) {
      selectAllNonDnd = true;
    } else if (/^only\s+([\d,\s]+)$/i.test(line)) {
      line.match(/\d+/g)?.forEach((n) => selected.add(Number(n) - 1));
    } else if (/^skip\s+([\d,\s]+)$/i.test(line)) {
      selectAllNonDnd = true;
      line.match(/\d+/g)?.forEach((n) => excluded.add(Number(n) - 1));
    } else if (/^include\s+([\d,\s]+)$/i.test(line)) {
      line.match(/\d+/g)?.forEach((n) => selected.add(Number(n) - 1));
    } else if (/^dnd\s+([\d,\s]+)$/i.test(line)) {
      for (const n of line.match(/\d+/g) || []) {
        const c = candidates[Number(n) - 1];
        if (c) {
          c.rec.dnd = !c.rec.dnd;
          await saveTrackerEntry(c.rec);
          await sendControlMsg(`🔕 Toggled No-DM for *${c.name}*: ${c.rec.dnd ? 'ON' : 'OFF'}`);
        }
      }
    } else if (/^(\d+)\s*=\s*([+\d\s-]+)$/.test(line)) {
      const m = line.match(/^(\d+)\s*=\s*([+\d\s-]+)$/);
      const idx = Number(m[1]) - 1;
      let digits = m[2].replace(/\D/g, '');
      if (digits.length === 10) digits = '91' + digits;
      const c = candidates[idx];
      if (c && digits.length >= 10) {
        c.phoneJid = `${digits}@s.whatsapp.net`;
        await registerMember(c.phoneJid, '', c.name, binding.bindKey);
        selected.add(idx);
      }
    } else if (/^(\d+)\s*\|\s*(\S+)$/.test(line)) {
      const m = line.match(/^(\d+)\s*\|\s*(\S+)$/);
      const idx = Number(m[1]) - 1;
      overrides.set(idx, m[2].trim());
      selected.add(idx);
    } else if (/^yes\s*\|\s*(\S+)$/i.test(line)) {
      const tpl = line.match(/^yes\s*\|\s*(\S+)$/i)[1].trim();
      selectAllNonDnd = true;
      candidates.forEach((_, idx) => { if (!overrides.has(idx)) overrides.set(idx, tpl); });
    }
  }

  const queue = candidates.filter((c, i) => {
    if (excluded.has(i)) return false;
    if (selected.has(i)) return Boolean(c.phoneJid);
    return selectAllNonDnd && !c.dnd && Boolean(c.phoneJid);
  });

  if (!queue.length) {
    await sendControlMsg('⚠️ No eligible recipients with phone numbers selected.');
    return;
  }

  const progressMsg = await sendControlMsg(`📤 Sending *${queue.length}* reminder(s) safely (~${Math.ceil((queue.length * 22) / 60)} min)...`);
  let sentCount = 0;

  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const tplName = overrides.get(candidates.indexOf(c)) || (c.isDay14 ? 'day14_exit' : 'default');
    let text = getTemplateText(tplName).replace(/\{Name\}/gi, c.name);

    if (c.reminderNum > 1) {
      text = await adaptRepeatReminder(text, c.reminderNum);
    }

    const ok = await sendDM(c.phoneJid, text);
    if (ok) {
      sentCount++;
      c.rec.count = c.reminderNum;
      c.rec.lastDate = today;
      c.rec.step = c.streak;
      c.rec.mode = 'ESCALATE';
      await saveTrackerEntry(c.rec);
    }

    if ((i + 1) % 3 === 0 && i + 1 < queue.length) {
      const statusText = `⏳ Reminder progress: *${sentCount}/${queue.length}* sent...`;
      const edited = progressMsg?.key ? await editControlMsg(progressMsg.key, statusText) : false;
      if (!edited) await sendControlMsg(statusText);
    }

    if (i + 1 < queue.length) {
      const delay = 15000 + Math.floor(Math.random() * 15000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const doneText = `✅ Finished sending *${sentCount}/${queue.length}* reminder DM(s).`;
  const edited = progressMsg?.key ? await editControlMsg(progressMsg.key, doneText) : false;
  if (!edited) await sendControlMsg(doneText);
}

module.exports = {
  loadTracker,
  saveTrackerEntry,
  getTemplateText,
  runDailyReminderCheck,
  processReminderReply,
};
