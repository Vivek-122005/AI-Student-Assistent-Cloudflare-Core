import {
  getTimetableByDay,
  getFullTimetable,
  addTimetableEntry,
  deleteTimetableEntry,
  getUpcomingEvents,
  getTodayEvents,
  getAllEvents,
  addEvent,
  deleteEvent,
  getCurrentDayName,
  formatDate
} from './db.js';
import { ingestNote, listNotes, deleteNote } from './knowledge.js';
import { searchNotes, hasNotes } from './retriever.js';
import { generateAnswer, formatRAGResponse, generateNoResultsResponse } from './generator.js';
import { findWikiNode, getWikiNodesBySubject, listAllWikiNodes } from './wiki.js';
import { parseReminderDetails, createReminder } from './reminders.js';
import { isUserWhitelisted, checkRateLimit, sanitizeInput, validateNoteInput, validateReminderInput } from './db.js';

export async function classifyIntent(text, env) {
  // Handle explicit commands first (no AI needed)
  if (!text || text.trim() === '') return 'unknown';
  const t = text.toLowerCase().trim();
  
  if (t.startsWith('/note') || t.startsWith('/add note')) return 'ingest';
  if (t.startsWith('/schedule add') || t === 'add class' || t === 'add lecture') return 'schedule_add';
  if (t.startsWith('/event add') || t.startsWith('add event') ||
      t.startsWith('add deadline') || t.startsWith('add exam') ||
      t.startsWith('add assignment')) return 'event_add';
  if (t.startsWith('/schedule delete')) return 'schedule';
  if (t.startsWith('/event delete')) return 'event';
  if (t.startsWith('/notes delete')) return 'ingest';
  if (t.startsWith('/event ') && !t.startsWith('/event add') && !t.startsWith('/event delete')) return 'event';
  if (t.startsWith('/schedule ') && !t.startsWith('/schedule add') && !t.startsWith('/schedule delete')) return 'schedule';
  if (t === '/today' || t === '/timetable') return 'schedule';
  if (t === '/upcoming' || t === '/events' || t === '/events all') return 'event';
  if (t === '/notes list' || t === '/notes') return 'ingest';
  if (t.startsWith('/wiki ')) return 'summary';
  if (t === '/wiki list' || t === '/wiki') return 'summary';

  // Use AI for natural language classification
  const prompt = `Classify the user's intent from the following message. Choose one from: 'schedule', 'conceptual', 'factual', 'summarize', 'set_reminder', 'unknown'.

Message: "${text}"

Intent:`;

  try {
    const response = await env.AI.run('@cf/mistral/mistral-7b-instruct-v0.2', {
      prompt,
      max_tokens: 20
    });
    const intent = response.response?.trim().toLowerCase();

    const validIntents = ['schedule', 'conceptual', 'factual', 'summarize', 'set_reminder'];
    if (validIntents.includes(intent)) {
      console.log(JSON.stringify({ event: 'intent_classified', textPreview: text.slice(0, 50), intent }));
      return intent;
    }
    console.warn(JSON.stringify({ event: 'intent_ai_unknown', aiResponse: intent, textPreview: text.slice(0, 50) }));
    return 'unknown';
  } catch (error) {
    console.error(JSON.stringify({ event: 'intent_classification_error', error: error.message }));
    return 'unknown';
  }
}

export async function handleMessage(update, env) {
  const { text, chatId, username } = update;

  const whitelisted = await isUserWhitelisted(env, chatId);
  if (!whitelisted) {
    console.log(JSON.stringify({ event: 'unauthorized_user', chatId, username }));
    return "Sorry, you are not authorized to use this bot. Please contact the administrator.";
  }

  const rateAllowed = await checkRateLimit(env, chatId);
  if (!rateAllowed) {
    console.log(JSON.stringify({ event: 'rate_limit_exceeded', chatId }));
    return "Too many requests. Please try again in a minute.";
  }

  const sanitizedText = sanitizeInput(text, 5000);
  if (!sanitizedText || sanitizedText.length < 1) {
    return "I couldn't understand that message. Please try again.";
  }

  const intent = await classifyIntent(sanitizedText, env);

  console.log(JSON.stringify({
    event: 'message_received',
    chatId,
    username,
    intent,
    textPreview: sanitizedText.slice(0, 50)
  }));

  switch (intent) {
    case 'ingest':       return await handleIngest(sanitizedText, env);
    case 'schedule_add': return await handleScheduleAdd(sanitizedText, env);
    case 'event_add':    return await handleEventAdd(sanitizedText, env);
    case 'schedule':    return await handleSchedule(sanitizedText, env);
    case 'event':       return await handleEvent(sanitizedText, env);
    case 'reminder':   return await handleReminder(sanitizedText, env);
    case 'conceptual': return await handleConceptual(sanitizedText, env);
    case 'summary':    return await handleSummary(sanitizedText, env);
    case 'factual':    return await handleFactual(sanitizedText, env);
    case 'summarize':   return await handleSummarizeIntent(sanitizedText, env);
    case 'set_reminder': return await handleSetReminderIntent(sanitizedText, env, chatId);
    default:           return handleUnknown(sanitizedText);
  }
}

async function handleIngest(text, env) {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (lower === '/notes list' || lower === '/notes') {
    return await handleListNotes(env);
  }

  if (lower.startsWith('/notes delete')) {
    const parts = t.split(/\s+/);
    const noteId = parts[2];
    if (!noteId) return '❌ Provide a note ID.\n\nUse: `/notes delete <noteId>`\n\nFind IDs with `/notes list`';
    return await handleDeleteNote(noteId, env);
  }

  let noteContent = t;
  let subject = 'General';

  if (lower.startsWith('/note')) {
    noteContent = t.replace(/^\/note\s*/i, '').trim();
  }

  const subjectMatch = noteContent.match(/^subject:(\S+)\s+/i);
  if (subjectMatch) {
    subject = subjectMatch[1].replace(/-/g, ' ');
    noteContent = noteContent.slice(subjectMatch[0].length).trim();
  }

  const validation = validateNoteInput(noteContent, subject);
  if (!validation.valid) {
    return `❌ ${validation.error}`;
  }

  noteContent = sanitizeInput(noteContent, 15000);

  if (!noteContent || noteContent.length < 20) {
    return `📝 *How to add a note:*\n\n\`/note your study content here\`\n\n*With subject tag:*\n\`/note subject:OperatingSystems Deadlocks occur when...\`\n\n*Minimum 20 characters required.*`;
  }

  try {
    const result = await ingestNote(env, noteContent, subject);

    let response = `✅ *Note saved!*\n\n`;
    response += `📚 Subject: *${result.subject}*\n`;
    response += `🔖 ID: \`${result.noteId}\`\n`;
    response += `🧩 Chunks indexed: *${result.embeddedCount}/${result.chunkCount}*\n`;
    response += `📏 Length: ${noteContent.length} characters\n`;

    if (result.wikiConcept) {
      response += `🧠 Wiki node: *${result.wikiConcept}*\n`;
    }

    if (result.partialFailure) {
      response += `\n⚠️ Some chunks failed to embed. Search may be incomplete for this note.`;
    }

    const wikiHint = result.wikiConcept ? `, or use \`/wiki ${result.wikiConcept.replace(/\s+/g, '-').toLowerCase()}\` to see the structured summary` : '';
    response += `\n\nAsk me anything about this content, or use \`/notes list\` to see all your notes${wikiHint}.`;
    return response;

  } catch (err) {
    console.error(JSON.stringify({ event: 'ingest_handler_failed', error: err.message }));
    if (err.message.includes('too short') || err.message.includes('too long') || err.message.includes('split')) {
      return `❌ ${err.message}`;
    }
    return `❌ Failed to save note. Please try again.\n\n_If this keeps happening, try splitting your note into smaller parts._`;
  }
}

async function handleListNotes(env) {
  try {
    const notes = await listNotes(env);
    if (notes.length === 0) {
      return `📚 *No notes stored yet*\n\nAdd your first note:\n\`/note your study content here\``;
    }
    const lines = notes.map(n => {
      const date = new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `• \`${n.noteId}\` — *${n.subject}* (${date})\n  _${n.preview.slice(0, 80)}${n.preview.length > 80 ? '...' : ''}_`;
    });
    return `📚 *Your Notes (${notes.length})*\n\n${lines.join('\n\n')}`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'list_notes_failed', error: err.message }));
    return "Sorry, couldn't retrieve your notes. Please try again.";
  }
}

async function handleDeleteNote(noteId, env) {
  try {
    await deleteNote(env, noteId);
    return `✅ Note \`${noteId}\` deleted.\n\n_Note: existing search vectors for this note will naturally expire and be ignored (score too low)._`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'delete_note_failed', noteId, error: err.message }));
    return `❌ Could not delete note \`${noteId}\`. Check the ID with \`/notes list\`.`;
  }
}

async function handleScheduleAdd(text, env) {
  if (text.trim().toLowerCase().startsWith('/schedule add')) {
    return await handleAddTimetable(text, env);
  }

  console.log(JSON.stringify({ event: 'nl_schedule_add_started', textPreview: text.slice(0, 80) }));

  const extracted = await extractScheduleFromText(text, env);

  if (!extracted) {
    return `I understood you want to add a class, but I couldn't extract the details clearly.\n\nTry being more specific:\n_"I have Mathematics every Monday from 9am to 10:30am in Room 101"_\n_"Data Structures lecture on Wednesdays, 11am–12pm, A-Block"_\n\nOr use the command:\n\`/schedule add Monday 09:00 10:30 Subject Location\``;
  }

  try {
    const id = await addTimetableEntry(
      env,
      extracted.subject,
      extracted.day,
      extracted.start_time,
      extracted.end_time,
      extracted.location
    );

    return `✅ *Got it! Class saved* (ID: ${id})\n\n📅 *${extracted.day}* ${extracted.start_time}–${extracted.end_time}\n*${extracted.subject}*${extracted.location ? `\n📍 ${extracted.location}` : ''}\n\n_If anything looks wrong, delete with \`/schedule delete ${id}\` and try again._`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'nl_schedule_save_failed', error: err.message }));
    return `I extracted the details but couldn't save: ${err.message}`;
  }
}

async function extractScheduleFromText(text, env) {
  const prompt = `A student sent this message: "${text}"

Extract the class/lecture schedule details and return a JSON object with exactly these fields:
- subject: name of the subject or course (string)
- day: full day name, one of: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday
- start_time: start time in HH:MM 24-hour format (string)
- end_time: end time in HH:MM 24-hour format (string)
- location: room or location if mentioned, otherwise null (string or null)

Rules:
- Convert 12-hour times (9am, 2:30pm) to 24-hour format
- If only duration is given (e.g. "1 hour class at 9am"), calculate end_time
- If day is ambiguous or not mentioned, return null for day
- If times are not mentioned, return null for start_time and end_time
- Return ONLY valid JSON. No explanation. No markdown. No code fences.

Example output: {"subject":"Mathematics","day":"Monday","start_time":"09:00","end_time":"10:30","location":"Room 101"}`;

  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt,
      max_tokens: 150
    });

    const raw = result.response?.trim();
    if (!raw) return null;

    const cleaned = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(cleaned);

    const validDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    if (!parsed.subject || typeof parsed.subject !== 'string') return null;
    if (!parsed.day || !validDays.includes(parsed.day)) return null;

    const timeRegex = /^\d{2}:\d{2}$/;
    if (!parsed.start_time || !timeRegex.test(parsed.start_time)) return null;
    if (!parsed.end_time || !timeRegex.test(parsed.end_time)) return null;

    return {
      subject: parsed.subject.trim(),
      day: parsed.day,
      start_time: parsed.start_time,
      end_time: parsed.end_time,
      location: parsed.location || null
    };
  } catch (err) {
    console.error(JSON.stringify({
      event: 'schedule_extraction_failed',
      error: err.message,
      input: text.slice(0, 100)
    }));
    return null;
  }
}

async function handleEventAdd(text, env) {
  if (text.trim().toLowerCase().startsWith('/event add')) {
    return await handleAddEvent(text, env);
  }

  console.log(JSON.stringify({ event: 'nl_event_add_started', textPreview: text.slice(0, 80) }));

  const extracted = await extractEventFromText(text, env);

  if (!extracted) {
    return `I understood you want to add an event, but I couldn't extract the details clearly.\n\nTry being more specific:\n_"I have my OS exam on December 1st"_\n_"Networking assignment due November 25th at 2pm"_\n\nOr use the command:\n\`/event add 2025-12-01 exam "Title"\``;
  }

  try {
    const id = await addEvent(env, extracted.title, extracted.date, extracted.time, extracted.type);
    const typeEmoji = { exam: '📝', assignment: '📚', deadline: '⏰', other: '📌' };
    const emoji = typeEmoji[extracted.type] || '📌';
    const timeStr = extracted.time ? ` at ${extracted.time}` : '';

    return `✅ *Got it! Event saved* (ID: ${id})\n\n${emoji} *${extracted.title}*\n📅 ${formatDate(extracted.date)}${timeStr}\n🏷️ ${extracted.type}\n\n_If anything looks wrong, delete with \`/event delete ${id}\` and try again._`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'nl_event_save_failed', error: err.message }));
    return "I extracted the details but couldn't save to the database. Please try again.";
  }
}

async function extractEventFromText(text, env) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const prompt = `Today is ${dayName}, ${today}. Tomorrow is ${tomorrowStr}.

Rules for resolving dates:
- If a specific day name is mentioned (e.g. "Friday", "next Monday"), resolve it to the NEXT future occurrence of that day. Never resolve it to today or any past date.
- If "tomorrow" is mentioned, the date is ${tomorrowStr}.
- If "today" is mentioned, the date is ${today}.
- If a date like "30th", "December 1st", or "2025-12-01" is mentioned, use it directly.
- If "next week" is mentioned with a day, add 7 days to the next occurrence of that day.

A student sent this message: "${text}"

Extract the academic event details and return a JSON object with exactly these fields:
- title: short descriptive title of the event (string)
- date: the event date in YYYY-MM-DD format (string).
- time: time in HH:MM 24-hour format if mentioned, otherwise null
- type: one of exactly: "exam", "assignment", "deadline", "other"

Rules:
- If no specific date is mentioned, return null for date
- If multiple events are mentioned, extract only the first/most prominent one
- title should be concise, e.g. "OS Finals Exam" not "I have my OS finals exam"
- Return ONLY valid JSON. No explanation. No markdown. No code fences.

Example output: {"title":"OS Finals Exam","date":"2025-12-01","time":null,"type":"exam"}`;

  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt,
      max_tokens: 150
    });

    const raw = result.response?.trim();
    if (!raw) return null;

    const cleaned = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.title || typeof parsed.title !== 'string') return null;
    if (!parsed.date || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) return null;

    const validTypes = ['exam', 'assignment', 'deadline', 'other'];
    if (!validTypes.includes(parsed.type)) parsed.type = 'other';

    if (parsed.time && !/^\d{2}:\d{2}$/.test(parsed.time)) parsed.time = null;

    return {
      title: parsed.title.trim(),
      date: parsed.date,
      time: parsed.time || null,
      type: parsed.type
    };
  } catch (err) {
    console.error(JSON.stringify({
      event: 'event_extraction_failed',
      error: err.message,
      input: text.slice(0, 100)
    }));
    return null;
  }
}

async function handleSchedule(text, env) {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (lower.startsWith('/schedule add')) {
    return await handleAddTimetable(t, env);
  }

  if (lower.startsWith('/schedule delete')) {
    return await handleDeleteTimetable(t, env);
  }

  if (lower === '/timetable' || lower.includes('full timetable') ||
      lower.includes('whole schedule') || lower.includes('entire schedule')) {
    return await handleFullTimetable(env);
  }

  return await handleTodaySchedule(env);
}

async function handleTodaySchedule(env) {
  try {
    const day = getCurrentDayName();
    const classes = await getTimetableByDay(env, day);

    if (classes.length === 0) {
      return `📅 *No classes on ${day}*\n\nEnjoy your free day! Add classes with:\n\`/schedule add ${day} 09:00 10:30 SubjectName Room-101\``;
    }

    const lines = classes.map(c =>
      `• ${c.start_time}–${c.end_time}  *${c.subject}*${c.location ? `  📍${c.location}` : ''} _(ID: ${c.id})_`
    );

    return `📅 *${day}'s Classes*\n\n${lines.join('\n')}`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'schedule_today_failed', error: err.message }));
    return "Sorry, I couldn't fetch today's schedule. Please try again.";
  }
}

async function handleFullTimetable(env) {
  try {
    const entries = await getFullTimetable(env);

    if (entries.length === 0) {
      return `📅 *Timetable is empty*\n\nAdd classes with:\n\`/schedule add Monday 09:00 10:30 Mathematics Room-101\``;
    }

    const grouped = {};
    for (const entry of entries) {
      if (!grouped[entry.day_of_week]) grouped[entry.day_of_week] = [];
      grouped[entry.day_of_week].push(entry);
    }

    const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const sections = [];

    for (const day of dayOrder) {
      if (!grouped[day]) continue;
      const lines = grouped[day].map(c =>
        `  • ${c.start_time}–${c.end_time}  ${c.subject}${c.location ? ` (${c.location})` : ''} _[ID:${c.id}]_`
      );
      sections.push(`*${day}*\n${lines.join('\n')}`);
    }

    return `📅 *Full Timetable*\n\n${sections.join('\n\n')}`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'timetable_full_failed', error: err.message }));
    return "Sorry, I couldn't fetch the timetable. Please try again.";
  }
}

async function handleAddTimetable(text, env) {
  const parsed = parseTimetableAdd(text);
  if (!parsed) {
    return `❌ *Invalid format*\n\nUse:\n\`/schedule add <Day> <Start> <End> <Subject> [Location]\`\n\nExample:\n\`/schedule add Monday 09:00 10:30 Mathematics Room-101\``;
  }
  try {
    const id = await addTimetableEntry(
      env, parsed.subject, parsed.day, parsed.start, parsed.end, parsed.location
    );
    return `✅ *Class added* (ID: ${id})\n\n📅 *${parsed.day}* ${parsed.start}–${parsed.end}\n*${parsed.subject}*${parsed.location ? `\n📍 ${parsed.location}` : ''}`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'timetable_add_failed', error: err.message }));
    return `❌ ${err.message}`;
  }
}

function parseTimetableAdd(text) {
  const timeRegex = /^(\d{2}:\d{2})$/;
  const parts = text.replace(/^\/schedule\s+add\s+/i, '').trim().split(/\s+/);
  if (parts.length < 4) return null;

  const [day, start, end, ...rest] = parts;
  if (!timeRegex.test(start) || !timeRegex.test(end)) return null;

  const locationPattern = /^[A-Za-z0-9].*[-\/]\w+$|^\w+\d+\w*$/;
  let subject, location;
  if (rest.length > 1 && locationPattern.test(rest[rest.length - 1])) {
    location = rest[rest.length - 1];
    subject = rest.slice(0, -1).join(' ');
  } else {
    subject = rest.join(' ');
    location = null;
  }

  if (!subject) return null;
  return { day, start, end, subject, location };
}

async function handleDeleteTimetable(text, env) {
  const parts = text.trim().split(/\s+/);
  const id = parseInt(parts[parts.length - 1], 10);
  if (isNaN(id)) {
    return `❌ *Invalid format*\n\nUse: \`/schedule delete <id>\`\n\nFind IDs with \`/timetable\``;
  }
  try {
    const deleted = await deleteTimetableEntry(env, id);
    return deleted
      ? `✅ Class (ID: ${id}) removed from timetable.`
      : `❌ No class found with ID ${id}. Use \`/timetable\` to see valid IDs.`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'timetable_delete_failed', error: err.message }));
    return "Sorry, couldn't delete that entry. Please try again.";
  }
}

async function handleEvent(text, env) {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (lower.startsWith('/event add') || lower.startsWith('/event add')) {
    return await handleAddEvent(t, env);
  }
  if (lower.startsWith('/event delete')) {
    return await handleDeleteEvent(t, env);
  }
  if (lower === '/events all' || lower === 'all events') {
    return await handleAllEvents(env);
  }
  if (lower.includes('today') && lower.includes('event')) {
    return await handleTodayEvents(env);
  }

  const daysMatch = t.match(/(\d+)\s*days?/i) || t.match(/\/upcoming\s+(\d+)/i);
  const days = daysMatch ? Math.min(parseInt(daysMatch[1], 10), 30) : 7;
  return await handleUpcomingEvents(env, days);
}

async function handleUpcomingEvents(env, daysAhead = 7) {
  try {
    const events = await getUpcomingEvents(env, daysAhead);

    if (events.length === 0) {
      return `📌 *No events in the next ${daysAhead} days*\n\nAdd one with:\n\`/event add 2025-12-01 exam "Final OS Exam"\``;
    }

    const typeEmoji = { exam: '📝', assignment: '📚', deadline: '⏰', other: '📌' };
    const lines = events.map(e => {
      const emoji = typeEmoji[e.type] || '📌';
      const time = e.event_time ? ` at ${e.event_time}` : '';
      const desc = e.description ? `\n  _${e.description}_` : '';
      return `${emoji} *${formatDate(e.event_date)}*${time} — ${e.title} _(ID: ${e.id})_${desc}`;
    });

    return `📌 *Upcoming Events (${daysAhead} days)*\n\n${lines.join('\n\n')}`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'upcoming_events_failed', error: err.message }));
    return "Sorry, I couldn't fetch upcoming events. Please try again.";
  }
}

async function handleTodayEvents(env) {
  try {
    const events = await getTodayEvents(env);
    if (events.length === 0) {
      return `📌 *No events due today*\n\nCheck upcoming with \`/upcoming\``;
    }
    const typeEmoji = { exam: '📝', assignment: '📚', deadline: '⏰', other: '📌' };
    const lines = events.map(e => {
      const emoji = typeEmoji[e.type] || '📌';
      const time = e.event_time ? ` at ${e.event_time}` : '';
      return `${emoji} ${e.title}${time} _(${e.type})_ _(ID: ${e.id})_`;
    });
    return `📌 *Today's Events*\n\n${lines.join('\n')}`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'today_events_failed', error: err.message }));
    return "Sorry, I couldn't fetch today's events.";
  }
}

async function handleAllEvents(env) {
  try {
    const events = await getAllEvents(env);
    if (events.length === 0) {
      return `📌 *No events stored*\n\nAdd one with:\n\`/event add 2025-12-01 exam "Final OS Exam"\``;
    }
    const typeEmoji = { exam: '📝', assignment: '📚', deadline: '⏰', other: '📌' };
    const lines = events.map(e => {
      const emoji = typeEmoji[e.type] || '📌';
      return `${emoji} *${formatDate(e.event_date)}* — ${e.title} _(${e.type})_ _(ID: ${e.id})_`;
    });
    return `📌 *All Events (${events.length})*\n\n${lines.join('\n')}`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'all_events_failed', error: err.message }));
    return "Sorry, I couldn't fetch events.";
  }
}

async function handleAddEvent(text, env) {
  const parsed = parseEventAdd(text);
  if (!parsed) {
    return `❌ *Invalid format*\n\nUse:\n\`/event add <date> <type> <title>\`\n\nExamples:\n\`/event add 2025-12-01 exam "Final OS Exam"\`\n\`/event add 2025-11-25 assignment "Networking Lab Report"\`\n\nTypes: exam, assignment, deadline, other`;
  }
  try {
    const id = await addEvent(
      env, parsed.title, parsed.date, parsed.time, parsed.type, parsed.description
    );
    const typeEmoji = { exam: '📝', assignment: '📚', deadline: '⏰', other: '📌' };
    return `✅ *Event added* (ID: ${id})\n\n${typeEmoji[parsed.type] || '📌'} *${parsed.title}*\n📅 ${formatDate(parsed.date)}${parsed.time ? ` at ${parsed.time}` : ''}\n🏷️ ${parsed.type}`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'event_add_failed', error: err.message }));
    return `❌ Failed to add event: ${err.message}`;
  }
}

function parseEventAdd(text) {
  const base = text.replace(/^\/event\s+add\s+/i, '').trim();

  const dateRegex = /^(\d{4}-\d{2}-\d{2})\s+/;
  const dateMatch = base.match(dateRegex);
  if (!dateMatch) return null;

  const date = dateMatch[1];
  let remaining = base.slice(dateMatch[0].length).trim();

  const validTypes = ['exam', 'assignment', 'deadline', 'other'];
  const typeMatch = remaining.match(/^(exam|assignment|deadline|other)\s+/i);
  const type = typeMatch ? typeMatch[1].toLowerCase() : 'deadline';
  if (typeMatch) remaining = remaining.slice(typeMatch[0].length).trim();

  let title, time = null;
  const quotedTitle = remaining.match(/^"([^"]+)"\s*(.*)?$/);
  if (quotedTitle) {
    title = quotedTitle[1];
    const afterTitle = quotedTitle[2]?.trim();
    const timeMatch = afterTitle?.match(/^(\d{2}:\d{2})/);
    if (timeMatch) time = timeMatch[1];
  } else {
    const timeMatch = remaining.match(/\s+(\d{2}:\d{2})$/);
    if (timeMatch) {
      time = timeMatch[1];
      title = remaining.slice(0, -timeMatch[0].length).trim();
    } else {
      title = remaining;
    }
  }

  if (!title || title.length === 0) return null;
  return { date, type, title, time, description: null };
}

async function handleDeleteEvent(text, env) {
  const parts = text.trim().split(/\s+/);
  const id = parseInt(parts[parts.length - 1], 10);
  if (isNaN(id)) {
    return `❌ *Invalid format*\n\nUse: \`/event delete <id>\`\n\nFind IDs with \`/upcoming\` or \`/events all\``;
  }
  try {
    const deleted = await deleteEvent(env, id);
    return deleted
      ? `✅ Event (ID: ${id}) deleted.`
      : `❌ No event found with ID ${id}. Use \`/upcoming\` or \`/events all\` to see valid IDs.`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'event_delete_failed', error: err.message }));
    return "Sorry, couldn't delete that event. Please try again.";
  }
}

async function handleReminder(text, env) {
  console.log(JSON.stringify({ event: 'handler_stub', intent: 'reminder' }));
  return "⏰ *Reminder request received*\n\nReminder creation will be available in the next update.";
}

async function handleConceptual(text, env) {
  console.log(JSON.stringify({ event: 'conceptual_query', textPreview: text.slice(0, 60) }));

  const wikiNode = await findWikiNode(env, text);

  if (wikiNode) {
    return formatWikiNodeResponse(wikiNode);
  }

  console.log(JSON.stringify({ event: 'wiki_miss_rag_fallback', query: text.slice(0, 60) }));
  return await handleFactual(text, env);
}

function formatWikiNodeResponse(node) {
  const keyPointLines = node.keyPoints.map(kp => `• ${kp}`).join('\n');
  const related = node.relatedConcepts.length > 0
    ? `\n\n🔗 *Related:* ${node.relatedConcepts.join(' · ')}`
    : '';
  const sources = node.sourceNoteIds.length > 0
    ? `\n\n📚 _From your ${node.subject} notes_`
    : '';

  return `🧠 *${node.concept}* _(${node.subject})_\n\n${node.summary}\n\n*Key Points:*\n${keyPointLines}${related}${sources}`;
}

async function handleSummary(text, env) {
  const lower = text.toLowerCase().trim();
  if (lower === '/wiki list' || lower === '/wiki') {
    return await handleWikiList(env);
  }

  if (lower.startsWith('/wiki ')) {
    const concept = text.replace(/^\/wiki\s+/i, '').trim();
    const node = await findWikiNode(env, concept);
    if (node) return formatWikiNodeResponse(node);
    return `No wiki entry found for *${concept}*.\n\nUse \`/wiki list\` to see all available topics, or add notes about this topic first.`;
  }

  const subject = parseSubjectFromSummaryQuery(text);

  if (!subject) {
    return `Which subject would you like summarized?\n\nExamples:\n• \`summarize my OS notes\`\n• \`overview of networking\`\n• \`/wiki list\` to see all topics`;
  }

  console.log(JSON.stringify({ event: 'summary_query', subject }));

  const nodes = await getWikiNodesBySubject(env, subject);

  if (nodes.length === 0) {
    return `I don't have wiki notes for *${subject}* yet.\n\nAdd notes with:\n\`/note subject:${subject.replace(/\s+/g, '')} your content\`\n\nOr check available subjects with \`/wiki list\``;
  }

  return formatSubjectSummary(subject, nodes);
}

function parseSubjectFromSummaryQuery(text) {
  const patterns = [
    /summarize\s+(?:my\s+)?(?:notes\s+(?:on|about|for)\s+)?(.+?)(?:\s+notes?)?$/i,
    /summary\s+(?:of|for|on)\s+(.+?)(?:\s+notes?)?$/i,
    /overview\s+(?:of|for|on)\s+(.+?)(?:\s+notes?)?$/i,
    /give\s+(?:me\s+)?(?:a\s+)?(?:summary|overview)\s+(?:of|on|for)\s+(.+?)(?:\s+notes?)?$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim()
        .replace(/^(my|the)\s+/i, '')
        .trim();
    }
  }
  return null;
}

function formatSubjectSummary(subject, nodes) {
  const header = `📋 *${subject} — Study Summary*\n_(${nodes.length} topic${nodes.length > 1 ? 's' : ''})_\n\n`;

  const sections = nodes.map(node => {
    const kps = node.keyPoints.slice(0, 3).map(kp => `  • ${kp}`).join('\n');
    return `*${node.concept}*\n${node.summary}\n${kps}`;
  });

  let body = sections.join('\n\n───\n\n');
  if (header.length + body.length > 3800) {
    body = sections.slice(0, 5).join('\n\n───\n\n');
    body += `\n\n_...and ${nodes.length - 5} more topics. Use \`/wiki <concept>\` for individual topics._`;
  }

  return header + body;
}

async function handleWikiList(env) {
  try {
    const entries = await listAllWikiNodes(env);
    if (entries.length === 0) {
      return `🧠 *No wiki nodes yet*\n\nWiki nodes are created automatically when you add notes.\n\nTry: \`/note subject:OperatingSystems Deadlocks occur when...\``;
    }

    const grouped = {};
    for (const e of entries) {
      if (!grouped[e.subject]) grouped[e.subject] = [];
      grouped[e.subject].push(e.concept);
    }

    const sections = Object.entries(grouped).map(([subject, concepts]) =>
      `*${subject}*\n${concepts.map(c => `  • ${c}`).join('\n')}`
    );

    return `🧠 *Wiki Knowledge Base (${entries.length} topics)*\n\n${sections.join('\n\n')}\n\n_Use \`/wiki <concept>\` to view any topic._`;
  } catch (err) {
    console.error(JSON.stringify({ event: 'wiki_list_failed', error: err.message }));
    return "Sorry, couldn't retrieve the wiki list. Please try again.";
  }
}

async function handleFactual(text, env) {
  const query = text
    .replace(/^(tell me|explain|describe|can you|please|i want to know|what do you know about)\s+/i, '')
    .trim();

  if (query.length < 3) {
    return "Please ask a more specific question about your notes.";
  }

  console.log(JSON.stringify({ event: 'rag_query_started', query: query.slice(0, 80) }));

  try {
    const chunks = await searchNotes(env, query);

    if (chunks.length === 0) {
      const notesExist = await hasNotes(env);
      return generateNoResultsResponse(query, notesExist);
    }

    const answer = await generateAnswer(env, query, chunks);

    if (answer.toLowerCase().includes("don't have enough notes")) {
      const notesExist = await hasNotes(env);
      return generateNoResultsResponse(query, notesExist);
    }

    return formatRAGResponse(query, answer, chunks);

  } catch (err) {
    console.error(JSON.stringify({ event: 'factual_handler_failed', error: err.message }));
    return `❌ ${err.message}`;
  }
}

async function handleSummarizeIntent(text, env) {
  const t = text.toLowerCase();
  
  const patterns = [
    /summarize\s+(?:my\s+)?(?:notes?\s+(?:on|about|for|of)\s+)?(.+?)$/i,
    /summary\s+(?:of|for|on)\s+(.+?)$/i,
    /overview\s+(?:of|for|on)\s+(.+?)$/i,
    /give\s+(?:me\s+)(?:a\s+)?(?:summary|overview)\s+(?:of|on|for)\s+(.+?)$/i
  ];
  
  let subject = null;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      subject = match[1].trim().replace(/^(my|the)\s+/i, '').trim();
      break;
    }
  }
  
  if (!subject) {
    return `Which subject would you like me to summarize?\n\nExamples:\n• "summarize my OS notes"\n• "overview of networking"\n• "summarize my data structures notes"`;
  }
  
  const nodes = await getWikiNodesBySubject(env, subject);
  
  if (nodes.length === 0) {
    const hasAnyNotes = await hasNotes(env);
    if (!hasAnyNotes) {
      return `I don't have any notes yet! Add study material first:\n\n\`/note your content here\``;
    }
    return `I couldn't find wiki notes for *${subject}*.\n\nTry adding notes about this topic with:\n\`/note subject:${subject.replace(/\s+/g, '')} your notes here\`\n\nOr check available topics with \`/wiki list\``;
  }
  
  const header = `📋 *${subject} — Summary*\n_(${nodes.length} topic${nodes.length > 1 ? 's' : ''})_\n\n`;
  const sections = nodes.slice(0, 5).map(node => {
    const kps = node.keyPoints.slice(0, 2).map(kp => `  • ${kp}`).join('\n');
    return `*${node.concept}*\n${node.summary}\n${kps}`;
  });
  
  let body = sections.join('\n\n───\n\n');
  if (nodes.length > 5) {
    body += `\n\n_...and ${nodes.length - 5} more topics._`;
  }
  
  return header + body;
}

async function handleSetReminderIntent(text, env, userId) {
  const parsed = parseReminderDetails(text);
  
  if (!parsed || !parsed.message) {
    return `⏰ *Set a reminder*\n\nTo set a reminder, please include what you need to be reminded about.\n\nExamples:\n• "remind me about the exam tomorrow at 10am"\n• "set a reminder for the project deadline on Friday"\n• "remind me in 30 minutes"`;
  }

  const validation = validateReminderInput(parsed.message);
  if (!validation.valid) {
    return `❌ ${validation.error}`;
  }
  
  try {
    const reminder = await createReminder(env, userId, parsed.message, parsed.dueTime);
    
    const dueDate = new Date(parsed.dueTime);
    const formattedDate = dueDate.toLocaleDateString('en-US', { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
    
    return `✅ *Reminder set!*\n\n⏰ I'll remind you about:\n*${parsed.message}*\n\n📅 ${formattedDate}\n\nYou can cancel by checking your reminders list.`;
  } catch (error) {
    console.error(JSON.stringify({ event: 'reminder_creation_failed', error: error.message }));
    return `❌ Failed to set reminder. Please try again.`;
  }
}

function handleUnknown(text) {
  return `I'm not sure what you mean. Here's what I can help with:

📝 *Add a note:* \`/note your content here\`
📅 *Today's classes:* \`/today\` or ask "what are my classes today"
📌 *Upcoming events:* \`/upcoming\` or ask "what deadlines do I have"
🧠 *Explain a topic:* "explain deadlocks" or "what is a semaphore"
🔍 *Search your notes:* "how does TCP work" or "what did I write about sorting"
📋 *Summarize:* "summarize my OS notes"
⏰ *Set a reminder:* "remind me about the exam on Dec 1"`;
}