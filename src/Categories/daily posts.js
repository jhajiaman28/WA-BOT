const { getISTNow, formatISTDate } = require('../config');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STUDY_MEMBERS = [
  'Rohan', 'Swapnil', 'Anurag', 'Pooja', 'Saksham',
  'Himanshu', 'Raghuvansh', 'Amit', 'Aman', 'Anisha',
  'Sahiba', 'Dipesh', 'Muskan', 'Sarita', 'Anshu',
];

function parseTargetDate(ddmmyy, defaultOffsetDays = 0) {
  if (ddmmyy && /^\d{2}\/\d{2}\/\d{2}$/.test(ddmmyy)) {
    const [d, m, y] = ddmmyy.split('/').map(Number);
    return new Date(2000 + y, m - 1, d);
  }
  const d = getISTNow();
  d.setDate(d.getDate() + defaultOffsetDays);
  return d;
}

function buildStudyTrackerText(targetDDMMYY) {
  const d = parseTargetDate(targetDDMMYY, -1);
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = MONTHS[d.getMonth()];
  const yyyy = d.getFullYear();
  const list = STUDY_MEMBERS.map((name, i) => `${i + 1}. ${name} -`).join('\n');
  return `*${dd} ${mon} ${yyyy} ➖ Study Tracker 📚*\n\n${list}`;
}

function buildVidyaPollPayload(targetDDMMYY) {
  const d = parseTargetDate(targetDDMMYY, 0);
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = MONTHS[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  return {
    question: `🌱 Number of Vidya-Avidya Posts Shared | ${dd} ${mon} ’${yy}.`,
    options: ['0', '1', '2', '3', '3+'],
    selectableCount: 1,
  };
}

module.exports = {
  buildStudyTrackerText,
  buildVidyaPollPayload,
  formatISTDate,
};
