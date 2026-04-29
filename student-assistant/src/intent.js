
/**
 * Normalizes user input for better matching
 */
export function normalizeQuery(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\w\s\/?!]/g, '') // Remove most punctuation except ?, !, /
    .replace(/\btodays\b/g, 'today')
    .replace(/\bnext\b/g, 'upcoming')
    .replace(/\bclasses\b/g, 'class')
    .replace(/\blectures\b/g, 'class')
    .replace(/\btimetable\b/g, 'schedule')
    .replace(/\bexam\b/g, 'contest')
    .replace(/\bdeadline\b/g, 'event')
    .trim();
}

/**
 * Layer 1: Fast Heuristic Matching
 */
function heuristicMatch(normalizedText) {
  const t = normalizedText;
  
  // Exact command matches
  if (t === '/today' || t === 'today' || t === 'today class') return 'today_classes';
  if (t === '/upcoming' || t === 'upcoming' || t === 'upcoming event' || t === 'upcoming contest') return 'upcoming_events';
  if (t.includes('schedule') || t.includes('timetable')) return 'schedule_query';
  
  // Upcoming exam lookup (demo reliability).
  // Note: normalizeQuery turns the word "exam" into "contest", but plural "exams" remains "exams".
  if (t.includes('upcoming') && (t.includes('contest') || t.includes('exams'))) return 'upcoming_events';
  if ((t.includes('when') || t.includes('date')) && (t.includes('contest') || t.includes('exams'))) return 'upcoming_events';

  // Student profile (CGPA / semester / branch)
  if (t.includes('cgpa') || t.includes('semester') || t.includes('enrollment') || t.includes('enrolment') || t.includes('branch')) {
    return 'student_profile';
  }

  // Conceptual / factual questions -> search in notes
  if (
    t.startsWith('explain ')
    || t.startsWith('describe ')
    || t.startsWith('what is ')
    || t.startsWith('what are ')
    || t.startsWith('define ')
    || t.startsWith('tell me about ')
  ) {
    return 'search_notes';
  }

  // Action patterns
  if (t.startsWith('/note') || t.startsWith('add note') || t.startsWith('save note')) return 'add_note';
  if (t.startsWith('/remind') || t.startsWith('remind me') || t.startsWith('set reminder')) return 'reminder';
  
  // Summarization (no leading slash)
  if (t.startsWith('summarize ') || t.startsWith('summarize\t') || t.startsWith('summary ') || t.startsWith('overview ') || t.includes(' summarize ')) {
    return 'summarize';
  }

  // Explicit commands
  if (t.startsWith('/search')) return 'search_notes';
  if (t.startsWith('/summarize')) return 'summarize';
  
  return null;
}

/**
 * Layer 2: LLM-Based Classification
 */
async function llmClassify(text, env) {
  const prompt = `You are an intent classifier for a Student Assistant. 
Analyze the user message and return EXACTLY ONE intent from the list below.

INTENTS:
- today_classes: User wants to know their classes/lectures for TODAY.
- upcoming_events: User wants to know upcoming exams, contests, or deadlines.
- schedule_query: User is asking about their general timetable or specific day schedule.
- student_profile: User wants to know their semester, CGPA, branch, or enrollment details.
- add_note: User wants to save some text, information, or study material.
- search_notes: User is asking a question that requires searching their saved notes (e.g. "Explain X", "What is Y").
- summarize: User wants a summary of a subject or specific topic.
- reminder: User wants to set a reminder for a specific time/event.
- ingest: User is uploading information or asking to manage notes.
- unknown: Use this if the message is greeting, gibberish, or irrelevant.

User Message: "${text}"

Return ONLY the intent name. No explanation.
Intent:`;

  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt,
      max_tokens: 20
    });
    
    const intent = result.response?.trim().toLowerCase();
    const valid = ['today_classes', 'upcoming_events', 'schedule_query', 'student_profile', 'add_note', 'search_notes', 'summarize', 'reminder', 'ingest', 'unknown'];
    
    return valid.find(v => intent.includes(v)) || 'unknown';
  } catch (error) {
    console.error('LLM classification failed:', error);
    return 'unknown';
  }
}

export async function detectIntent(text, env) {
  const normalized = normalizeQuery(text);
  
  // 1. Check Heuristics
  const quickMatch = heuristicMatch(normalized);
  if (quickMatch) {
    console.log(`[Intent] Heuristic match: ${quickMatch}`);
    return quickMatch;
  }
  
  // 2. Fallback to LLM
  console.log(`[Intent] Falling back to LLM for: "${text}"`);
  return await llmClassify(text, env);
}
