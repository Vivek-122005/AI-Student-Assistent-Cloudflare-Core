function toSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export async function extractWikiNode(env, text, subject, noteId) {
  const truncated = text.length > 3000 ? text.slice(0, 3000) + '...' : text;

  const prompt = `You are a knowledge extraction system for a student assistant.

Analyze these student notes and extract structured knowledge.

Subject: ${subject}
Notes: ${truncated}

Return a JSON object with EXACTLY these fields:
{
  "concept": "The main topic name as a short noun phrase (2-4 words max, e.g. 'Deadlock', 'TCP Protocol', 'Binary Semaphore')",
  "summary": "A single clear sentence explaining what this concept is (max 40 words)",
  "keyPoints": ["3 to 5 key facts or rules about this concept, each as a short sentence"],
  "relatedConcepts": ["2 to 4 related topic names the student might also want to study"]
}

Rules:
- concept must be a proper noun phrase, not a sentence
- summary must start with the concept name
- keyPoints must be an array of 3-5 strings
- relatedConcepts must be an array of 2-4 strings
- Return ONLY the JSON object. No explanation. No markdown. No code fences. No text before or after.`;

  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt,
      max_tokens: 600
    });

    const raw = result?.response?.trim();
    if (!raw) throw new Error('Empty AI response');

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in response');

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.concept || typeof parsed.concept !== 'string') throw new Error('Missing concept');
    if (!parsed.summary || typeof parsed.summary !== 'string') throw new Error('Missing summary');
    if (!Array.isArray(parsed.keyPoints) || parsed.keyPoints.length < 2) throw new Error('Missing keyPoints');
    if (!Array.isArray(parsed.relatedConcepts)) parsed.relatedConcepts = [];

    return {
      concept: parsed.concept.trim(),
      conceptSlug: toSlug(parsed.concept),
      subject: subject.trim(),
      summary: parsed.summary.trim(),
      keyPoints: parsed.keyPoints
        .filter(kp => typeof kp === 'string' && kp.trim().length > 0)
        .slice(0, 6)
        .map(kp => kp.trim()),
      relatedConcepts: parsed.relatedConcepts
        .filter(rc => typeof rc === 'string' && rc.trim().length > 0)
        .slice(0, 5)
        .map(rc => rc.trim()),
      sourceNoteIds: [noteId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error(JSON.stringify({
      event: 'wiki_extraction_failed',
      subject,
      noteId,
      error: err.message,
      textPreview: text.slice(0, 80)
    }));
    return null;
  }
}

export async function saveWikiNode(env, node) {
  const key = `wiki:${node.conceptSlug}`;

  const existing = await getWikiNode(env, node.conceptSlug);
  if (existing) {
    const mergedSources = [...new Set([...existing.sourceNoteIds, ...node.sourceNoteIds])];
    node = { ...node, sourceNoteIds: mergedSources, createdAt: existing.createdAt };
  }

  await env.NOTES_KV.put(key, JSON.stringify(node));

  const idxKey = `wikiidx:${toSlug(node.subject)}:${node.conceptSlug}`;
  await env.NOTES_KV.put(idxKey, JSON.stringify({
    conceptSlug: node.conceptSlug,
    concept: node.concept,
    subject: node.subject,
    summary: node.summary.slice(0, 120)
  }));

  console.log(JSON.stringify({
    event: 'wiki_node_saved',
    concept: node.concept,
    subject: node.subject,
    conceptSlug: node.conceptSlug
  }));
}

export async function getWikiNode(env, conceptSlug) {
  const slug = toSlug(conceptSlug);
  const raw = await env.NOTES_KV.get(`wiki:${slug}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

export async function findWikiNode(env, query) {
  const direct = await getWikiNode(env, query);
  if (direct) return direct;

  const words = query.toLowerCase().trim()
    .replace(/^(what is|explain|define|tell me about|describe)\s+/i, '')
    .split(/\s+/)
    .filter(w => w.length > 3);

  for (const word of words) {
    const match = await getWikiNode(env, word);
    if (match) return match;
  }

  const cleaned = query.toLowerCase()
    .replace(/^(what is|explain|define|tell me about|describe|what are)\s+/i, '')
    .trim();
  const cleanMatch = await getWikiNode(env, cleaned);
  if (cleanMatch) return cleanMatch;

  return null;
}

export async function getWikiNodesBySubject(env, subject) {
  const subjectSlug = toSlug(subject);
  const list = await env.NOTES_KV.list({ prefix: `wikiidx:${subjectSlug}:` });

  if (list.keys.length === 0) return [];

  const nodes = [];
  for (const key of list.keys) {
    const raw = await env.NOTES_KV.get(key.name);
    if (!raw) continue;
    try {
      const idx = JSON.parse(raw);
      const full = await getWikiNode(env, idx.conceptSlug);
      if (full) nodes.push(full);
    } catch (_) {}
  }

  return nodes;
}

export async function listAllWikiNodes(env) {
  const list = await env.NOTES_KV.list({ prefix: 'wikiidx:' });
  const entries = [];
  for (const key of list.keys) {
    const raw = await env.NOTES_KV.get(key.name);
    if (!raw) continue;
    try { entries.push(JSON.parse(raw)); } catch (_) {}
  }
  return entries;
}

export async function extractAndSaveWikiNode(env, text, subject, noteId) {
  try {
    const node = await extractWikiNode(env, text, subject, noteId);
    if (!node) return null;
    await saveWikiNode(env, node);
    return node;
  } catch (err) {
    console.error(JSON.stringify({
      event: 'wiki_pipeline_failed',
      noteId,
      error: err.message
    }));
    return null;
  }
}