import { embedText, getRawNote, getNoteChunks } from './knowledge.js';
import { chunkText } from './chunker.js';

export async function searchNotes(env, query, options = {}) {
  const {
    topK = 8,
    minScore = 0.45,
    maxChunks = 5
  } = options;

  let queryEmbedding;
  try {
    queryEmbedding = await embedText(env, query);
  } catch (err) {
    console.error(JSON.stringify({ event: 'query_embed_failed', error: err.message }));
    throw new Error('Failed to process your question. Please try again.');
  }

  let vectorResults;
  try {
    vectorResults = await env.VECTORIZE.query(queryEmbedding, {
      topK,
      returnMetadata: true
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'vectorize_query_failed', error: err.message }));
    throw new Error('Search index unavailable. Please try again.');
  }

  if (!vectorResults?.matches || vectorResults.matches.length === 0) {
    return [];
  }

  const relevant = vectorResults.matches.filter(m => m.score >= minScore);

  if (relevant.length === 0) {
    return [];
  }

  const chunks = [];

  for (const match of relevant.slice(0, maxChunks)) {
    try {
      const { noteId, chunkIndex } = match.metadata;
      const noteData = await getRawNote(env, noteId);

      if (!noteData) {
        console.log(JSON.stringify({ event: 'orphan_vector', noteId, chunkIndex }));
        continue;
      }

      const storedChunks = await getNoteChunks(env, noteId);
      const allChunks = storedChunks && storedChunks.length > 0
        ? storedChunks
        : chunkText(noteData.text);
      const chunkText_ = allChunks[chunkIndex] || allChunks[0];

      if (!chunkText_) continue;

      chunks.push({
        text: chunkText_,
        score: match.score,
        noteId,
        chunkIndex,
        subject: noteData.metadata?.subject || 'General',
        createdAt: noteData.metadata?.createdAt,
        preview: match.metadata.preview || chunkText_.slice(0, 80)
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'chunk_fetch_failed',
        noteId: match.metadata?.noteId,
        error: err.message
      }));
    }
  }

  chunks.sort((a, b) => b.score - a.score);

  console.log(JSON.stringify({
    event: 'search_complete',
    query: query.slice(0, 60),
    totalMatches: vectorResults.matches.length,
    aboveThreshold: relevant.length,
    chunksReturned: chunks.length
  }));

  return chunks;
}

export async function hasNotes(env) {
  try {
    const list = await env.NOTES_KV.list({ prefix: 'noteidx:', limit: 1 });
    return list.keys.length > 0;
  } catch (_) {
    return false;
  }
}