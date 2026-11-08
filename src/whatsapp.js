const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  getAggregateVotesInPollMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { AUTH_DIR } = require('./config');
const google = require('./google');
const { state } = require('./state');
const { processIncomingMessage } = require('./commands');
const gita = require('./categories/gitaAttendance');

let sock = null;
let latestQRDataUrl = null;
let isConnected = false;
const messageStore = new Map();
const dispatchQueue = [];
let dispatching = false;

function enqueuePoll(taskFn) {
  dispatchQueue.push(taskFn);
  if (!dispatching) runDispatchQueue();
}

async function runDispatchQueue() {
  dispatching = true;
  while (dispatchQueue.length) {
    const fn = dispatchQueue.shift();
    try { await fn(); } catch (e) { console.error('[Dispatch Queue]', e.message); }
    if (dispatchQueue.length) {
      const delay = 3000 + Math.floor(Math.random() * 4000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  dispatching = false;
}

async function sendControlMsg(text) {
  const jid = state.settings.CONTROL_GROUP_JID;
  if (!sock || !jid) return null;
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
  return sent;
}

async function sendPoll(groupJid, { question, options, selectableCount = 1 }) {
  if (!sock) return null;
  const sent = await sock.sendMessage(groupJid, {
    poll: { name: question, values: options, selectableCount },
  });
  if (sent?.key?.id) {
    state.sentMsgIds.add(sent.key.id);
    messageStore.set(sent.key.id, sent);
  }
  return sent;
}

async function startWhatsApp() {
  await google.restoreAuthFromDrive();
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => messageStore.get(key.id)?.message,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    google.scheduleAuthSyncToDrive();
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) latestQRDataUrl = await QRCode.toDataURL(qr);
    if (connection === 'open') {
      isConnected = true;
      latestQRDataUrl = null;
      console.log('[WhatsApp] Connected.');
      await sendControlMsg('🔄 Bot is online and monitoring.');
    }
    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startWhatsApp().catch(console.error), 5000);
      } else {
        console.error('[WhatsApp] Logged out. Scan QR at /qr.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || state.sentMsgIds.has(msg.key.id)) continue;
      if (msg.message.pollCreationMessage || msg.message.pollCreationMessageV3) {
        messageStore.set(msg.key.id, msg);
      }

      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.editedMessage?.message?.protocolMessage?.editedMessage?.conversation
        || '';
      if (!text) continue;

      const chatJid = msg.key.remoteJid;
      const senderJid = msg.key.fromMe ? sock.user?.id : (msg.key.participant || chatJid);
      const quotedId = msg.message.extendedTextMessage?.contextInfo?.stanzaId || null;

      await processIncomingMessage({ sock, chatJid, senderJid, text, quotedId, sendControlMsg, sendPoll, enqueuePoll });
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.pollUpdates) {
        const poll = state.activePolls.get(key.id);
        if (!poll) continue;
        const pollMsg = messageStore.get(key.id);
        const agg = getAggregateVotesInPollMessage({
          message: pollMsg?.message || { pollCreationMessageV3: { options: poll.options.map((o) => ({ optionName: o })) } },
          pollUpdates: update.pollUpdates,
        });

        for (const u of update.pollUpdates) {
          const voterJid = u.pollUpdateMessageKey?.participant || u.pollUpdateMessageKey?.remoteJid;
          const votedOption = agg.find((a) => a.voters.includes(voterJid))?.name;
          if (votedOption) {
            await gita.handleVote({ poll, voterJid, pushName: '', selectedOptions: [votedOption], sendControlMsg });
          }
        }
      }

      const editedText = update.message?.editedMessage?.message?.conversation
        || update.message?.editedMessage?.message?.extendedTextMessage?.text;
      if (editedText && !state.sentMsgIds.has(key.id)) {
        const senderJid = key.fromMe ? sock.user?.id : (key.participant || key.remoteJid);
        await processIncomingMessage({ sock, chatJid: key.remoteJid, senderJid, text: editedText, quotedId: null, sendControlMsg, sendPoll, enqueuePoll });
      }
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    const binding = state.bindings.find((b) => b.groupJid === id && b.trackJoins);
    if (!binding) return;

    for (const p of participants) {
      if (action === 'add') {
        const msg = await sendControlMsg(
          `👋 *New Member Joined* *${binding.groupName}* (\`${p}\`).\nQuote-reply with their official short name to add alphabetically to *${binding.targetTab}*, or reply *Skip*.`
        );
        if (msg?.key?.id) {
          const isLid = p.endsWith('@lid');
          state.pendingPrompts.set(msg.key.id, {
            type: 'CONFIRM_JOIN',
            binding,
            phoneJid: isLid ? '' : p,
            lid: isLid ? p : '',
          });
        }
      } else if (action === 'remove' || action === 'leave') {
        const existing = state.members.find((m) => m.groupKey === binding.bindKey && (m.phoneJid === p || m.lid === p));
        const memberName = existing?.officialName || p;
        const msg = await sendControlMsg(
          `🚪 *Member ${action === 'remove' ? 'Removed' : 'Left'}* *${binding.groupName}*: *${memberName}*.\nQuote-reply *Yes* to confirm exit log or *No* to skip.`
        );
        if (msg?.key?.id) {
          state.pendingPrompts.set(msg.key.id, {
            type: 'CONFIRM_EXIT',
            groupName: binding.groupName,
            groupJid: id,
            memberName,
            phoneJid: p,
            action,
          });
        }
      }
    }
  });
}

module.exports = {
  startWhatsApp,
  sendControlMsg,
  sendPoll,
  enqueuePoll,
  getStatus: () => ({ isConnected, latestQRDataUrl }),
};
