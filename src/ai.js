const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GEMINI_API_KEY } = require('./config');
const { state, pushChatHistory, isFullAuthority } = require('./state');

let genAI = null;
let workingModel = null;

const CANDIDATE_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

async function generateWithFallback(prompt) {
  if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
  if (!genAI) genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  const models = workingModel
    ? [workingModel, ...CANDIDATE_MODELS.filter((m) => m !== workingModel)]
    : CANDIDATE_MODELS;

  let lastErr;
  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const res = await model.generateContent(prompt);
      workingModel = modelName;
      return res.response.text().trim();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function generateTauntOption(sessionName) {
  if (!GEMINI_API_KEY) return '😒Not Interested';
  try {
    const raw = await Promise.race([
      generateWithFallback(
      `Generate ONE short, witty, self-deprecating WhatsApp poll option (max 28 chars, starting with 1 emoji) for someone who skipped today's "${sessionName}" session.
Rules:
- Must be written in FIRST PERSON (the voter playfully describing themselves, e.g., "🤡Jhunnuram Mode", "🫏Aaj Gadahva bana", "😒Not Interested").
- May playfully use Acharya Prashant community terms like "Jhunnuram", "Gadahva", "Maya me phansa".
- NEVER be rude or disrespectful, and NEVER use "tum" (if addressing anyone, only use respectful "aap").
Return ONLY the option text.`
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout')), 4000)),
    ]);
    const text = raw.replace(/["\n]/g, '');
    return text.slice(0, 35) || '😒Not Interested';
  } catch {
    return '😒Not Interested';
  }
}

async function handleAIConversation({ chatJid, senderJid, text, sendControlMsg }) {
  if (!GEMINI_API_KEY) {
    return sendControlMsg('⚠️ Gemini API key is not configured. Use `#help` for shortcut commands.');
  }

  const fullAuth = isFullAuthority(senderJid);
  pushChatHistory(chatJid, 'user', text);
  const history = state.chatHistory.get(chatJid) || [];

  const systemContext = `You are a concise WhatsApp Automation Assistant.
Current Authority: ${fullAuth ? 'FULL_AUTHORITY' : 'LIMITED_OPERATOR'}.
Known Group Bindings: ${JSON.stringify(state.bindings.map((b) => ({ key: b.bindKey, name: b.groupName, jid: b.groupJid })))}.
Settings: ${JSON.stringify(state.settings)}.
Always maintain a respectful tone (never use "tum" if using Hindi/Hinglish—only use "aap"). Keep responses strictly in English unless quoting a specific Hindi/Hinglish term.`;

  try {
    const prompt = [
      systemContext,
      ...history.map((h) => `${h.role === 'user' ? 'User' : 'Bot'}: ${h.text}`),
    ].join('\n');

    const reply = await generateWithFallback(prompt);
    pushChatHistory(chatJid, 'assistant', reply);
    return reply;
  } catch (err) {
    await sendControlMsg(`⚠️ Gemini API Error/Fallback: ${err.message}. Shortcut commands (#help) remain active.`);
    return null;
  }
}


async function adaptRepeatReminder(baseMessage, reminderNumber) {
  if (!GEMINI_API_KEY || reminderNumber <= 1) return baseMessage;
  try {
    const raw = await Promise.race([
      generateWithFallback(
        `Slightly edit this WhatsApp reminder message to politely mention that this is reminder #${reminderNumber} (they were reminded earlier too).
Rules:
- Match the EXACT language, tone, and respectful "aap" style of the original message (never use "tum").
- Keep the original message intact and only add/weave in one brief, polite reminder line.
- Return ONLY the final message text.

Original message:
${baseMessage}`
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout')), 5000)),
    ]);
    return raw || baseMessage;
  } catch {
    return `${baseMessage}\n\n(Aapko pehle bhi remind karaya gaya tha, kripya apna vote zaroor dein.)`;
  }
}

module.exports = { generateTauntOption, handleAIConversation, adaptRepeatReminder };
