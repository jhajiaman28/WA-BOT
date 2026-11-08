const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GEMINI_API_KEY } = require('./config');
const { state, pushChatHistory, isFullAuthority } = require('./state');

let genAI = null;

function getModel() {
  if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
  if (!genAI) genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
}

async function generateTauntOption(sessionName) {
  if (!GEMINI_API_KEY) return '😒Not Interested';
  try {
    const model = getModel();
    const res = await model.generateContent(
      `Generate ONE short, witty, light-hearted Hindi/Hinglish or English WhatsApp poll option (max 28 chars, starting with 1 emoji) teasing someone for skipping today's "${sessionName}" session. Return ONLY the option text.`
    );
    const text = res.response.text().trim().replace(/["\n]/g, '');
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
    const model = getModel();
    const prompt = [
      systemContext,
      ...history.map((h) => `${h.role === 'user' ? 'User' : 'Bot'}: ${h.text}`),
    ].join('\n');

    const result = await model.generateContent(prompt);
    const reply = result.response.text().trim();
    pushChatHistory(chatJid, 'assistant', reply);
    return reply;
  } catch (err) {
    await sendControlMsg(`⚠️ Gemini API Error/Fallback: ${err.message}. Shortcut commands (#help) remain active.`);
    return null;
  }
}

module.exports = { generateTauntOption, handleAIConversation };
