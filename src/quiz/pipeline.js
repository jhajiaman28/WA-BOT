const crypto = require('crypto');
const { getTodayISTStr, getISTTimestamp, calculateDayX, shiftDateDDMMYY } = require('./dayx');

const STAGE_ORDER = [
  'Awaiting_5_Questions',
  'Q_Name_Review',
  'Q_Final_Review',
  'Awaiting_Full_Package',
  'Pkg_Name_Review',
  'Pkg_Final_Review',
  'Scheduled',
  'Dispatched',
];

function hashPost(text) {
  const normalized = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function nextPostId(sheets) {
  const rows = sheets.getTabRows('Post_Pipeline');
  let maxNum = 40;
  for (const r of rows) {
    const m = /^P-(\d+)$/i.exec(r.Post_ID || '');
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }
  return `P-${maxNum + 1}`;
}

function buildAiReminder(postId, stage, { addOnPrompt = '', revisionCount = 0 } = {}) {
  if (stage === 'Awaiting_5_Questions') {
    const addonNote = addOnPrompt ? `\n• Add-on Prompt: _${addOnPrompt}_` : '';
    return [
      `🤖 *AI Action Needed — 5 Questions (${postId})*`,
      `Please run \`/poll-preparation\` manually for \`${postId}\`.${addonNote}`,
      `Submit with: \`#submit_q ${postId} <5 questions text>\``,
    ].join('\n');
  }
  if (stage === 'Awaiting_Full_Package') {
    return [
      `🤖 *AI Action Needed — Full Package (${postId})*`,
      `Winning question approved! Please generate Context, Options, Answer & 2 Posters via \`/poll-preparation\`.`,
      `Submit with: \`#submit_pkg ${postId} <topic> | <context> | <question> | <A;;B;;C;;D> | <correct> | <answer> | <m_poster> | <e_poster>\``,
    ].join('\n');
  }
  if (revisionCount > 0) {
    const targetCmd = stage.startsWith('Q_') ? `#submit_q ${postId}` : `#submit_pkg ${postId}`;
    return [
      `🔄 *AI Revision Needed (${postId} — Rev #${revisionCount})*`,
      `Stage \`${stage}\` flagged for changes. Please re-run \`/poll-preparation\` and update via \`${targetCmd} ...\``,
    ].join('\n');
  }
  return null;
}

async function submitCandidatePost(sheets, { senderName, topic, sourcePost, addOnPrompt = '', mode = 'Mode 1' }) {
  const today = getTodayISTStr();
  const postHash = hashPost(sourcePost);
  const existingLogs = sheets.getTabRows('Post_Selection_Log');
  const dup = existingLogs.find((r) => r.Post_Hash === postHash);

  if (dup) {
    await sheets.appendRowObj('Post_Selection_Log', {
      Date: today,
      Sender_Name: senderName,
      Post_Hash: postHash,
      Post_ID: dup.Post_ID,
      Status: 'DUPLICATE_BLOCKED',
    });
    return { duplicate: true, existingPostId: dup.Post_ID };
  }

  const postId = nextPostId(sheets);
  await sheets.appendRowObj('Post_Selection_Log', {
    Date: today,
    Sender_Name: senderName,
    Post_Hash: postHash,
    Post_ID: postId,
    Status: 'SELECTED',
  });

  await sheets.appendRowObj('Post_Pipeline', {
    Post_ID: postId,
    Mode: mode,
    Topic: topic,
    Source_Post: sourcePost,
    AddOn_Prompt: addOnPrompt,
    Stage: 'Awaiting_5_Questions',
    Revision_Count: '0',
    Scheduled_Date: '',
    Day_X: '',
    Morning_Context: '',
    Question: '',
    Options_JSON: '[]',
    Correct_Option: '',
    Evening_Answer: '',
    Morning_Poster_Ref: '',
    Evening_Poster_Ref: '',
    Auto_Pick: 'FALSE',
    Last_Updated: getISTTimestamp(),
  });

  return {
    duplicate: false,
    postId,
    pollControlReminder: buildAiReminder(postId, 'Awaiting_5_Questions', { addOnPrompt }),
  };
}

function getDailyContributions(sheets, dateStr = getTodayISTStr()) {
  const logs = sheets.getTabRows('Post_Selection_Log').filter((r) => r.Date === dateStr);
  const counts = {};
  let duplicates = 0;
  for (const r of logs) {
    if (r.Status === 'DUPLICATE_BLOCKED') {
      duplicates += 1;
      continue;
    }
    counts[r.Sender_Name] = (counts[r.Sender_Name] || 0) + 1;
  }
  return { date: dateStr, counts, duplicates };
}

async function handleEmojiReaction(sheets, { postId, emoji, groupName, reviewer }) {
  const settings = sheets.getSettingsMap();
  const rows = sheets.getTabRows('Post_Pipeline');
  const post = rows.find((r) => r.Post_ID === postId);
  if (!post) return { error: `Post ${postId} not found.` };

  let nextStage = post.Stage;
  let revCount = Number(post.Revision_Count || 0);
  let autoPick = post.Auto_Pick || 'FALSE';
  let actionLabel = 'UNKNOWN';
  let pollControlReminder = null;

  if (emoji === settings.EMOJI_APPROVE) {
    const idx = STAGE_ORDER.indexOf(post.Stage);
    nextStage = idx >= 0 && idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : post.Stage;
    actionLabel = `APPROVED -> ${nextStage}`;
    if (nextStage === 'Awaiting_Full_Package') {
      pollControlReminder = buildAiReminder(postId, 'Awaiting_Full_Package');
    }
  } else if (emoji === settings.EMOJI_REVISION) {
    revCount += 1;
    actionLabel = `REVISION_NEEDED (#${revCount})`;
    pollControlReminder = buildAiReminder(postId, nextStage, { revisionCount: revCount });
  } else if (emoji === settings.EMOJI_HOLD) {
    actionLabel = 'HOLD';
  } else if (emoji === settings.EMOJI_SCHEDULE) {
    nextStage = 'Scheduled';
    actionLabel = 'SCHEDULED';
  } else if (emoji === settings.EMOJI_SPARE) {
    nextStage = 'Spare';
    actionLabel = 'PARKED_SPARE';
  } else if (emoji === settings.EMOJI_AUTOPICK) {
    autoPick = 'TRUE';
    actionLabel = 'TAGGED_AUTOPICK';
  } else {
    return { ignored: true, reason: `Unmapped emoji ${emoji}` };
  }

  await sheets.upsertRowObj('Post_Pipeline', 'Post_ID', postId, {
    Stage: nextStage,
    Revision_Count: String(revCount),
    Auto_Pick: autoPick,
    Last_Updated: getISTTimestamp(),
  });

  await sheets.appendRowObj('Review_Activity_Log', {
    Post_ID: postId,
    Group_Name: groupName,
    Reviewer: reviewer,
    Action: actionLabel,
    Timestamp_IST: getISTTimestamp(),
  });

  return { postId, stage: nextStage, revisionCount: revCount, autoPick, action: actionLabel, pollControlReminder };
}

async function schedulePost(sheets, postId, targetDate) {
  const settings = sheets.getSettingsMap();
  const dayX = calculateDayX(targetDate, settings.DAY_X_ANCHOR_DATE, settings.DAY_X_ANCHOR_NUM);
  return sheets.upsertRowObj('Post_Pipeline', 'Post_ID', postId, {
    Stage: 'Scheduled',
    Scheduled_Date: targetDate,
    Day_X: String(dayX),
    Last_Updated: getISTTimestamp(),
  });
}

async function shiftScheduledPosts(sheets, days) {
  const settings = sheets.getSettingsMap();
  const rows = sheets.getTabRows('Post_Pipeline').filter((r) => r.Stage === 'Scheduled' && r.Scheduled_Date);
  for (const r of rows) {
    const newDate = shiftDateDDMMYY(r.Scheduled_Date, days);
    const newDayX = calculateDayX(newDate, settings.DAY_X_ANCHOR_DATE, settings.DAY_X_ANCHOR_NUM);
    await sheets.upsertRowObj('Post_Pipeline', 'Post_ID', r.Post_ID, {
      Scheduled_Date: newDate,
      Day_X: String(newDayX),
      Last_Updated: getISTTimestamp(),
    });
  }
  return rows.length;
}

module.exports = {
  submitCandidatePost,
  getDailyContributions,
  handleEmojiReaction,
  schedulePost,
  shiftScheduledPosts,
  buildAiReminder,
};
