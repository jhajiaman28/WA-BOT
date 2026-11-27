const readline = require('readline');
const { SheetsClient } = require('./sheets');
const { PermissionManager } = require('./permissions');
const { handlePollControlMessage } = require('./commands');
const { submitCandidatePost, handleEmojiReaction } = require('./pipeline');
const { recordVote, computeDeduplicatedDayStats } = require('./dispatch');

async function runTests() {
  const sheets = new SheetsClient();
  await sheets.syncFromSheet();
  const permissions = new PermissionManager(sheets);
  const settings = sheets.getSettingsMap();
  const owner = '919999999999@s.whatsapp.net';

  console.log('=== 1. Post Selection + AI Handoff Reminder ===');
  const p1 = await submitCandidatePost(sheets, {
    senderName: 'Rohan',
    topic: 'Sleep & Habits',
    sourcePost: 'Why do people scroll late at night even when tired?',
    addOnPrompt: 'Focus on comfort-seeking habit.',
  });
  console.log('Poll Control Reminder:\n' + p1.pollControlReminder);

  console.log('\n=== 2. Manual #submit_q + Emoji Review Loop ===');
  console.log((await handlePollControlMessage({ remoteJid: settings.POLL_CONTROL_JID, senderJid: owner, text: `#submit_q ${p1.postId} 1) Q1 2) Q2 3) Q3 4) Q4 5) Q5`, sheets, permissions })).reply);
  await handleEmojiReaction(sheets, { postId: p1.postId, emoji: '✅', groupName: 'Name Group', reviewer: 'Aarav' });
  const qFinal = await handleEmojiReaction(sheets, { postId: p1.postId, emoji: '✅', groupName: 'Question Review', reviewer: 'Aman' });
  console.log('Next AI Reminder:\n' + qFinal.pollControlReminder);

  console.log('\n=== 3. Manual #submit_pkg + #save_quiz + #calendar ===');
  await handlePollControlMessage({
    remoteJid: settings.POLL_CONTROL_JID,
    senderJid: owner,
    text: `#submit_pkg ${p1.postId} Sleep & Habits | Late-night scrolling feels relaxing — _even when tired_. | What drives this habit? | Option A;;Option B;;Option C;;Option D | Option B | Comfort-seeking overrides long-term rest. | poster_m_41.jpg | poster_e_41.jpg`,
    sheets,
    permissions,
  });
  console.log((await handlePollControlMessage({ remoteJid: settings.POLL_CONTROL_JID, senderJid: owner, text: `#save_quiz ${p1.postId} 28/11/26`, sheets, permissions })).reply);

  console.log('\n=== 4. Universal #kill / #wake / #cancel ===');
  console.log((await handlePollControlMessage({ remoteJid: settings.POLL_CONTROL_JID, senderJid: owner, text: '#kill', sheets, permissions })).reply);
  console.log((await handlePollControlMessage({ remoteJid: settings.POLL_CONTROL_JID, senderJid: owner, text: '#calendar', sheets, permissions })).reply);
  console.log((await handlePollControlMessage({ remoteJid: settings.POLL_CONTROL_JID, senderJid: owner, text: '#wake', sheets, permissions })).reply);
  console.log((await handlePollControlMessage({ remoteJid: settings.POLL_CONTROL_JID, senderJid: owner, text: '#cancel', sheets, permissions })).reply);

  console.log('\n=== 5. Vote Ledger (@lid ban) + #pdf ===');
  await recordVote(sheets, { pollId: 'POLL1', dayX: 50, groupJid: 'AUD1@g.us', voterJidOrPhone: '123456@lid', selectedOption: 'B', isCorrect: true });
  await recordVote(sheets, { pollId: 'POLL1', dayX: 50, groupJid: 'AUD1@g.us', voterJidOrPhone: '919876543210@s.whatsapp.net', selectedOption: 'B', isCorrect: true });
  console.log(computeDeduplicatedDayStats(sheets, 50));
  console.log((await handlePollControlMessage({ remoteJid: settings.POLL_CONTROL_JID, senderJid: owner, text: '#pdf 50', sheets, permissions })).reply);
}

async function runInteractive() {
  const sheets = new SheetsClient();
  await sheets.syncFromSheet();
  const permissions = new PermissionManager(sheets);
  const settings = sheets.getSettingsMap();

  console.log('=== Quiz Pipeline Bot — Dry-Run Simulator ===');
  console.log(`Poll Control JID: ${settings.POLL_CONTROL_JID} | Mode: ${sheets.mode}`);
  console.log('Type #help, #status, #kill, #wake, #cancel, or "exit".\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'POLL-CTRL> ' });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (input === 'exit' || input === 'quit') {
      rl.close();
      return;
    }
    const res = await handlePollControlMessage({
      remoteJid: settings.POLL_CONTROL_JID,
      senderJid: `${permissions.ownerPhone}@s.whatsapp.net`,
      text: input,
      sheets,
      permissions,
    });
    if (res.reply) console.log(`\n${res.reply}\n`);
    rl.prompt();
  });
}

if (process.argv.includes('--test')) {
  runTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runInteractive().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
