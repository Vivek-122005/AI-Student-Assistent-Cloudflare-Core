export async function sendMessage(token, chatId, text, options = {}) {
  const trimmed = text?.trim() || '(empty response)';
  const chunks = splitMessage(trimmed);

  let lastResponse = null;
  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          ...options
        })
      });
      lastResponse = await res.json();
    } catch (err) {
      console.error(JSON.stringify({
        event: 'telegram_send_failed',
        chatId,
        error: err.message
      }));
      return null;
    }
  }
  return lastResponse;
}

export async function sendTyping(token, chatId) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (_) {
    // Non-critical — never throw from typing indicator
  }
}

export function extractUpdate(body) {
  const message = body?.message || body?.edited_message;

  if (!message) {
    return null;
  }

  const hasFile = !!(message.document || message.photo || message.audio || message.video);
  const fileData = message.document || (message.photo && message.photo[message.photo.length - 1]) || message.audio || message.video;

  return {
    chatId: message.chat?.id,
    userId: message.from?.id,
    username: message.from?.username || 'unknown',
    text: message.text?.trim() || '',
    isCommand: message.text?.startsWith('/') || false,
    messageId: message.message_id,
    date: message.date,
    hasFile: hasFile,
    fileId: fileData?.file_id,
    fileUniqueId: fileData?.file_unique_id || null,
    mimeType: message.document?.mime_type || (message.photo ? 'image/jpeg' : null),
    fileName: message.document?.file_name || null,
    caption: message.caption?.trim() || ''
  };
}

function splitMessage(text, maxLen = 4096) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cutAt = remaining.lastIndexOf('\n', maxLen);
    if (cutAt < maxLen * 0.5) cutAt = maxLen;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}