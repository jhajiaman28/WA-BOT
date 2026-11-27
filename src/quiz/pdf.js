const fs = require('fs');
const path = require('path');

function escapePdfText(str) {
  return String(str || '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function generateWeeklyPdf(outputPath, { title, subtitle, rows, toughestLine }) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = [
    { text: title, size: 16, y: 760 },
    { text: subtitle, size: 10, y: 740 },
    { text: 'Rank | Name                      | Phone      | Points', size: 10, y: 715 },
    { text: '----------------------------------------------------------', size: 10, y: 702 },
  ];

  let y = 686;
  for (const r of rows) {
    if (y < 70) break;
    const rankStr = String(r.rank).padEnd(4, ' ');
    const nameStr = String(r.name).slice(0, 25).padEnd(25, ' ');
    const phoneStr = String(r.phone).slice(0, 10).padEnd(10, ' ');
    const ptsStr = String(r.points);
    lines.push({ text: `${rankStr} | ${nameStr} | ${phoneStr} | ${ptsStr}`, size: 10, y });
    y -= 16;
  }

  if (toughestLine && y > 50) {
    lines.push({ text: `Week's Toughest Question: ${toughestLine}`, size: 10, y: y - 14 });
  }

  const streamBody = lines
    .map((l) => `BT /F1 ${l.size} Tf 50 ${l.y} Td (${escapePdfText(l.text)}) Tj ET`)
    .join('\n');

  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(streamBody, 'utf8')} >> stream\n${streamBody}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj + '\n';
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  fs.writeFileSync(outputPath, pdf, 'utf8');
  return outputPath;
}

module.exports = { generateWeeklyPdf };
