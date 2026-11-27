const { getISTTimestamp } = require('./dayx');

function extractTenDigitPhone(jidOrPhone) {
  if (!jidOrPhone) return null;
  const raw = String(jidOrPhone).trim();
  if (raw.includes('@lid')) return null; // Strict BAN on @lid in outreach/ledger/PDF
  const digits = raw.split('@')[0].replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

async function recordVote(sheets, { pollId, dayX, groupJid, voterJidOrPhone, selectedOption, isCorrect }) {
  const phone = extractTenDigitPhone(voterJidOrPhone);
  if (!phone) {
    return { rejected: true, reason: 'Strict @lid ban: unresolved @lid or invalid phone rejected from ledger.' };
  }

  await sheets.appendRowObj('Quiz_Vote_Ledger', {
    Poll_ID: pollId,
    Day_X: String(dayX),
    Group_JID: groupJid,
    Phone: phone,
    Selected_Option: selectedOption,
    Is_Correct: isCorrect ? 'TRUE' : 'FALSE',
    Voted_At_IST: getISTTimestamp(),
  });

  return { recorded: true, phone };
}

function computeDeduplicatedDayStats(sheets, dayX) {
  const votes = sheets.getTabRows('Quiz_Vote_Ledger').filter((v) => String(v.Day_X) === String(dayX));
  const byPhone = new Map();

  for (const v of votes) {
    const phone = extractTenDigitPhone(v.Phone);
    if (!phone) continue;
    const prev = byPhone.get(phone);
    const isRight = String(v.Is_Correct).toUpperCase() === 'TRUE';
    if (!prev) {
      byPhone.set(phone, { phone, isCorrect: isRight });
    } else if (isRight) {
      prev.isCorrect = true;
    }
  }

  const uniqueVoters = byPhone.size;
  let correctCount = 0;
  for (const entry of byPhone.values()) {
    if (entry.isCorrect) correctCount += 1;
  }
  const correctPct = uniqueVoters > 0 ? Math.round((correctCount / uniqueVoters) * 100) : 0;

  return { dayX, uniqueVoters, correctCount, correctPct, byPhone };
}

function buildWeeklyRankings(sheets, dayXList) {
  const nameRows = sheets.getTabRows('Participant_Names');
  const nameMap = new Map();
  for (const n of nameRows) {
    const phone = extractTenDigitPhone(n.Phone);
    if (phone) {
      nameMap.set(phone, (n.Clean_PDF_Name || '').trim() || (n.WhatsApp_Name || '').trim() || phone);
    }
  }

  const totals = new Map();
  let toughest = null;

  for (const dayX of dayXList) {
    const dayStats = computeDeduplicatedDayStats(sheets, dayX);
    if (dayStats.uniqueVoters > 0) {
      if (!toughest || dayStats.correctPct < toughest.correctPct) {
        toughest = { dayX, correctPct: dayStats.correctPct, uniqueVoters: dayStats.uniqueVoters };
      }
    }
    for (const [phone, info] of dayStats.byPhone.entries()) {
      const pts = 1 + (info.isCorrect ? 3 : 0);
      totals.set(phone, (totals.get(phone) || 0) + pts);
    }
  }

  const ranked = Array.from(totals.entries())
    .map(([phone, points]) => ({
      phone,
      name: nameMap.get(phone) || `Member ${phone.slice(-4)}`,
      points,
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    .map((item, idx) => ({ rank: idx + 1, ...item }));

  return { ranked, toughest };
}

module.exports = {
  extractTenDigitPhone,
  recordVote,
  computeDeduplicatedDayStats,
  buildWeeklyRankings,
};
