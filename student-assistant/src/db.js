export async function addTimetableEntry(env, subject, dayOfWeek, startTime, endTime, location = null) {
  const validDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  if (!validDays.includes(dayOfWeek)) {
    throw new Error(`Invalid day of week: "${dayOfWeek}". Use full names like Monday, Tuesday.`);
  }
  const result = await env.DB.prepare(
    `INSERT INTO timetable (subject, day_of_week, start_time, end_time, location)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(subject, dayOfWeek, startTime, endTime, location).run();
  return result.meta.last_row_id;
}

export async function getTimetableByDay(env, dayOfWeek) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM timetable WHERE day_of_week = ? ORDER BY start_time ASC`
  ).bind(dayOfWeek).all();
  return results || [];
}

export async function getFullTimetable(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM timetable
     ORDER BY
       CASE day_of_week
         WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
         WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5
         WHEN 'Saturday' THEN 6 WHEN 'Sunday' THEN 7
       END,
       start_time ASC`
  ).all();
  return results || [];
}

export async function deleteTimetableEntry(env, id) {
  const result = await env.DB.prepare(
    `DELETE FROM timetable WHERE id = ?`
  ).bind(id).run();
  return result.meta.changes > 0;
}

export async function addEvent(env, title, eventDate, eventTime = null, type = 'deadline', description = null) {
  const validTypes = ['deadline', 'exam', 'assignment', 'other'];
  const safeType = validTypes.includes(type) ? type : 'deadline';
  const result = await env.DB.prepare(
    `INSERT INTO events (title, description, event_date, event_time, type)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(title, description, eventDate, eventTime, safeType).run();
  return result.meta.last_row_id;
}

export async function getUpcomingEvents(env, daysAhead = 7) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE event_date BETWEEN date('now') AND date('now', '+' || ? || ' days')
     ORDER BY event_date ASC, event_time ASC`
  ).bind(daysAhead).all();
  return results || [];
}

export async function getTodayEvents(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events
     WHERE event_date = date('now')
     ORDER BY event_time ASC`
  ).all();
  return results || [];
}

export async function getAllEvents(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events ORDER BY event_date DESC, event_time DESC`
  ).all();
  return results || [];
}

export async function deleteEvent(env, id) {
  const result = await env.DB.prepare(
    `DELETE FROM events WHERE id = ?`
  ).bind(id).run();
  return result.meta.changes > 0;
}

export async function addReminder(env, eventId, remindAt, message) {
  const result = await env.DB.prepare(
    `INSERT INTO reminders (event_id, remind_at, message) VALUES (?, ?, ?)`
  ).bind(eventId || null, remindAt, message || null).run();
  return result.meta.last_row_id;
}

export async function getPendingReminders(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, e.title as event_title
     FROM reminders r
     LEFT JOIN events e ON r.event_id = e.id
     WHERE r.sent = 0 AND r.remind_at <= datetime('now')
     ORDER BY r.remind_at ASC`
  ).all();
  return results || [];
}

export async function markReminderSent(env, id) {
  await env.DB.prepare(
    `UPDATE reminders SET sent = 1 WHERE id = ?`
  ).bind(id).run();
}

export function getCurrentDayName() {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[new Date().getDay()];
}

export function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function generateReminderId() {
  return 'rem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function saveUserReminder(env, reminder) {
  const id = reminder.id || generateReminderId();
  await env.DB.prepare(
    `INSERT INTO user_reminders (id, user_id, message, due_time, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, reminder.user_id, reminder.message, reminder.due_time, reminder.status || 'pending').run();
  return id;
}

export async function getDueUserReminders(env, currentTime) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM user_reminders
     WHERE status = 'pending' AND due_time <= ?
     ORDER BY due_time ASC`
  ).bind(currentTime).all();
  return results || [];
}

export async function updateUserReminderStatus(env, id, status) {
  await env.DB.prepare(
    `UPDATE user_reminders SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(status, id).run();
}

export async function getUserRemindersByUserId(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM user_reminders WHERE user_id = ? ORDER BY due_time DESC`
  ).bind(userId).all();
  return results || [];
}

export async function getAllUserReminders(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM user_reminders ORDER BY due_time ASC`
  ).all();
  return results || [];
}

export async function getUserIdsWithReminders(env) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM user_reminders`
  ).all();
  return results ? results.map(r => r.user_id) : [];
}

export async function saveFileIngestionMetadata(env, metadata) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS file_ingestions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         note_id TEXT NOT NULL,
         user_id TEXT,
         chat_id TEXT,
         telegram_file_id TEXT,
         file_name TEXT,
         mime_type TEXT,
         file_hash TEXT,
         subject TEXT,
         source_type TEXT,
         extracted_chars INTEGER,
         chunk_count INTEGER,
         status TEXT,
         error_message TEXT,
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`
    ).run();

    await env.DB.prepare(
      `INSERT INTO file_ingestions
       (note_id, user_id, chat_id, telegram_file_id, file_name, mime_type, file_hash, subject, source_type, extracted_chars, chunk_count, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      metadata.noteId,
      metadata.userId || null,
      metadata.chatId || null,
      metadata.telegramFileId || null,
      metadata.fileName || null,
      metadata.mimeType || null,
      metadata.fileHash || null,
      metadata.subject || 'General',
      metadata.sourceType || 'upload',
      metadata.extractedChars || 0,
      metadata.chunkCount || 0,
      metadata.status || 'success',
      metadata.errorMessage || null
    ).run();
  } catch (err) {
    console.error(JSON.stringify({
      event: 'file_ingestion_metadata_save_failed',
      error: err.message
    }));
  }
}

export async function isUserWhitelisted(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT user_id FROM whitelisted_users WHERE user_id = ?`
  ).bind(String(userId)).all();
  return results.length > 0;
}

const RATE_LIMIT_WINDOW = 60;
const MAX_REQUESTS_PER_WINDOW = 10;

export async function checkRateLimit(env, userId) {
  const key = `ratelimit:${userId}`;
  const now = Date.now();
  
  try {
    const raw = await env.NOTES_KV.get(key);
    let data = { count: 0, timestamp: now };
    
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (e) {
        data = { count: 0, timestamp: now };
      }
    }
    
    if ((now - data.timestamp) / 1000 > RATE_LIMIT_WINDOW) {
      data = { count: 0, timestamp: now };
    }
    
    data.count++;
    
    await env.NOTES_KV.put(key, JSON.stringify(data), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
    
    return data.count <= MAX_REQUESTS_PER_WINDOW;
  } catch (e) {
    console.error(JSON.stringify({ event: 'rate_limit_check_error', error: e.message }));
    return true;
  }
}

export function sanitizeInput(text, maxLength = 5000) {
  if (!text || typeof text !== 'string') return '';
  return text.slice(0, maxLength).replace(/[<>`]/g, '');
}

export function validateNoteInput(text, subject) {
  if (!text || text.length < 10) {
    return { valid: false, error: 'Note text must be at least 10 characters.' };
  }
  if (text.length > 15000) {
    return { valid: false, error: 'Note text must be less than 15,000 characters.' };
  }
  if (subject && (subject.length < 2 || subject.length > 50)) {
    return { valid: false, error: 'Subject must be 2-50 characters.' };
  }
  return { valid: true };
}

export function validateReminderInput(message) {
  if (!message || message.length < 3) {
    return { valid: false, error: 'Reminder message must be at least 3 characters.' };
  }
  if (message.length > 500) {
    return { valid: false, error: 'Reminder message must be less than 500 characters.' };
  }
  return { valid: true };
}