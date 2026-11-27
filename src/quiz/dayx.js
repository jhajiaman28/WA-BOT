function parseDDMMYY(str) {
  const [dd, mm, yy] = str.split('/').map(Number);
  return new Date(Date.UTC(2000 + yy, mm - 1, dd));
}

function formatDDMMYY(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function getTodayISTStr() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return formatDDMMYY(now);
}

function calculateDayX(targetDDMMYY, anchorDateStr = '11/11/26', anchorDayNum = 33) {
  const target = parseDDMMYY(targetDDMMYY);
  const anchor = parseDDMMYY(anchorDateStr);
  const diffDays = Math.round((target.getTime() - anchor.getTime()) / (24 * 3600 * 1000));
  return Number(anchorDayNum) + diffDays;
}

function shiftDateDDMMYY(dateStr, days) {
  const d = parseDDMMYY(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDDMMYY(d);
}

function getISTTimestamp() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return now.toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}

module.exports = {
  parseDDMMYY,
  formatDDMMYY,
  getTodayISTStr,
  calculateDayX,
  shiftDateDDMMYY,
  getISTTimestamp,
};
