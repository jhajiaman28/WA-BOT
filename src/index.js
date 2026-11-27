const express = require('express');
const cron = require('node-cron');
const { PORT, TZ, MASTER_SHEET_ID, getISTNow, formatISTDate } = require('./config');
const google = require('./google');
const { state, loadMasterState, saveSetting, isPaused } = require('./state');
const { startWhatsApp, stopWhatsApp, sendControlMsg, sendPoll, enqueuePoll, getStatus, sendGroupText, sendGroupMentionText, sendDM, editControlMsg } = require('./whatsapp');
const gita = require('./categories/gitaAttendance');
const dailyPosts = require('./categories/dailyPosts');
const reminders = require('./reminders');
const memberTracker = require('./memberTracker');
const quiz = require('./quiz');
const outreachMaster = require('./outreachMaster');
const { processIncomingMessage } = require('./commands');
const quiz = require('./quiz');
const { generateTauntOption } = require('./ai');

const app = express();

app.get('/health', (_req, res) => {
  const { isConnected } = getStatus();
  res.json({ ok: true, whatsapp: isConnected ? 'connected' : 'disconnected', activePolls: state.activePolls.size });
});

app.get('/qr', (_req, res) => {
  const { isConnected, latestQRDataUrl } = getStatus();
  if (isConnected) return res.send('<h2>WhatsApp is connected!</h2>');
  if (!latestQRDataUrl) return res.send('<h2>Waiting for QR code... refresh in 5 seconds.</h2>');
  res.send(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif"><h3>Scan WhatsApp QR</h3><img src="${latestQRDataUrl}"/></body></html>`);
});

async function recoverMissedDispatches() {
  if (!getStatus().isConnected) return;
  const now = getISTNow();
  const today = formatISTDate(now);
  const mins = now.getHours() * 60 + now.getMinutes();

  if (mins >= 605 && !isPaused('gita_attendance') && state.settings.LAST_SENT_daily_report !== today) {
    const b = state.bindings.find((x) => x.bindKey === 'gita_attendance');
    if (b?.groupJid) {
      await saveSetting('LAST_SENT_daily_report', today);
      const res = await gita.buildDailyReport(b);
      if (res.text) {
        await sendGroupText(b.groupJid, res.text);
        await sendControlMsg('🔄 Recovered missed 10:00 AM daily report.');
      }
    }
  }

  if (now.getDay() === 1 && mins >= 845 && !isPaused('gita_attendance') && state.settings.LAST_SENT_weekly_report !== today) {
    const b = state.bindings.find((x) => x.bindKey === 'gita_attendance');
    if (b?.groupJid) {
      await saveSetting('LAST_SENT_weekly_report', today);
      const res = await gita.buildWeeklyReport(b);
      if (res.text) {
        await sendGroupText(b.groupJid, res.text);
        await sendControlMsg('🔄 Recovered missed Monday weekly report.');
      }
    }
  }

  if (mins >= 1085 && !isPaused('vidya_avidya') && state.settings.LAST_SENT_vidya_avidya !== today) {
    const vidyaBindings = state.bindings.filter((b) => (b.bindKey === 'vidya_avidya' || b.category === 'vidya_avidya') && b.groupJid);
    if (vidyaBindings.length) {
      await saveSetting('LAST_SENT_vidya_avidya', today);
      const payload = dailyPosts.buildVidyaPollPayload();
      for (const b of vidyaBindings) {
        enqueuePoll(async () => {
          const sent = await sendPoll(b.groupJid, payload);
          if (sent?.key?.id) await sendControlMsg(`🔄 Recovered missed Vidya-Avidya poll for *${b.groupName || b.groupJid}*.`);
        });
      }
    }
  }

  if (mins >= 1325 && !isPaused('gita_attendance') && !state.dailySentFlags.has(`gita_attendance:${today}`)) {
    const b = state.bindings.find((x) => x.bindKey === 'gita_attendance');
    if (b?.groupJid) {
      const sessionOverride = state.settings[`SESSION_OVERRIDE_${today}`];
      const fourth = await generateTauntOption(sessionOverride || 'Today');
      enqueuePoll(() => gita.dispatchGitaPoll({ sendPoll, sendControlMsg, binding: b, targetDate: today, sessionOverride, fourthOptionOverride: fourth }));
      await sendControlMsg('🔄 Recovering missed 10:00 PM Gita attendance poll.');
    }
  }
}

function setupCrons() {
  cron.schedule('0 6 * * *', async () => {
    const { isConnected } = getStatus();
    const paused = state.settings.SCHEDULE_PAUSED === 'TRUE' ? 'PAUSED' : 'ACTIVE';
    await sendControlMsg(
      `☀️ *Daily 6:00 AM Health Report*\n• WhatsApp: ${isConnected ? 'Connected' : 'Disconnected'}\n• Schedule: ${paused}\n• Active Polls (30d): ${state.activePolls.size}\n• Retry Queue: ${google.getRetryCount()}`
    );
  }, { timezone: TZ });

  cron.schedule('0 21 * * *', async () => {
    if (isPaused('gita_attendance')) return;
    const binding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (binding?.groupJid) await gita.askSessionConfirmation(sendControlMsg, binding);
  }, { timezone: TZ });

  cron.schedule('0 22 * * *', async () => {
    if (isPaused('gita_attendance')) return;
    const binding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (!binding?.groupJid) return;
    const today = formatISTDate();
    const sessionOverride = state.settings[`SESSION_OVERRIDE_${today}`];
    const fourth = await generateTauntOption(sessionOverride || 'Today');
    enqueuePoll(() => gita.dispatchGitaPoll({
      sendPoll,
      sendControlMsg,
      binding,
      targetDate: today,
      sessionOverride,
      fourthOptionOverride: fourth,
    }));
  }, { timezone: TZ });

  cron.schedule('0 10 * * *', async () => {
    if (isPaused('gita_attendance')) return;
    const binding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (!binding?.groupJid) return;
    await saveSetting('LAST_SENT_daily_report', formatISTDate());
    const res = await gita.buildDailyReport(binding);
    if (res.text) await sendGroupText(binding.groupJid, res.text);
  }, { timezone: TZ });

  cron.schedule('0 14 * * 1', async () => {
    if (isPaused('gita_attendance')) return;
    const binding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (!binding?.groupJid) return;
    await saveSetting('LAST_SENT_weekly_report', formatISTDate());
    const res = await gita.buildWeeklyReport(binding);
    if (res.text) await sendGroupText(binding.groupJid, res.text);
  }, { timezone: TZ });

  cron.schedule('0 0 * * *', async () => {
    if (isPaused('study_tracker')) return;
    const bindings = state.bindings.filter((b) => (b.bindKey === 'study_tracker' || b.category === 'study_tracker') && b.groupJid);
    for (const b of bindings) {
      enqueuePoll(async () => {
        const sent = await sendGroupText(b.groupJid, dailyPosts.buildStudyTrackerText());
        if (!sent?.key?.id) await sendControlMsg(`⚠️ Failed to send Study Tracker to *${b.groupName || b.groupJid}*.`);
      });
    }
  }, { timezone: TZ });

  cron.schedule('30 9 * * *', async () => {
    if (isPaused('gita_reminders')) return;
    const gitaBinding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (gitaBinding?.targetSheetId) await reminders.runDailyReminderCheck({ sendControlMsg, binding: gitaBinding });
  }, { timezone: TZ });

  cron.schedule('0 18 * * *', async () => {
    if (isPaused('vidya_avidya')) return;
    const vidyaBindings = state.bindings.filter((b) => (b.bindKey === 'vidya_avidya' || b.category === 'vidya_avidya') && b.groupJid);
    const payload = dailyPosts.buildVidyaPollPayload();
    for (const b of vidyaBindings) {
      enqueuePoll(async () => {
        const sent = await sendPoll(b.groupJid, payload);
        if (!sent?.key?.id) await sendControlMsg(`⚠️ Failed to send 6:00 PM Vidya-Avidya poll to *${b.groupName || b.groupJid}*.`);
      });
    }
  }, { timezone: TZ });

  cron.schedule('0 3 * * *', async () => {
    await gita.pruneOldLogs();
  }, { timezone: TZ });

  // Outreach Monday 8:00 AM IST Weekly Availability Poll
  cron.schedule('0 8 * * 1', async () => {
    if (isPaused('outreach')) return;
    await outreachMaster.sendWeeklyAvailabilityPoll({ sendPoll, sendNotice: (t) => sendGroupText(outreachMaster.getOutreachControlJid(), t) });
  }, { timezone: TZ });

  // Outreach Daily 10:05 AM IST Call Assignment
  cron.schedule('5 10 * * *', async () => {
    if (isPaused('outreach')) return;
    await outreachMaster.assignDailyCalls({ sendGroupMentionText, sendNotice: (t) => sendGroupText(outreachMaster.getOutreachControlJid(), t) });
  }, { timezone: TZ });

  // Outreach Daily 9:45 PM IST Form Sync & Accountability Report
  cron.schedule('45 21 * * *', async () => {
    if (isPaused('outreach')) return;
    await outreachMaster.syncFormResponsesAndReport({ sendNotice: (t) => sendGroupText(outreachMaster.getOutreachControlJid(), t), sendReport: true });
  }, { timezone: TZ });

  cron.schedule('* * * * *', async () => {
    if (!state.customSchedules.length) return;
    const now = getISTNow();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todayHHMM = `${formatISTDate(now)} ${hhmm}`;

    for (const s of [...state.customSchedules]) {
      if (s.status !== 'ACTIVE') continue;
      const match = s.repeat === 'DAILY' ? s.runAtIST === hhmm : s.runAtIST === todayHHMM;
      if (!match) continue;

      if (s.payload.startsWith('#')) {
        await processIncomingMessage({
          sock: { sendMessage: (jid, body) => sendGroupText(jid, body.text) },
          chatJid: s.targetJid,
          senderJid: process.env.OWNER_PHONE || '',
          text: s.payload,
          quotedId: null,
          sendControlMsg,
          sendPoll,
          enqueuePoll,
          sendDM,
          editControlMsg,
        }).catch(console.error);
      } else {
        const msgText = s.payload.startsWith('@')
          ? reminders.getTemplateText(s.payload.slice(1).trim())
          : s.payload;
        await sendGroupText(s.targetJid, msgText).catch(console.error);
      }

      if (s.repeat === 'ONCE') {
        s.status = 'DONE';
        const rows = await google.getRows(MASTER_SHEET_ID, 'Custom_Schedules!A2:F');
        const idx = rows.findIndex((r) => (r[0] || '').trim() === s.id);
        if (idx >= 0) await google.updateRange(MASTER_SHEET_ID, `Custom_Schedules!F${idx + 2}`, [['DONE']]);
      }
    }
  }, { timezone: TZ });

  setInterval(() => {
    const s = require('./whatsapp').getSock?.();
    memberTracker.syncOfflineChanges(s).catch(() => {});
    outreachMaster.syncFormResponsesAndReport({ sendNotice: null, sendReport: false }).catch(() => {});
  }, 1800000);

  setInterval(() => google.processRetryQueue(sendControlMsg).catch(console.error), 120000);
}

async function main() {
  app.listen(PORT, () => console.log(`[HTTP] Listening on port ${PORT}`));
  try {
    await loadMasterState();
    await quiz.initQuizModule?.().catch(console.error);
  } catch (err) {
    console.log('[Startup State Error]', err.stack || err.message);
  }
  setupCrons();
  setTimeout(() => recoverMissedDispatches().catch(console.error), 15000);
  await startWhatsApp();
}

main().catch((err) => {
  console.log('[Fatal]', err.stack || err.message);
  setTimeout(() => process.exit(1), 1000);
});

async function gracefulShutdown(sig) {
  console.log(`[Shutdown] ${sig} received, closing socket & flushing WA_Session...`);
  try { stopWhatsApp(); } catch {}
  try { await google.syncAuthToSheet(); } catch (e) { console.error('[Shutdown Sync]', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
