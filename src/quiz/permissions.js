function normalizePhone(jidOrPhone) {
  if (!jidOrPhone) return '';
  return String(jidOrPhone).split('@')[0].replace(/\D/g, '');
}

class PermissionManager {
  constructor(sheetsClient) {
    this.sheets = sheetsClient;
    this.ownerPhone = normalizePhone(process.env.OWNER_PHONE || '919999999999');
  }

  isAllowed(senderJid, commandName, channel = 'POLL_CTRL') {
    const phone = normalizePhone(senderJid);
    if (phone && phone === this.ownerPhone) {
      return { allowed: true, role: 'OWNER' };
    }

    const admins = this.sheets.getTabRows('Admin_Permissions');
    const match = admins.find((a) => normalizePhone(a.Phone_Number) === phone);
    if (!match) {
      return { allowed: false, reason: 'Unauthorized: Aman-only by default.' };
    }

    const allowedChannels = (match.Allowed_Channels || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (allowedChannels.length > 0 && !allowedChannels.includes('ALL') && !allowedChannels.includes(channel)) {
      return { allowed: false, reason: `Channel ${channel} not permitted for ${match.Name || phone}.` };
    }

    if ((match.Role || '').toUpperCase() === 'FULL') {
      return { allowed: true, role: 'FULL' };
    }

    const allowedCmds = (match.Allowed_Commands || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (allowedCmds.includes(commandName.toLowerCase())) {
      return { allowed: true, role: 'LIMITED' };
    }

    return { allowed: false, reason: `Command ${commandName} not granted to ${match.Name || phone}.` };
  }
}

module.exports = { PermissionManager, normalizePhone };
