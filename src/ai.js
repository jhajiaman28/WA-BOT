const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GEMINI_API_KEY } = require('./config');
const { state, pushChatHistory, isFullAuthority } = require('./state');

let genAI = null;

const CANDIDATE_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash',
];

async function generateWithFallback(prompt) {
  if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
  if (!genAI) genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

  let lastErr;
  for (const modelName of CANDIDATE_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const res = await model.generateContent(prompt);
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
    const raw = await generateWithFallback(
      `Generate ONE short, witty, light-hearted Hindi/Hinglish or English WhatsApp poll option (max 28 chars, starting with 1 emoji) teasing someone for skipping today's "${sessionName}" session. Return ONLY the option text.`
    );
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
If the user asks to perform a supported action and has authority, respond with a JSON block inside \`\`\`json ... \`\`\` with {"action": "SYNC"|"PAUSE_POLLS"|"RESUME_POLLS"|"STATUS"|"NONE", "reply": "short confirmation"}.
If the user is just conversing or asking a question, reply concisely in plain text. Keep responses strictly in English.`;

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

module.exports = { generateTauntOption, handleAIConversation };
