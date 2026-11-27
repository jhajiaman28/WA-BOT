const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MASTER_SHEET_ID, TABS, DEFAULT_SETTINGS, LOCAL_MIRROR_PATH, CREDENTIALS_PATH } = require('./config');

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function loadServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim().startsWith('{')
      ? process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      : Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8');
    return JSON.parse(raw);
  }
  if (fs.existsSync(CREDENTIALS_PATH)) {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  }
  return null;
}

class SheetsClient {
  constructor() {
    this.mode = 'local-mirror';
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.serviceAccount = loadServiceAccount();
    this.cache = this.loadLocalMirror();
  }

  loadLocalMirror() {
    const dir = path.dirname(LOCAL_MIRROR_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(LOCAL_MIRROR_PATH)) {
      return JSON.parse(fs.readFileSync(LOCAL_MIRROR_PATH, 'utf8'));
    }

    const initial = {
      Post_Pipeline: [['Post_ID', 'Mode', 'Topic', 'Source_Post', 'AddOn_Prompt', 'Stage', 'Revision_Count', 'Scheduled_Date', 'Day_X', 'Morning_Context', 'Question', 'Options_JSON', 'Correct_Option', 'Evening_Answer', 'Morning_Poster_Ref', 'Evening_Poster_Ref', 'Auto_Pick', 'Last_Updated']],
      Quiz_Vote_Ledger: [['Poll_ID', 'Day_X', 'Group_JID', 'Phone', 'Selected_Option', 'Is_Correct', 'Voted_At_IST']],
      Participant_Names: [['Phone', 'WhatsApp_Name', 'Clean_PDF_Name']],
      Post_Selection_Log: [['Date', 'Sender_Name', 'Post_Hash', 'Post_ID', 'Status']],
      Review_Activity_Log: [['Post_ID', 'Group_Name', 'Reviewer', 'Action', 'Timestamp_IST']],
      Quiz_Archive: [['Day_X', 'Date', 'Post_ID', 'Mode', 'Final_Theme', 'Unique_Voters', 'Correct_Pct', 'AI_Root_Cause']],
      Admin_Permissions: [['Phone_Number', 'Name', 'Role', 'Allowed_Channels', 'Allowed_Commands']],
      Settings: [
        ['Key', 'Value', 'Description'],
        ...Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, v, 'Default setting']),
      ],
    };

    fs.writeFileSync(LOCAL_MIRROR_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }

  saveLocalMirror() {
    fs.writeFileSync(LOCAL_MIRROR_PATH, JSON.stringify(this.cache, null, 2));
  }

  async getAccessToken() {
    if (!this.serviceAccount) return null;
    const now = Math.floor(Date.now() / 1000);
    if (this.accessToken && now < this.tokenExpiresAt - 60) {
      return this.accessToken;
    }

    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claimSet = base64UrlEncode(JSON.stringify({
      iss: this.serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }));

    const signingInput = `${header}.${claimSet}`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(signingInput)
      .sign(this.serviceAccount.private_key, 'base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const assertion = `${signingInput}.${signature}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!res.ok) {
      throw new Error(`Google OAuth error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + (data.expires_in || 3600);
    return this.accessToken;
  }

  async syncFromSheet() {
    if (!this.serviceAccount) {
      this.mode = 'local-mirror';
      this.cache = this.loadLocalMirror();
      return { mode: this.mode, tabsLoaded: TABS.length };
    }

    const token = await this.getAccessToken();
    const ranges = TABS.map((t) => `ranges=${encodeURIComponent(t)}`).join('&');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${MASTER_SHEET_ID}/values:batchGet?${ranges}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Sheets batchGet failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    (data.valueRanges || []).forEach((vr, idx) => {
      const tabName = TABS[idx];
      this.cache[tabName] = vr.values || [];
    });
    this.mode = 'live-google-sheets';
    this.saveLocalMirror();
    return { mode: this.mode, tabsLoaded: TABS.length };
  }

  async pushTabToSheet(tabName) {
    this.saveLocalMirror();
    if (!this.serviceAccount) return;

    const token = await this.getAccessToken();
    const values = this.cache[tabName] || [];
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${MASTER_SHEET_ID}/values/${encodeURIComponent(tabName)}?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ range: tabName, values }),
    });

    if (!res.ok) {
      throw new Error(`Sheets PUT ${tabName} failed: ${res.status} ${await res.text()}`);
    }
  }

  getTabRows(tabName) {
    const rows = this.cache[tabName] || [];
    if (rows.length <= 1) return [];
    const headers = rows[0];
    return rows.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] !== undefined ? row[i] : '';
      });
      return obj;
    });
  }

  async appendRowObj(tabName, rowObj) {
    const rows = this.cache[tabName] || [];
    const headers = rows[0] || [];
    const rowArr = headers.map((h) => (rowObj[h] !== undefined ? String(rowObj[h]) : ''));
    rows.push(rowArr);
    this.cache[tabName] = rows;
    await this.pushTabToSheet(tabName);
    return rowObj;
  }

  async upsertRowObj(tabName, keyCol, keyVal, updates) {
    const rows = this.cache[tabName] || [];
    const headers = rows[0] || [];
    const keyIdx = headers.indexOf(keyCol);
    if (keyIdx === -1) throw new Error(`Column ${keyCol} not found in ${tabName}`);

    const rowIndex = rows.findIndex((r, idx) => idx > 0 && r[keyIdx] === String(keyVal));
    if (rowIndex === -1) {
      return this.appendRowObj(tabName, { [keyCol]: keyVal, ...updates });
    }

    const existing = {};
    headers.forEach((h, i) => {
      existing[h] = rows[rowIndex][i] !== undefined ? rows[rowIndex][i] : '';
    });
    const merged = { ...existing, ...updates };
    rows[rowIndex] = headers.map((h) => (merged[h] !== undefined ? String(merged[h]) : ''));
    this.cache[tabName] = rows;
    await this.pushTabToSheet(tabName);
    return merged;
  }

  getSettingsMap() {
    const rows = this.getTabRows('Settings');
    const map = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.Key) {
        map[row.Key.trim()] = (row.Value || '').trim() || map[row.Key.trim()] || '';
      }
    }
    return map;
  }

  async setSetting(key, value) {
    await this.upsertRowObj('Settings', 'Key', key, { Value: value });
  }
}

module.exports = { SheetsClient };
