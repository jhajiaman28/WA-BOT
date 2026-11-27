const BANNED_WORDS = ['ego', 'अहंकार', 'विद्या', 'अविद्या'];

function stripPostId(text) {
  return (text || '')
    .replace(/\[?P-\d+\]?\s*[-|:]?\s*/gi, '')
    .trim();
}

function lintPostPackage(post) {
  const errors = [];
  const combined = [post.Morning_Context, post.Question, post.Evening_Answer].join('\n');

  for (const word of BANNED_WORDS) {
    if (combined.toLowerCase().includes(word.toLowerCase())) {
      errors.push(`Banned term found: "${word}"`);
    }
  }

  if (/[अ-ह]+.*\([A-Za-z\s]+\)/.test(combined)) {
    errors.push('Possible dual-bracket translation detected.');
  }

  if (/—[*_]|[*_]—/.test(combined)) {
    errors.push('Missing space between em-dash and WhatsApp markdown marker (* or _).');
  }

  let options = [];
  try {
    options = JSON.parse(post.Options_JSON || '[]');
  } catch {
    errors.push('Options_JSON is not valid JSON.');
  }

  if (!Array.isArray(options) || options.length !== 4) {
    errors.push('Must contain exactly 4 standalone options.');
  } else {
    const metaRegex = /(both\s+[a-d]\s+and\s+[a-d]|all of the above|none of the above|दोनों सही)/i;
    for (const opt of options) {
      if (metaRegex.test(opt)) {
        errors.push(`Meta-option not allowed: "${opt}"`);
      }
    }
  }

  if (!post.Morning_Poster_Ref || !post.Evening_Poster_Ref) {
    errors.push('Missing Morning or Evening Poster reference.');
  }

  return { valid: errors.length === 0, errors };
}

function renderPreview(post) {
  let options = [];
  try {
    options = JSON.parse(post.Options_JSON || '[]');
  } catch {
    options = [];
  }

  const morningBlock = [
    `*QUIZ — Day ${post.Day_X || '?'} | ${post.Scheduled_Date || 'TBD'}*`,
    '───────────────────',
    stripPostId(post.Morning_Context),
    '',
    `❓ *Question:* ${stripPostId(post.Question)}`,
    ...options.map((o, i) => `${i + 1}. ${o}`),
    `🖼 Morning Poster: ${post.Morning_Poster_Ref || 'MISSING'}`,
  ].join('\n');

  const eveningBlock = [
    `*[Answer - QUIZ - Day ${post.Day_X || '?'} | ${post.Scheduled_Date || 'TBD'}]*`,
    `✅ *Correct:* ${post.Correct_Option || '?'}`,
    stripPostId(post.Evening_Answer),
    `🖼 Evening Poster: ${post.Evening_Poster_Ref || 'MISSING'}`,
  ].join('\n');

  return `${morningBlock}\n\n---\n\n${eveningBlock}`;
}

module.exports = { stripPostId, lintPostPackage, renderPreview };
