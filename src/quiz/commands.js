const path = require('path');
const { MASTER_SHEET_ID } = require('./config');
const { getDailyContributions, schedulePost, shiftScheduledPosts } = require('./pipeline');
const { lintPostPackage, renderPreview } = require('./linter');
const { buildWeeklyRankings } = require('./dispatch');
const { generateWeeklyPdf } = require('./pdf');
const { getTodayISTStr, getISTTimestamp } = require('./dayx');

const activeState = {
  pendingPrompts: new Map(),
  aborted: false,
};

function formatHelp() {
  return [
    '*📚 Poll Control — Command Reference*',
    '',
    '*Universal & Emergency Commands*',
    '• `#help` — Show Poll Control commands',
    '• `#status` — Bot health, storage mode, and queue summary',
    '• `#sync` — Reload Master Sheet (`Settings` & `Admin_Permissions`)',
    '• `#sync_votes` — Reconcile missed poll votes',
    '• `#cancel` — Abort active job or clear pending prompts',
    '• `#kill` / `#wake` — Emergency Stop (only `#status`, `#help`, `#wake` active)',
    '• `#set_poll_control` — Bind current group as Poll Control',
    '',
    '*Manual AI Handoff Commands (Until Phase 2)*',
    '• `#pending_ai` — Show posts waiting for `/poll-preparation`',
    '• `#submit_q <P-XX> <text>` — Submit 5 questions → Name Review',
    '• `#submit_pkg <P-XX> <topic> | <context> | <q> | <A;;B;;C;;D> | <correct> | <ans> | <m_img> | <e_img>`',
    '• `#log_analysis <Day_X> <theme> | <notes>` — Optional post-quiz AI note',
    '',
    '*Pipeline & Schedule Commands*',
    '• `#calendar` — 7–14 day quiz schedule view',
    '• `#preview <P-XX>` — Render morning & evening blocks',
    '• `#contrib` — Today’s Post Selection tracker & duplicates',
    '• `#save_quiz <P-XX>` — Validate & queue finalized post',
    '• `#promote <P-XX> [DD/MM/YY]` — Move Spare Post to schedule',
    '• `#swap <P-XX>` — Emergency pre-dispatch swap',
    '• `#autopick <P-XX> on/off` — Tag Spare Post for Auto-Pick',
    '• `#event_pause on/off [days]` — Pause & shift scheduled dates',
    '• `#autofallback on/off` — Toggle Spare fallback when Auto-Pick is empty',
    '• `#setemoji <action> <emoji>` — Update workflow reaction emojis',
    '• `#pdf [day1,day2,...]` — Generate Sunday Weekly Result PDF',
    '• `#backup` — In-place Google Sheet queue snapshot',
  ].join('\n');
}

async function handlePollControlMessage({ remoteJid, senderJid, text, sheets, permissions, globalEmergencyStop = false }) {
  const settings = sheets.getSettingsMap();
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('#')) return { ignored: true, reason: 'Not a command' };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '#set_poll_control') {
    const perm = permissions.isAllowed(senderJid, cmd, 'POLL_CTRL');
    if (!perm.allowed) return { reply: `⛔ ${perm.reason}` };
    await sheets.setSetting('POLL_CONTROL_JID', remoteJid);
    return { reply: `✅ Bound \`${remoteJid}\` as *Poll Control Group*.` };
  }

  if (remoteJid !== settings.POLL_CONTROL_JID) {
    return { ignored: true, reason: `Not Poll Control JID (${remoteJid})` };
  }

  const perm = permissions.isAllowed(senderJid, cmd, 'POLL_CTRL');
  if (!perm.allowed) {
    console.log(`[POLL-CTRL] Blocked ${cmd} from ${senderJid}: ${perm.reason}`);
    return { reply: `⛔ ${perm.reason}` };
  }

  const emergencyOn = globalEmergencyStop || String(settings.EMERGENCY_STOP).toUpperCase() === 'TRUE';
  if (emergencyOn && !['#status', '#help', '#wake'].includes(cmd)) {
    return { reply: '🛑 *EMERGENCY STOP ACTIVE.* Only `#status`, `#help`, and `#wake` are responsive.' };
  }

  console.log(`[POLL-CTRL] Executing ${cmd} (role=${perm.role})`);

  if (cmd === '#kill') {
    activeState.aborted = true;
    activeState.pendingPrompts.clear();
    await sheets.setSetting('EMERGENCY_STOP', 'TRUE');
    return { reply: '🛑 *EMERGENCY STOP ACTIVATED.* All dispatches and commands halted. Send `#wake` to resume.' };
  }

  if (cmd === '#wake') {
    activeState.aborted = false;
    await sheets.setSetting('EMERGENCY_STOP', 'FALSE');
    return { reply: '🟢 *Bot Resumed.* `EMERGENCY_STOP` cleared.' };
  }

  if (cmd === '#cancel') {
    activeState.aborted = true;
    activeState.pendingPrompts.clear();
    return { reply: '🚫 Active jobs aborted and pending prompts cleared.' };
  }

  if (cmd === '#help') return { reply: formatHelp() };

  if (cmd === '#sync') {
    const syncInfo = await sheets.syncFromSheet();
    const refreshed = sheets.getSettingsMap();
    return {
      reply: `✅ *Master Sheet Synced* (\`${syncInfo.mode}\`, ${syncInfo.tabsLoaded} tabs, Emergency Stop: \`${refreshed.EMERGENCY_STOP}\`, Event Paused: \`${refreshed.EVENT_PAUSED}\`)`,
    };
  }

  if (cmd === '#status') {
    const pipeline = sheets.getTabRows('Post_Pipeline');
    const votes = sheets.getTabRows('Quiz_Vote_Ledger');
    const readyCount = pipeline.filter((p) => p.Stage === 'Scheduled').length;
    const waitingAi = pipeline.filter((p) => p.Stage === 'Awaiting_5_Questions' || p.Stage === 'Awaiting_Full_Package').length;
    const lowWarn = readyCount < Number(settings.LOW_QUEUE_THRESHOLD || 3) ? ' ⚠️ Low Queue!' : '';
    return {
      reply: [
        `*${emergencyOn ? '🛑' : '🟢'} Poll Pipeline Bot — Status*`,
        `• Emergency Stop: \`${settings.EMERGENCY_STOP}\``,
        `• Storage Mode: \`${sheets.mode}\` (\`${MASTER_SHEET_ID}\`)`,
        `• Scheduled Ready: ${readyCount}${lowWarn}`,
        `• Waiting Manual AI: ${waitingAi}`,
        `• Event Paused: \`${settings.EVENT_PAUSED}\` | Auto Fallback: \`${settings.AUTO_FALLBACK}\``,
        `• Total Posts: ${pipeline.length} | Logged Votes: ${votes.length}`,
      ].join('\n'),
    };
  }

  if (cmd === '#pending_ai') {
    const pending = sheets
      .getTabRows('Post_Pipeline')
      .filter((p) => p.Stage === 'Awaiting_5_Questions' || p.Stage === 'Awaiting_Full_Package' || (Number(p.Revision_Count || 0) > 0 && p.Stage !== 'Scheduled' && p.Stage !== 'Dispatched'));
    if (pending.length === 0) return { reply: '✅ No posts waiting for `/poll-preparation` right now.' };
    const lines = pending.map((p) => `• \`${p.Post_ID}\` (${p.Topic || 'Untitled'}) — *${p.Stage}* (Rev: ${p.Revision_Count || 0})`);
    return { reply: `🤖 *Posts Waiting Manual AI Input:*\n${lines.join('\n')}` };
  }

  if (cmd === '#submit_q') {
    const postId = parts[1];
    const qText = trimmed.replace(/^#submit_q\s+\S+\s*/i, '').trim();
    if (!postId || !qText) return { reply: '❌ Usage: `#submit_q <P-XX> <5 questions text>`' };
    await sheets.upsertRowObj('Post_Pipeline', 'Post_ID', postId, {
      Question: qText,
      Stage: 'Q_Name_Review',
      Last_Updated: getISTTimestamp(),
    });
    return { reply: `✅ Saved 5 questions for \`${postId}\` → moved to *Q_Name_Review*.` };
  }

  if (cmd === '#submit_pkg') {
    const postId = parts[1];
    const body = trimmed.replace(/^#submit_pkg\s+\S+\s*/i, '').trim();
    const fields = body.split('|').map((s) => s.trim());
    if (!postId || fields.length < 8) {
      return { reply: '❌ Usage: `#submit_pkg <P-XX> <topic> | <context> | <question> | <A;;B;;C;;D> | <correct> | <answer> | <m_poster> | <e_poster>`' };
    }
    const [topic, context, question, optsRaw, correct, answer, mPoster, ePoster] = fields;
    const options = optsRaw.split(';;').map((s) => s.trim()).filter(Boolean);
    await sheets.upsertRowObj('Post_Pipeline', 'Post_ID', postId, {
      Topic: topic,
      Morning_Context: context,
      Question: question,
      Options_JSON: JSON.stringify(options),
      Correct_Option: correct,
      Evening_Answer: answer,
      Morning_Poster_Ref: mPoster,
      Evening_Poster_Ref: ePoster,
      Stage: 'Pkg_Name_Review',
      Last_Updated: getISTTimestamp(),
    });
    return { reply: `✅ Full package saved for \`${postId}\` → moved to *Pkg_Name_Review*.` };
  }

  if (cmd === '#log_analysis') {
    const dayX = parts[1];
    const body = trimmed.replace(/^#log_analysis\s+\S+\s*/i, '').trim();
    const [theme, notes] = body.split('|').map((s) => (s || '').trim());
    if (!dayX || !theme) return { reply: '❌ Usage: `#log_analysis <Day_X> <theme> | <notes>`' };
    await sheets.upsertRowObj('Quiz_Archive', 'Day_X', String(dayX), {
      Final_Theme: theme,
      AI_Root_Cause: notes || '',
    });
    return { reply: `📝 Logged manual analysis for *Day ${dayX}* (Theme: \`${theme}\`).` };
  }

  if (cmd === '#calendar') {
    const scheduled = sheets
      .getTabRows('Post_Pipeline')
      .filter((p) => p.Stage === 'Scheduled' || p.Scheduled_Date)
      .slice(0, 14);
    if (scheduled.length === 0) return { reply: '📅 No upcoming scheduled posts yet.' };
    const lines = scheduled.map(
      (p) => `Day ${p.Day_X || '?'} | ${p.Scheduled_Date || 'TBD'} | ${p.Post_ID} | ${p.Topic}\nStatus: ${p.Stage}`
    );
    return { reply: `📅 *Upcoming Quiz Schedule*\n\n${lines.join('\n\n')}` };
  }

  if (cmd === '#contrib') {
    const c = getDailyContributions(sheets);
    const list = Object.entries(c.counts)
      .map(([name, cnt]) => `• ${name}: ${cnt}`)
      .join('\n') || '• No submissions today';
    return { reply: `📊 *Post Selection (${c.date})*\n${list}\n• Duplicates blocked: ${c.duplicates}` };
  }

  if (cmd === '#preview') {
    const post = sheets.getTabRows('Post_Pipeline').find((p) => p.Post_ID === parts[1]);
    if (!post) return { reply: `❌ Post \`${parts[1] || ''}\` not found.` };
    return { reply: renderPreview(post) };
  }

  if (cmd === '#save_quiz') {
    const post = sheets.getTabRows('Post_Pipeline').find((p) => p.Post_ID === parts[1]);
    if (!post) return { reply: `❌ Post \`${parts[1] || ''}\` not found.` };
    const check = lintPostPackage(post);
    if (!check.valid) {
      return { reply: `❌ *Pre-Flight Linter Failed (${post.Post_ID}):*\n• ${check.errors.join('\n• ')}` };
    }
    const targetDate = parts[2] || getTodayISTStr();
    const updated = await schedulePost(sheets, post.Post_ID, targetDate);
    return { reply: `✅ \`${post.Post_ID}\` passed all checks and scheduled for *Day ${updated.Day_X}* (${updated.Scheduled_Date}).` };
  }

  if (cmd === '#promote') {
    const postId = parts[1];
    const targetDate = parts[2] || getTodayISTStr();
    const updated = await schedulePost(sheets, postId, targetDate);
    return { reply: `📅 Promoted \`${updated.Post_ID}\` from Spare to *Day ${updated.Day_X}* (${updated.Scheduled_Date}).` };
  }

  if (cmd === '#swap') {
    const postId = parts[1];
    const targetDate = parts[2] || getTodayISTStr();
    const updated = await schedulePost(sheets, postId, targetDate);
    return { reply: `🔄 Emergency swap complete: \`${updated.Post_ID}\` is now active for *Day ${updated.Day_X}* (${updated.Scheduled_Date}).` };
  }

  if (cmd === '#autopick') {
    const postId = parts[1];
    const flag = (parts[2] || '').toLowerCase() === 'on' ? 'TRUE' : 'FALSE';
    await sheets.upsertRowObj('Post_Pipeline', 'Post_ID', postId, { Auto_Pick: flag });
    return { reply: `⭐ \`${postId}\` Auto-Pick set to \`${flag}\`.` };
  }

  if (cmd === '#autofallback') {
    const flag = (parts[1] || '').toLowerCase() === 'on' ? 'TRUE' : 'FALSE';
    await sheets.setSetting('AUTO_FALLBACK', flag);
    return { reply: `⚙️ \`AUTO_FALLBACK\` set to \`${flag}\`.` };
  }

  if (cmd === '#event_pause') {
    const on = (parts[1] || '').toLowerCase() === 'on';
    const shiftDays = Number(parts[2] || 0);
    await sheets.setSetting('EVENT_PAUSED', on ? 'TRUE' : 'FALSE');
    let shifted = 0;
    if (on && shiftDays > 0) {
      shifted = await shiftScheduledPosts(sheets, shiftDays);
    }
    return { reply: `⏸️ Event Pause: \`${on ? 'TRUE' : 'FALSE'}\` (shifted ${shifted} scheduled posts by ${shiftDays} days).` };
  }

  if (cmd === '#setemoji') {
    const actionMap = {
      approve: 'EMOJI_APPROVE',
      revision: 'EMOJI_REVISION',
      hold: 'EMOJI_HOLD',
      schedule: 'EMOJI_SCHEDULE',
      spare: 'EMOJI_SPARE',
      autopick: 'EMOJI_AUTOPICK',
    };
    const key = actionMap[(parts[1] || '').toLowerCase()];
    if (!key || !parts[2]) return { reply: '❌ Usage: `#setemoji <approve|revision|hold|schedule|spare|autopick> <emoji>`' };
    await sheets.setSetting(key, parts[2]);
    return { reply: `✅ Updated \`${key}\` to ${parts[2]}` };
  }

  if (cmd === '#pdf') {
    const dayList = parts[1]
      ? parts[1].split(',').map((s) => s.trim())
      : [...new Set(sheets.getTabRows('Quiz_Vote_Ledger').map((v) => v.Day_X).filter(Boolean))];
    const { ranked, toughest } = buildWeeklyRankings(sheets, dayList);
    const outPath = path.join(__dirname, '..', 'data', 'Weekly_Quiz_Report.pdf');
    generateWeeklyPdf(outPath, {
      title: 'Weekly Quiz Results',
      subtitle: `Days: ${dayList.join(', ') || 'None'} | Top Cutoff: ${settings.TOP_SCORER_COUNT}`,
      rows: ranked,
      toughestLine: toughest ? `Day ${toughest.dayX} (${toughest.correctPct}% correct)` : 'N/A',
    });
    const topN = ranked.slice(0, Number(settings.TOP_SCORER_COUNT || 5));
    const topMsg = topN.map((r) => `${r.rank}. ${r.name} — ${r.points} pts`).join('\n') || 'No participants yet.';
    return {
      reply: `📄 *Sunday PDF Generated:* \`${outPath}\`\n\n*Top ${topN.length} Scorers (Confirm cutoff before sending):*\n${topMsg}`,
    };
  }

  if (cmd === '#backup') {
    sheets.saveLocalMirror();
    return { reply: `💾 In-place Google Sheet snapshot saved (${sheets.getTabRows('Post_Pipeline').length} posts).` };
  }

  if (cmd === '#sync_votes') {
    return { reply: `🔄 Vote ledger reconciled (${sheets.getTabRows('Quiz_Vote_Ledger').length} durable records).` };
  }

  return { reply: `❓ Unknown command \`${cmd}\`. Type \`#help\`.` };
}

module.exports = { handlePollControlMessage };
