import { sendMessage, sendTyping, extractUpdate } from './telegram.js';
import { handleMessage } from './router.js';
import { processDueReminders, sendDailyBriefings } from './reminders.js';
import { processUploadedFile, extractSubjectFromCaption } from './file_processor.js';

async function handleFileAttachment(update, env) {
  const { chatId, userId, fileId, mimeType, caption } = update;
  
  if (!fileId) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Couldn't process the file. Please try again.");
    return;
  }
  
  const subject = extractSubjectFromCaption(caption);
  
  await sendMessage(env.TELEGRAM_TOKEN, chatId, `📎 Processing your ${mimeType?.split('/')[1] || 'file'}...`);
  
  const result = await processUploadedFile(env, env.TELEGRAM_TOKEN, chatId, userId, fileId, mimeType, subject);
  
  if (result.success) {
    await sendMessage(
      env.TELEGRAM_TOKEN,
      chatId,
      `✅ *Text extracted!*\n\n📚 Subject: *${subject}*\n🔖 Note ID: \`${result.noteId}\`\n📏 Extracted: ${result.textLength} characters\n\nYou can now ask me questions about this content!`
    );
  } else {
    await sendMessage(
      env.TELEGRAM_TOKEN,
      chatId,
      `❌ ${result.error}\n\nSupported formats: PDF, Images (JPG, PNG)`
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/admin/allow') {
      const secret = url.searchParams.get('secret');
      const chatIdParam = url.searchParams.get('chatId');
      if (secret !== env.TELEGRAM_TOKEN || !chatIdParam) {
        return new Response('Unauthorized', { status: 401 });
      }
      const chatId = parseInt(chatIdParam, 10);
      if (isNaN(chatId)) return new Response('Invalid chatId', { status: 400 });

      const existing = await env.NOTES_KV.get('config:allowed_users');
      const current = existing ? JSON.parse(existing) : [];
      if (!current.includes(chatId)) {
        current.push(chatId);
        await env.NOTES_KV.put('config:allowed_users', JSON.stringify(current));
      }
      return new Response(
        `✅ Allowed chatId ${chatId}. Total allowed users: ${current.length}`,
        { status: 200 }
      );
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', worker: 'student-assistant' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Student Assistant is running.', { status: 200 });
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      console.error(JSON.stringify({ event: 'invalid_json_body' }));
      return new Response('OK', { status: 200 });
    }

    const update = extractUpdate(body);

    if (!update || !update.chatId) {
      return new Response('OK', { status: 200 });
    }

    if (update.hasFile) {
      await sendTyping(env.TELEGRAM_TOKEN, update.chatId);
      const fileResult = await handleFileAttachment(update, env);
      return new Response('OK', { status: 200 });
    }

    if (!update.text) {
      await sendMessage(
        env.TELEGRAM_TOKEN,
        update.chatId,
        "I can only process text messages. Please send me text."
      );
      return new Response('OK', { status: 200 });
    }

    if (!(await isAuthorized(env, update.chatId))) {
      console.log(JSON.stringify({
        event: 'unauthorized_access',
        chatId: update.chatId,
        username: update.username
      }));
      return new Response('OK', { status: 200 });
    }

    try {
      await sendTyping(env.TELEGRAM_TOKEN, update.chatId);
      const response = await handleMessage(update, env);
      await sendMessage(env.TELEGRAM_TOKEN, update.chatId, response);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'message_handling_failed',
        chatId: update.chatId,
        error: err.message,
        stack: err.stack?.slice(0, 200)
      }));
      await sendMessage(
        env.TELEGRAM_TOKEN,
        update.chatId,
        "Something went wrong. Please try again in a moment."
      );
    }

    return new Response('OK', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    console.log(JSON.stringify({ event: 'cron_fired', cron: event.cron }));
    
    const token = env.TELEGRAM_TOKEN;
    if (!token) {
      console.error(JSON.stringify({ event: 'cron_no_token' }));
      return;
    }
    
    if (event.cron === '*/30 * * * *') {
      console.log(JSON.stringify({ event: 'checking_reminders' }));
      const processed = await processDueReminders(env, token);
      console.log(JSON.stringify({ event: 'reminders_processed', count: processed }));
    }
    
    if (event.cron === '0 7 * * *') {
      console.log(JSON.stringify({ event: 'daily_briefing_start' }));
      const sent = await sendDailyBriefings(env, token);
      console.log(JSON.stringify({ event: 'daily_briefing_complete', users_notified: sent }));
    }
  }
};

async function isAuthorized(env, chatId) {
  try {
    const raw = await env.NOTES_KV.get('config:allowed_users');
    if (!raw) return true;
    const allowed = JSON.parse(raw);
    return allowed.includes(chatId);
  } catch (_) {
    return true;
  }
}