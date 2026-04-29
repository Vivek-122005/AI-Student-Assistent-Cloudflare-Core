import { performOcr } from './image_ocr.js';
import { ingestNote, getRawNote } from './knowledge.js';
import { saveFileIngestionMetadata } from './db.js';

const DEFAULT_GEMINI_MODEL = 'models/gemini-flash-latest';
const DEFAULT_PDF_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_GEMINI_TIMEOUT_MS = 45000;

const GEMINI_PDF_PROMPT = `Extract all readable content from this PDF and convert it into clean structured markdown.

Requirements:

* Preserve headings and sections
* Convert bullet points properly
* Extract tables as readable text
* Remove unnecessary formatting noise
* Keep it concise but complete
* Output only markdown`;

export async function processUploadedFile(env, token, chatId, userId, fileId, mimeType, subject = 'General', options = {}) {
  try {
    console.log(JSON.stringify({ event: 'file_processing_started', userId, fileId, mimeType }));

    const { fileName = null, fileUniqueId = null } = options;
    
    const fileInfoUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
    const fileInfoRes = await fetch(fileInfoUrl);
    const fileInfo = await fileInfoRes.json();
    
    if (!fileInfo.ok) {
      throw new Error(`Failed to get file info: ${fileInfo.description}`);
    }
    
    const filePath = fileInfo.result.file_path;
    const detectedMimeType = detectMimeType(mimeType, fileName || filePath);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) {
      throw new Error(`Failed to download file (${fileRes.status})`);
    }
    const buffer = await fileRes.arrayBuffer();
    const fileHash = await sha256Hex(buffer);
    
    let extractedText = null;
    let chunks = null;
    let sourceType = 'upload';
    let noteId = null;

    if (detectedMimeType === 'application/pdf') {
      const rateLimitOk = await checkGeminiPdfRateLimit(env, userId);
      if (!rateLimitOk) {
        return {
          success: false,
          error: 'PDF processing limit reached for now.',
          suggestion: 'Please wait a few minutes before uploading another PDF.'
        };
      }

      const cached = await getPdfCacheHit(env, fileHash, fileId, fileUniqueId);
      if (cached?.noteId) {
        const cachedNote = await getRawNote(env, cached.noteId);
        return {
          success: true,
          noteId: cached.noteId,
          textLength: cachedNote?.text?.length || 0,
          cached: true
        };
      }

      const sizeCheck = validatePdfSize(buffer, env);
      if (!sizeCheck.ok) {
        return {
          success: false,
          error: sizeCheck.error,
          suggestion: 'Try a smaller PDF or split into parts.'
        };
      }

      const pdfResult = await extractPdfWithGemini(env, buffer, detectedMimeType);
      if (!pdfResult.success) {
        return {
          success: false,
          error: pdfResult.error,
          suggestion: pdfResult.suggestion || 'Processing failed. Try a smaller PDF or split into parts.'
        };
      }

      extractedText = pdfResult.text;
      chunks = chunkMarkdownByTokens(extractedText, 500, 1000);
      sourceType = 'pdf_gemini';
    } else if (detectedMimeType.startsWith('image/')) {
      extractedText = await performOcr(env, buffer);
      if (!extractedText) {
        return { success: false, error: 'Could not extract text from image' };
      }
      chunks = chunkMarkdownByTokens(extractedText, 400, 900);
      sourceType = 'image_ocr';
    } else {
      return {
        success: false,
        error: `Unsupported file type: ${detectedMimeType || 'unknown'}`,
        suggestion: 'Upload a PDF or image file.'
      };
    }
    
    noteId = `file-${Date.now().toString(36)}`;

    const ingestResult = await ingestNote(env, extractedText, subject, {
      noteId,
      chunks,
      sourceType,
      sourceFileId: fileId,
      sourceHash: fileHash,
      processor: detectedMimeType === 'application/pdf' ? 'gemini' : 'ocr'
    });

    if (detectedMimeType === 'application/pdf') {
      await setPdfCache(env, fileHash, fileId, fileUniqueId, ingestResult.noteId);
    }

    await saveFileIngestionMetadata(env, {
      noteId: ingestResult.noteId,
      userId: String(userId),
      chatId: String(chatId),
      telegramFileId: fileId,
      fileName,
      mimeType: detectedMimeType,
      fileHash,
      subject,
      sourceType,
      extractedChars: extractedText.length,
      chunkCount: ingestResult.chunkCount,
      status: 'success'
    });
    
    console.log(JSON.stringify({ 
      event: 'file_processed', 
      userId, 
      fileId, 
      mimeType: detectedMimeType,
      subject,
      noteId: ingestResult.noteId,
      textLength: extractedText.length 
    }));
    
    return {
      success: true,
      noteId: ingestResult.noteId,
      textLength: extractedText.length,
      chunkCount: ingestResult.chunkCount
    };
  } catch (error) {
    await saveFileIngestionMetadata(env, {
      noteId: `failed-${Date.now().toString(36)}`,
      userId: String(userId),
      chatId: String(chatId),
      telegramFileId: fileId,
      fileName: options?.fileName || null,
      mimeType,
      subject,
      sourceType: 'upload',
      status: 'failed',
      errorMessage: error.message
    });

    console.error(JSON.stringify({ 
      event: 'file_processing_error', 
      userId, 
      fileId, 
      error: error.message 
    }));

    if (isTimeoutError(error)) {
      return {
        success: false,
        error: 'Processing timed out while reading the file.',
        suggestion: 'Try a smaller PDF or split into parts.'
      };
    }

    return {
      success: false,
      error: error.message || 'Processing failed.',
      suggestion: 'Try a smaller PDF or split into parts.'
    };
  }
}

export function extractSubjectFromCaption(caption = '') {
  if (!caption) return 'General';
  
  const match = caption.match(/subject:(\S+)/i);
  if (match) {
    return match[1].replace(/-/g, ' ').trim();
  }
  
  if (caption.startsWith('/note') || caption.startsWith('/upload')) {
    return 'General';
  }
  
  if (caption.length > 3 && !caption.startsWith('/')) {
    return caption.trim().slice(0, 50);
  }
  
  return 'General';
}

function detectMimeType(originalMimeType, fileNameOrPath = '') {
  const mime = (originalMimeType || '').toLowerCase();
  if (mime) return mime;

  const lower = (fileNameOrPath || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';

  return 'application/octet-stream';
}

function validatePdfSize(buffer, env) {
  const maxBytes = Number(env.PDF_MAX_BYTES || DEFAULT_PDF_MAX_BYTES);
  if (buffer.byteLength > maxBytes) {
    const sizeMB = (buffer.byteLength / (1024 * 1024)).toFixed(1);
    const maxMB = (maxBytes / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error: `PDF too large (${sizeMB}MB). Maximum supported size is ${maxMB}MB.`
    };
  }
  return { ok: true };
}

export async function extractPdfWithGemini(env, arrayBuffer, mimeType = 'application/pdf') {
  if (!env.GEMINI_API_KEY) {
    return {
      success: false,
      error: 'Gemini API key is not configured on the worker.',
      suggestion: 'Set GEMINI_API_KEY via wrangler secret.'
    };
  }

  const model = normalizeGeminiModel(env.GEMINI_MODEL);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${toApiModelId(model)}:generateContent`;
  const base64Data = arrayBufferToBase64(arrayBuffer);

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: GEMINI_PDF_PROMPT },
        {
          inlineData: {
            mimeType,
            data: base64Data
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192
    }
  };

  try {
    const { response } = await retryGeminiCall(async () => {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY
          },
          body: JSON.stringify(body)
        },
        Number(env.GEMINI_TIMEOUT_MS || DEFAULT_GEMINI_TIMEOUT_MS)
      );

      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Gemini transient error (${response.status})`);
      }

      return { response };
    }, 3, 350);

    return await handleGeminiResponse(response);
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        success: false,
        error: 'Gemini request timed out.',
        suggestion: 'Try a smaller PDF or split into parts.'
      };
    }

    return { success: false, error: `Gemini request failed: ${err.message}`, suggestion: 'Please try again.' };
  }
}

async function handleGeminiResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {}

  if (!response.ok) {
    const geminiError = payload?.error?.message || `Gemini API error (${response.status})`;
    return { success: false, error: geminiError, suggestion: 'Processing failed. Try a smaller PDF or split into parts.' };
  }

  const rawText = payload?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('\n').trim();
  const cleaned = sanitizeGeminiMarkdown(rawText);
  if (!isValidExtractedText(cleaned)) {
    return { success: false, error: 'No readable content could be extracted from the PDF.', suggestion: 'Try a text-based PDF (not scanned) or split into parts.' };
  }

  return { success: true, text: cleaned };
}

function normalizeGeminiModel(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_GEMINI_MODEL;
  if (raw.startsWith('models/')) return raw;
  return `models/${raw}`;
}

function toApiModelId(model) {
  return String(model || '').replace(/^models\//, '') || 'gemini-flash-latest';
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

function sanitizeGeminiMarkdown(text) {
  if (!text) return '';

  let out = text.trim();
  out = out.replace(/^```(?:markdown|md)?\s*/i, '');
  out = out.replace(/\s*```$/, '');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

function isValidExtractedText(text) {
  if (!text) return false;
  if (text.length < 80) return false;

  const letters = text.replace(/[^a-zA-Z]/g, '').length;
  return letters >= 40;
}

export function chunkMarkdownByTokens(markdown, minTokens = 500, maxTokens = 1000) {
  const clean = (markdown || '').trim();
  if (!clean) return [];

  const paragraphs = clean
    .split(/\n\s*\n/g)
    .map(p => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    const candidateTokens = estimateTokens(candidate);

    if (candidateTokens <= maxTokens) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current.trim());
      current = '';
    }

    const splitParagraph = splitLongParagraph(paragraph, maxTokens);
    for (const piece of splitParagraph) {
      if (!current) {
        current = piece;
        continue;
      }

      const merged = `${current}\n\n${piece}`;
      if (estimateTokens(merged) <= maxTokens) {
        current = merged;
      } else {
        chunks.push(current.trim());
        current = piece;
      }
    }
  }

  if (current) {
    chunks.push(current.trim());
  }

  if (chunks.length > 1 && estimateTokens(chunks[chunks.length - 1]) < minTokens) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n${tail}`.trim();
  }

  return chunks;
}

function splitLongParagraph(paragraph, maxTokens) {
  if (estimateTokens(paragraph) <= maxTokens) {
    return [paragraph];
  }

  const lines = paragraph.split('\n');
  const pieces = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (estimateTokens(candidate) <= maxTokens) {
      current = candidate;
      continue;
    }

    if (current) {
      pieces.push(current.trim());
    }

    if (estimateTokens(line) > maxTokens) {
      const words = line.split(/\s+/).filter(Boolean);
      let wordBuf = '';
      for (const word of words) {
        const test = wordBuf ? `${wordBuf} ${word}` : word;
        if (estimateTokens(test) <= maxTokens) {
          wordBuf = test;
        } else {
          if (wordBuf) pieces.push(wordBuf.trim());
          wordBuf = word;
        }
      }
      if (wordBuf) {
        current = wordBuf;
      } else {
        current = '';
      }
    } else {
      current = line;
    }
  }

  if (current) {
    pieces.push(current.trim());
  }

  return pieces;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function checkGeminiPdfRateLimit(env, userId) {
  const windowSeconds = Number(env.GEMINI_RATE_LIMIT_WINDOW_SEC || 600);
  const maxRequests = Number(env.GEMINI_RATE_LIMIT_MAX || 6);
  const key = `ratelimit:gemini:${userId}`;

  const now = Date.now();
  let data = { count: 0, ts: now };

  try {
    const raw = await env.NOTES_KV.get(key);
    if (raw) {
      data = JSON.parse(raw);
    }
  } catch (_) {}

  if ((now - data.ts) / 1000 > windowSeconds) {
    data = { count: 0, ts: now };
  }

  data.count += 1;
  await env.NOTES_KV.put(key, JSON.stringify(data), { expirationTtl: windowSeconds * 2 });

  return data.count <= maxRequests;
}

async function getPdfCacheHit(env, fileHash, fileId, fileUniqueId) {
  const keys = [
    fileHash ? `pdfcache:hash:${fileHash}` : null,
    fileId ? `pdfcache:fileid:${fileId}` : null,
    fileUniqueId ? `pdfcache:uniq:${fileUniqueId}` : null
  ].filter(Boolean);

  for (const key of keys) {
    const raw = await env.NOTES_KV.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.noteId) {
        return parsed;
      }
    } catch (_) {}
  }

  return null;
}

async function setPdfCache(env, fileHash, fileId, fileUniqueId, noteId) {
  const payload = JSON.stringify({ noteId, cachedAt: new Date().toISOString() });
  const ttl = Number(env.PDF_CACHE_TTL_SEC || 60 * 60 * 24 * 7);

  const keys = [
    fileHash ? `pdfcache:hash:${fileHash}` : null,
    fileId ? `pdfcache:fileid:${fileId}` : null,
    fileUniqueId ? `pdfcache:uniq:${fileUniqueId}` : null
  ].filter(Boolean);

  await Promise.all(keys.map(key => env.NOTES_KV.put(key, payload, { expirationTtl: ttl })));
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isTimeoutError(err) {
  if (!err) return false;
  return err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('timeout');
}