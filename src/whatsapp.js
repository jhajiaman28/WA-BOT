const fs = require('fs');
const crypto = require('crypto');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  getAggregateVotesInPollMessage,
  decryptPollVote,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { AUTH_DIR, normalizePhone } = require('./config');
const google = require('./google');
const { state } = require('./state');
const { processIncomingMessage } = require('./commands');
const gita = require('./categories/gitaAttendance');
const memberTracker = require('./memberTracker');

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

async function sendGroupText(groupJid, text) {
  if (!sock || !groupJid) return null;
  const sent = await sock.sendMessage(groupJid, { text });
  if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
  return sent;
}

async function deleteControlMsg(msgKey) {
  const jid = state.settings.CONTROL_GROUP_JID;
  if (!sock || !jid || !isConnected || !msgKey) return false;
  try {
    await sock.sendMessage(jid, { delete: msgKey });
    return true;
  } catch {
    return false;
  }
}

async function editControlMsg(msgKey, newText) {
  const jid = state.settings.CONTROL_GROUP_JID;
  if (!sock || !jid || !isConnected) return false;
  try {
    await sock.sendMessage(jid, { text: newText, edit: msgKey });
    return true;
  } catch {
    return false;
  }
}

async function sendDM(targetJid, text) {
  if (!sock || !targetJid || !isConnected) return false;
  try {
    const sent = await sock.sendMessage(targetJid, { text });
    if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
    return Boolean(sent?.key?.id);
  } catch (err) {
    console.error('[sendDM]', err.message);
    return false;
  }
}

async function sendControlMsg(text) {
  const jid = state.settings.CONTROL_GROUP_JID;
  if (!sock || !jid) return null;
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key?.id) state.sentMsgIds.add(sent.key.id);
  return sent;
}

async function sendPoll(groupJid, { question, options, selectableCount = 1 }) {
  if (!sock || !isConnected) {
    console.error('[sendPoll] Aborted: WhatsApp socket not connected.');
    return null;
  }
  const sent = await sock.sendMessage(groupJid, {
    poll: { name: question, values: options, selectableCount },
  });
  if (sent?.key?.id) {
    state.sentMsgIds.add(sent.key.id);
    messageStore.set(sent.key.id, sent);
  }
  return sent;
}

function buildFallbackPollMsg(poll) {
  return {
    pollCreationMessageV3: {
      options: poll.options.map((o) => ({ optionName: o })),
    },
    ...(poll.secret ? { messageContextInfo: { messageSecret: Buffer.from(poll.secret, 'base64') } } : {}),
  };
}

function tryDecryptVote(pu, msg, poll) {
  const creators = [...new Set([
    pu.pollCreationMessageKey?.participant,
    sock.user?.id,
    sock.user?.lid,
  ].filter(Boolean).map((j) => jidNormalizedUser(j)))];

  const voters = [...new Set([
    msg.key.fromMe ? sock.user?.id : null,
    msg.key.fromMe ? sock.user?.lid : null,
    msg.key.participant,
    msg.key.participantAlt,
    msg.key.remoteJid,
  ].filter(Boolean).map((j) => jidNormalizedUser(j)))];

  const encKey = Buffer.from(poll.secret, 'base64');
  const pollMsgId = pu.pollCreationMessageKey?.id;

  for (const creatorJid of creators) {
    for (const voterJid of voters) {
      try {
        const decrypted = decryptPollVote(pu.vote, {
          pollCreatorJid: creatorJid,
          pollMsgId,
          pollEncKey: encKey,
          voterJid,
        });
        return { decrypted, voterJid };
      } catch {
        // try next JID combination
      }
    }
  }
  throw new Error('Could not decrypt vote with any JID combination');
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
      setTimeout(async () => {
        try {
          if (sock?.user?.id && sock.assertSessions) {
            await sock.assertSessions([jidNormalizedUser(sock.user.id)], false);
          }
        } catch {}
        await sendControlMsg('🔄 Bot is online and monitoring.').catch(() => {});
      }, 3000);
      setTimeout(() => memberTracker.syncOfflineChanges(sock).catch(console.error), 8000);
    }
    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startWhatsApp().catch(console.error), 5000);
      } else {
        console.error('[WhatsApp] Logged out. Clearing stale session & generating fresh QR...');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        await google.clearAuthInSheet();
        setTimeout(() => startWhatsApp().catch(console.error), 3000);
      }
    }
  });

  sock.ev.on('messaging-history.set', async ({ messages }) => {
    for (const msg of messages || []) {
      if (msg.message?.pollUpdateMessage && state.activePolls.has(msg.message.pollUpdateMessage.pollCreationMessageKey?.id)) {
        sock.ev.emit('messages.upsert', { messages: [msg], type: 'append' });
      }
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts || []) {
      const name = c.notify || c.name || c.verifiedName;
      if (c.id && name) state.contacts.set(jidNormalizedUser(c.id), name);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.message.pollCreationMessage || msg.message.pollCreationMessageV3) {
          messageStore.set(msg.key.id, msg);
        }

        if (msg.message.pollUpdateMessage) {
          if (state.settings.EMERGENCY_STOP === 'TRUE') continue;
          const pu = msg.message.pollUpdateMessage;
          const pollId = pu.pollCreationMessageKey?.id;
          const poll = state.activePolls.get(pollId);
          if (poll && poll.secret) {
            const { decrypted, voterJid } = tryDecryptVote(pu, msg, poll);
            const selectedHashes = (decrypted?.selectedOptions || []).map((b) => Buffer.from(b).toString('hex'));
            const selectedNames = poll.options.filter((opt) =>
              selectedHashes.includes(crypto.createHash('sha256').update(opt).digest('hex'))
            );
            const finalOpts = selectedNames.length ? selectedNames : ['__UNVOTE__'];
            await gita.handleVote({ poll, voterJid, pushName: msg.pushName || '', selectedOptions: finalOpts, sendControlMsg });
          }
          continue;
        }

        if (state.sentMsgIds.has(msg.key.id)) continue;

        const inner = msg.message.ephemeralMessage?.message
          || msg.message.deviceSentMessage?.message
          || msg.message.viewOnceMessage?.message
          || msg.message;
        const text = inner.conversation
          || inner.extendedTextMessage?.text
          || inner.editedMessage?.message?.protocolMessage?.editedMessage?.conversation
          || '';
        const chatJid = msg.key.remoteJid;
        if (chatJid === state.settings.CONTROL_GROUP_JID) {
          console.log('[Control Rx]', { fromMe: msg.key.fromMe, keys: Object.keys(msg.message), text: text.slice(0, 40) });
        }
        if (!text) continue;

        const senderJid = jidNormalizedUser(msg.key.fromMe ? sock.user?.id : (msg.key.participant || chatJid));
        const quotedId = inner.extendedTextMessage?.contextInfo?.stanzaId || msg.message.extendedTextMessage?.contextInfo?.stanzaId || null;

        await processIncomingMessage({ sock, chatJid, senderJid, text, quotedId, sendControlMsg, sendPoll, enqueuePoll, sendDM, editControlMsg, deleteControlMsg });
      } catch (err) {
        console.error('[WA Message Error]', err);
        await sendControlMsg(`⚠️ Error: ${err.message}`).catch(() => {});
      }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      try {
        if (update.pollUpdates) {
          if (state.settings.EMERGENCY_STOP === 'TRUE') continue;
          const poll = state.activePolls.get(key.id);
          if (!poll) continue;
          const pollMsg = messageStore.get(key.id);
          const agg = getAggregateVotesInPollMessage({
            message: pollMsg?.message || buildFallbackPollMsg(poll),
            pollUpdates: update.pollUpdates,
          });

          for (const u of update.pollUpdates) {
            const rawVoter = u.pollUpdateMessageKey?.fromMe
              ? sock.user?.id
              : (u.pollUpdateMessageKey?.participant || u.pollUpdateMessageKey?.remoteJid);
            const voterJid = jidNormalizedUser(rawVoter);
            const voterPhone = normalizePhone(voterJid);
            const votedOption = agg.find((a) =>
              a.voters.some((v) => v === voterJid || (voterPhone && normalizePhone(v) === voterPhone))
            )?.name;
            if (votedOption) {
              await gita.handleVote({ poll, voterJid, pushName: '', selectedOptions: [votedOption], sendControlMsg });
            }
          }
        }

        const editedText = update.message?.editedMessage?.message?.conversation
          || update.message?.editedMessage?.message?.extendedTextMessage?.text;
        if (editedText && !state.sentMsgIds.has(key.id)) {
          const senderJid = jidNormalizedUser(key.fromMe ? sock.user?.id : (key.participant || key.remoteJid));
          await processIncomingMessage({ sock, chatJid: key.remoteJid, senderJid, text: editedText, quotedId: null, sendControlMsg, sendPoll, enqueuePoll, sendDM, editControlMsg, deleteControlMsg });
        }
      } catch (err) {
        console.error('[WA Update Error]', err);
        await sendControlMsg(`⚠️ Update Error: ${err.message}`).catch(() => {});
      }
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      if (state.settings.EMERGENCY_STOP !== 'TRUE') {
        await memberTracker.handleParticipantEvent({ groupJid: id, participants, action, sendControlMsg });
      }
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
    } catch (err) {
      console.error('[WA Group Update Error]', err);
    }
  });
}


function stopWhatsApp() {
  isConnected = false;
  try { sock?.ev?.removeAllListeners(); } catch {}
  try { sock?.end(new Error('shutdown')); } catch {}
}

module.exports = {
  startWhatsApp,
  stopWhatsApp,
  sendGroupText,
  sendControlMsg,
  editControlMsg,
  deleteControlMsg,
  sendDM,
  sendPoll,
  enqueuePoll,
  getStatus: () => ({ isConnected, latestQRDataUrl }),
};
