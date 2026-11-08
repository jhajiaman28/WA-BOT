const express = require('express');
const cron = require('node-cron');
const { PORT, TZ, formatISTDate } = require('./config');
const google = require('./google');
const { state, loadMasterState } = require('./state');
const { startWhatsApp, sendControlMsg, sendPoll, enqueuePoll, getStatus } = require('./whatsapp');
const gita = require('./categories/gitaAttendance');
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

function setupCrons() {
  // 6:00 AM IST Daily Health Report
  cron.schedule('0 6 * * *', async () => {
    const { isConnected } = getStatus();
    const paused = state.settings.SCHEDULE_PAUSED === 'TRUE' ? 'PAUSED' : 'ACTIVE';
    await sendControlMsg(
      `☀️ *Daily 6:00 AM Health Report*\n• WhatsApp: ${isConnected ? 'Connected' : 'Disconnected'}\n• Schedule: ${paused}\n• Active Polls (30d): ${state.activePolls.size}\n• Retry Queue: ${google.getRetryCount()}`
    );
  }, { timezone: TZ });

  // 9:45 PM IST Session Name Confirmation
  cron.schedule('45 21 * * *', async () => {
    if (state.settings.SCHEDULE_PAUSED === 'TRUE') return;
    const binding = state.bindings.find((b) => b.bindKey === 'gita_attendance');
    if (binding?.groupJid) await gita.askSessionConfirmation(sendControlMsg, binding);
  }, { timezone: TZ });

  // 10:00 PM IST Gita Attendance Poll Auto-Dispatch
  cron.schedule('0 22 * * *', async () => {
    if (state.settings.SCHEDULE_PAUSED === 'TRUE') return;
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

  // Retry queue flush every 2 minutes
  setInterval(() => google.processRetryQueue(sendControlMsg).catch(console.error), 120000);
}

async function main() {
  await loadMasterState();
  app.listen(PORT, () => console.log(`[HTTP] Listening on port ${PORT}`));
  setupCrons();
  await startWhatsApp();
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
