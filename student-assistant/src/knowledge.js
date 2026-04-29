import { chunkText } from './chunker.js';
import { extractAndSaveWikiNode } from './wiki.js';

function generateNoteId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

export async function storeRawNote(env, noteId, text, metadata = {}) {
  const noteData = {
    text,
    metadata: {
      ...metadata,
      noteId,
      createdAt: new Date().toISOString(),
      length: text.length
    }
  };
  await env.NOTES_KV.put(`note:${noteId}`, JSON.stringify(noteData));
  await env.NOTES_KV.put(`noteidx:${noteId}`, JSON.stringify({
    noteId,
    subject: metadata.subject || 'General',
    preview: text.slice(0, 120),
    createdAt: new Date().toISOString(),
    length: text.length
  }));
}

export async function storeNoteChunks(env, noteId, chunks, metadata = {}) {
  await env.NOTES_KV.put(`notechunks:${noteId}`, JSON.stringify({
    chunks,
    metadata: {
      ...metadata,
      noteId,
      createdAt: new Date().toISOString(),
      chunkCount: chunks.length
    }
  }));
}

export async function getNoteChunks(env, noteId) {
  const raw = await env.NOTES_KV.get(`notechunks:${noteId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.chunks) ? parsed.chunks : null;
  } catch (_) {
    return null;
  }
}

export async function getRawNote(env, noteId) {
  const raw = await env.NOTES_KV.get(`note:${noteId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { text: raw, metadata: { noteId } };
  }
}

export async function listNotes(env) {
  const list = await env.NOTES_KV.list({ prefix: 'noteidx:' });
  const notes = [];
  for (const key of list.keys) {
    const raw = await env.NOTES_KV.get(key.name);
    if (raw) {
      try { notes.push(JSON.parse(raw)); } catch (_) {}
    }
  }
  return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteNote(env, noteId) {
  await env.NOTES_KV.delete(`note:${noteId}`);
  await env.NOTES_KV.delete(`noteidx:${noteId}`);
  await env.NOTES_KV.delete(`notechunks:${noteId}`);
  return true;
}

export async function embedText(env, text) {
  const result = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
    text: [text]
  });

  if (!result?.data?.[0]) {
    throw new Error('Embedding generation returned empty result');
  }

  const embedding = result.data[0];

  if (embedding.length !== 1024) {
    throw new Error(`Unexpected embedding dimension: ${embedding.length}, expected 1024`);
  }

  return embedding;
}

export async function storeChunkEmbedding(env, noteId, chunkIndex, chunkText, embedding, metadata = {}) {
  const vectorId = `${noteId}-${chunkIndex}`;
  await env.VECTORIZE.insert([{
    id: vectorId,
    values: embedding,
    metadata: {
      noteId,
      chunkIndex,
      preview: chunkText.slice(0, 100),
      subject: metadata.subject || null,
      topic: metadata.topic || null
    }
  }]);
  return vectorId;
}

export async function ingestNote(env, text, subject = 'General', options = {}) {
  const trimmed = text.trim();
  if (trimmed.length < 20) {
    throw new Error('Note is too short (minimum 20 characters). Add more content.');
  }
  if (trimmed.length > 15000) {
    throw new Error('Note is too long (maximum 15,000 characters). Please split into smaller notes.');
  }

  const noteId = options.noteId || generateNoteId();
  const topic = options.topic || null;
  const chunkList = Array.isArray(options.chunks) && options.chunks.length > 0
    ? options.chunks.map(c => (c || '').trim()).filter(Boolean)
    : chunkText(trimmed);

  await storeRawNote(env, noteId, trimmed, {
    subject,
    topic,
    sourceType: options.sourceType || 'text',
    sourceFileId: options.sourceFileId || null,
    sourceHash: options.sourceHash || null,
    processor: options.processor || null
  });

  const chunks = chunkList;
  if (chunks.length === 0) {
    throw new Error('Note could not be split into processable chunks.');
  }

  await storeNoteChunks(env, noteId, chunks, {
    subject,
    topic,
    sourceType: options.sourceType || 'text'
  });

  let embeddedCount = 0;
  const failedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await embedText(env, chunks[i]);
      await storeChunkEmbedding(env, noteId, i, chunks[i], embedding, { subject, topic });
      embeddedCount++;
    } catch (err) {
      console.error(JSON.stringify({
        event: 'chunk_embedding_failed',
        noteId,
        chunkIndex: i,
        error: err.message
      }));
      failedChunks.push(i);
    }
  }

  if (failedChunks.length > chunks.length / 2) {
    throw new Error(`Embedding failed for ${failedChunks.length}/${chunks.length} chunks. Please try again.`);
  }

  let wikiConcept = null;
  try {
    const wikiNode = await extractAndSaveWikiNode(env, trimmed, subject, noteId);
    if (wikiNode) {
      wikiConcept = wikiNode.concept;
    }
  } catch (_) {}

  console.log(JSON.stringify({
    event: 'note_ingested',
    noteId,
    subject,
    chunkCount: chunks.length,
    embeddedCount,
    failedChunks: failedChunks.length,
    textLength: trimmed.length
  }));

  return {
    noteId,
    chunkCount: chunks.length,
    embeddedCount,
    subject,
    partialFailure: failedChunks.length > 0,
    wikiConcept
  };
}