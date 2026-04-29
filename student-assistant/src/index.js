import { sendMessage, sendTyping, extractUpdate } from './telegram.js';
import { handleMessage } from './router.js';
import { processDueReminders, sendDailyBriefings } from './reminders.js';
import { processUploadedFile, extractSubjectFromCaption, extractPdfWithGemini, chunkMarkdownByTokens } from './file_processor.js';
import { ingestNote } from './knowledge.js';
import { seedDemoData } from '../scripts/seed_demo_data.js';

const DEFAULT_GEMINI_MODEL = 'models/gemini-flash-latest';

function normalizeGeminiModel(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_GEMINI_MODEL;
  if (raw.startsWith('models/')) return raw;
  return `models/${raw}`;
}

function toApiModelId(model) {
  return String(model || '').replace(/^models\//, '') || 'gemini-flash-latest';
}

async function fetchJsonWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { response, text, json };
  } finally {
    clearTimeout(timeout);
  }
}

async function retryGeminiCall(fn, attempts = 3, baseDelayMs = 350) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = baseDelayMs * (2 ** (attempt - 1));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function validateGeminiKey(env) {
  const model = normalizeGeminiModel(env.GEMINI_MODEL);
  const modelId = toApiModelId(model);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  const key = env.GEMINI_API_KEY;

  console.log(JSON.stringify({ event: 'gemini_validate', keyPresent: !!key, model, endpoint }));

  if (typeof key === 'undefined') {
    return new Response(JSON.stringify({
      ok: false,
      error: 'GEMINI_API_KEY is undefined in Worker environment'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!String(key).trim()) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'GEMINI_API_KEY is empty'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { response, text: rawBody } = await fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: 'Say hello in one sentence' }]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 64 }
    })
  }, Number(env.GEMINI_TIMEOUT_MS || 45000));

  console.log(JSON.stringify({ event: 'gemini_validate_result', status: response.status, ok: response.ok }));

  if (!response.ok) {
    console.log(JSON.stringify({ event: 'gemini_validate_error_body', body: rawBody.slice(0, 2000) }));
  }

  return new Response(rawBody, {
    status: response.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function debugPdfTest(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const pdfBase64 = body.pdfBase64;
    if (!pdfBase64) {
      return new Response(JSON.stringify({ ok: false, error: 'pdfBase64 is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(JSON.stringify({ event: 'debug_pdf_test_start', hasPdf: true, subject: body.subject || 'Debug' }));
    const bytes = base64ToArrayBuffer(pdfBase64);
    const pdfResult = await extractPdfWithGemini(env, bytes, 'application/pdf');
    if (!pdfResult.success) {
      console.log(JSON.stringify({ event: 'debug_pdf_test_extract_failed', error: pdfResult.error }));
      return new Response(JSON.stringify(pdfResult), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const chunks = chunkMarkdownByTokens(pdfResult.text, 500, 1000);
    const subject = body.subject || 'Debug';
    const noteId = `debug-${Date.now().toString(36)}`;
    const result = await ingestNote(env, pdfResult.text, subject, {
      noteId,
      chunks,
      sourceType: 'debug_pdf'
    });
    console.log(JSON.stringify({ event: 'debug_pdf_test_done', noteId: result.noteId, chunkCount: result.chunkCount }));
    return new Response(JSON.stringify({ ok: true, noteId: result.noteId, chunkCount: result.chunkCount, textLength: pdfResult.text.length }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'debug_pdf_test_error', error: error.message, stack: error.stack?.slice(0, 2000) }));
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function base64ToArrayBuffer(base64) {
  const sanitized = String(base64 || '').replace(/\s+/g, '');
  const binary = atob(sanitized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function debugVectorTest(env) {
  try {
    const query = 'student assistant notes';
    const result = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [query] });
    const embedding = result?.data?.[0];
    if (!embedding || embedding.length !== 1024) {
      return new Response(JSON.stringify({ ok: false, error: 'Embedding generation returned an invalid vector', embeddingLength: embedding?.length || 0 }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const matches = await env.VECTORIZE.query(embedding, { topK: 3, returnValues: true, returnMetadata: true });
    return new Response(JSON.stringify({ ok: true, embeddingLength: embedding.length, matches }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'debug_vector_test_error', error: error.message, stack: error.stack?.slice(0, 2000) }));
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleFileAttachment(update, env) {
  const { chatId, userId, fileId, fileUniqueId, mimeType, fileName, caption } = update;
  
  if (!fileId) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, "Couldn't process the file. Please try again.");
    return;
  }
  
  const subject = extractSubjectFromCaption(caption);

  if (mimeType === 'application/pdf' || fileName?.toLowerCase().endsWith('.pdf')) {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, '📄 Processing your PDF...');
  } else {
    await sendMessage(env.TELEGRAM_TOKEN, chatId, `📎 Processing your ${mimeType?.split('/')[1] || 'file'}...`);
  }

  const result = await processUploadedFile(
    env,
    env.TELEGRAM_TOKEN,
    chatId,
    userId,
    fileId,
    mimeType,
    subject,
    { fileName, fileUniqueId }
  );
  
  if (result.success) {
    await sendMessage(
      env.TELEGRAM_TOKEN,
      chatId,
      `✅ Notes extracted successfully\n\n📚 Subject: *${subject}*\n🔖 Note ID: \`${result.noteId}\`\n📏 Extracted: ${result.textLength} characters${result.chunkCount ? `\n🧩 Chunks indexed: *${result.chunkCount}*` : ''}\n\nYou can now ask me questions about this content!`
    );
  } else {
    let errorMsg = (result.error || '').toLowerCase().includes('too large')
      ? `⚠️ PDF too large or unsupported\n\n${result.error}`
      : `❌ ${result.error}`;
    if (result.suggestion) {
      errorMsg += `\n\n💡 *Suggestion:* ${result.suggestion}`;
    }
    await sendMessage(
      env.TELEGRAM_TOKEN,
      chatId,
      errorMsg
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/debug/gemini-validate') {
      return await validateGeminiKey(env);
    }
    if (url.pathname === '/debug/gemini-test') {
      return await validateGeminiKey(env);
    }
    if (url.pathname === '/debug/gemini-key') {
      const key = env.GEMINI_API_KEY;
      if (!key) {
        return new Response(JSON.stringify({ present: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const s = String(key);
      const masked = s.length > 8 ? `${s.slice(0,4)}...${s.slice(-4)}` : `${s}`;
      return new Response(JSON.stringify({ present: true, masked, length: s.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/debug/pdf-test' && request.method === 'POST') {
      return await debugPdfTest(request, env);
    }

    if (url.pathname === '/debug/vector-test') {
      return await debugVectorTest(env);
    }

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

    if (url.pathname === '/admin/seed-demo') {
      const secret = url.searchParams.get('secret');
      if (secret !== env.TELEGRAM_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      try {
        const result = await seedDemoData(env);
        return new Response(JSON.stringify({ ok: true, summary: result }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        console.error(JSON.stringify({ event: 'seed_demo_failed', error: err.message }));
        return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname === '/admin/test-demo-queries') {
      const secret = url.searchParams.get('secret');
      if (secret !== env.TELEGRAM_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }

      const chatId = parseInt(url.searchParams.get('chatId') || '1', 10);
      const queries = [
        'Summarize OS notes',
        'Explain CPU scheduling',
        'What are my upcoming exams?',
        'When is my OS exam?',
        'Summarize AML in short',
        'What is my CGPA?',
        'Which semester am I in?'
      ];

      try {
        // Make sure the test chatId is authorized to avoid auth failures.
        const existing = await env.NOTES_KV.get('config:allowed_users');
        const current = existing ? JSON.parse(existing) : [];
        if (!current.includes(chatId)) {
          current.push(chatId);
          await env.NOTES_KV.put('config:allowed_users', JSON.stringify(current));
        }

        const results = {};
        for (const q of queries) {
          const answer = await handleMessage({ text: q, chatId, username: 'demo' }, env);
          results[q] = answer;
        }

        return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        console.error(JSON.stringify({ event: 'test_demo_queries_failed', error: err.message }));
        return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
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