const { SheetsClient } = require('./sheets');
const { PermissionManager } = require('./permissions');
const { handlePollControlMessage } = require('./commands');

const sheets = new SheetsClient();
const permissions = new PermissionManager(sheets);
let initialized = false;

async function initQuizModule() {
  try {
    const res = await sheets.syncFromSheet();
    initialized = true;
    console.log(`[POLL-CTRL] Initialized (${res.mode}, ${res.tabsLoaded} tabs)`);
  } catch (err) {
    console.error('[POLL-CTRL] Init error:', err.message);
  }
}

function getPollControlJid() {
  const settings = sheets.getSettingsMap();
  return settings.POLL_CONTROL_JID || '';
}

async function handleIncoming({ sock, chatJid, senderJid, text, globalEmergencyStop = false }) {
  if (!initialized) await initQuizModule();

  const trimmed = (text || '').trim();
  const isSetCmd = /^#set_poll_control(\s|$)/i.test(trimmed);
  const pollControlJid = getPollControlJid();

  if (!isSetCmd && chatJid !== pollControlJid) {
    return false;
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '#find' && sock) {
    const perm = permissions.isAllowed(senderJid, cmd, 'POLL_CTRL');
    if (!perm.allowed) {
      await sock.sendMessage(chatJid, { text: `⛔ ${perm.reason}` });
      return true;
    }
    const query = parts.slice(1).join(' ').toLowerCase();
    await sock.sendMessage(chatJid, { text: '🔍 Searching groups...' });
    const rawGroups = await sock.groupFetchAllParticipating();
    const all = Object.values(rawGroups);
    const matches = (!query || query === 'all') ? all : all.filter((g) => (g.subject || '').toLowerCase().includes(query));
    const lines = matches.slice(0, 25).map((g, i) => `${i + 1}. *${g.subject}* (\`${g.id}\`)`);
    await sock.sendMessage(chatJid, { text: lines.length ? `*Groups Found:*\n${lines.join('\n')}` : 'No matching groups found.' });
    return true;
  }

  const res = await handlePollControlMessage({
    remoteJid: chatJid,
    senderJid,
    text,
    sheets,
    permissions,
    globalEmergencyStop,
  });

  if (res.ignored) return false;
  if (res.reply && sock) {
    await sock.sendMessage(chatJid, { text: res.reply });
  }
  return true;
}

module.exports = {
  initQuizModule,
  getPollControlJid,
  handleIncoming,
};
