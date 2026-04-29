import { saveUserReminder, getDueUserReminders, updateUserReminderStatus, getUserRemindersByUserId, getUserIdsWithReminders, getAllUserReminders, getUpcomingEvents, getTimetableByDay, getFullTimetable, getCurrentDayName, formatDate } from './db.js';
import { getWikiNodesBySubject, listAllWikiNodes } from './wiki.js';

function generateReminderId() {
  return 'rem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function parseReminderDetails(text) {
  const t = text.trim();
  
  let message = t
    .replace(/^(remind me|set a reminder|reminder)/i, '')
    .replace(/^(to|about|for)\s+/i, '')
    .trim();
  
  if (!message || message.length < 2) {
    return null;
  }
  
  const now = new Date();
  let dueTime = null;
  
  const inMinutesMatch = t.match(/in\s+(\d+)\s+(minute|hour|day|week)s?/i);
  if (inMinutesMatch) {
    const num = parseInt(inMinutesMatch[1]);
    const unit = inMinutesMatch[2].toLowerCase();
    const ms = unit.startsWith('minute') ? num * 60000 : 
                unit.startsWith('hour') ? num * 3600000 : 
                unit.startsWith('day') ? num * 86400000 : 
                num * 604800000;
    dueTime = new Date(now.getTime() + ms).toISOString();
  }
  
  const tomorrowMatch = t.match(/tomorrow/i);
  if (tomorrowMatch && !dueTime) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    dueTime = tomorrow.toISOString();
  }
  
  const dateMatch = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dateMatch && !dueTime) {
    const date = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
    date.setHours(9, 0, 0, 0);
    dueTime = date.toISOString();
  }
  
  const dayMatch = t.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (dayMatch && !dueTime) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = days.indexOf(dayMatch[1].toLowerCase());
    const date = new Date(now);
    let daysUntil = targetDay - date.getDay();
    if (daysUntil <= 0) daysUntil += 7;
    date.setDate(date.getDate() + daysUntil);
    date.setHours(9, 0, 0, 0);
    dueTime = date.toISOString();
  }
  
  if (!dueTime) {
    dueTime = new Date(now.getTime() + 3600000).toISOString();
  }
  
  return { message, dueTime };
}

export async function createReminder(env, userId, message, dueTime) {
  const reminder = {
    id: generateReminderId(),
    user_id: userId,
    message,
    due_time: dueTime,
    status: 'pending'
  };
  await saveUserReminder(env, reminder);
  return reminder;
}

export async function processDueReminders(env, token) {
  const now = new Date().toISOString();
  const dueReminders = await getDueUserReminders(env, now);
  
  for (const reminder of dueReminders) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: reminder.user_id,
          text: `⏰ *Reminder:* ${reminder.message}`,
          parse_mode: 'Markdown'
        })
      });
      
      await updateUserReminderStatus(env, reminder.id, 'sent');
      
      console.log(JSON.stringify({
        event: 'reminder_sent',
        reminder_id: reminder.id,
        user_id: reminder.user_id
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: 'reminder_send_failed',
        reminder_id: reminder.id,
        error: error.message
      }));
    }
  }
  
  return dueReminders.length;
}

export async function generateDailyBriefing(env, userId) {
  try {
    const day = getCurrentDayName();
    const classes = await getTimetableByDay(env, day);
    const events = await getUpcomingEvents(env, 7);
    const wikiNodes = await listAllWikiNodes(env);
    
    let briefing = `☀️ *Good Morning!*\n\nHere's your daily briefing:\n\n`;
    
    if (classes.length > 0) {
      briefing += `*📅 Today's Classes (${day}):*\n`;
      for (const c of classes.slice(0, 5)) {
        briefing += `• ${c.start_time}–${c.end_time}  ${c.subject}${c.location ? ` (${c.location})` : ''}\n`;
      }
    } else {
      briefing += `*📅 Today's Classes:* No classes scheduled\n`;
    }
    
    if (events.length > 0) {
      briefing += `\n*📌 Upcoming Events (next 7 days):*\n`;
      const typeEmoji = { exam: '📝', assignment: '📚', deadline: '⏰', other: '📌' };
      for (const e of events.slice(0, 5)) {
        const emoji = typeEmoji[e.type] || '📌';
        const time = e.event_time ? ` at ${e.event_time}` : '';
        briefing += `${emoji} ${formatDate(e.event_date)}${time} — ${e.title}\n`;
      }
    } else {
      briefing += `\n*📌 Upcoming Events:* No upcoming events\n`;
    }
    
    if (wikiNodes.length > 0) {
      const subjects = {};
      for (const n of wikiNodes) {
        if (!subjects[n.subject]) subjects[n.subject] = 0;
        subjects[n.subject]++;
      }
      const subjectList = Object.keys(subjects).slice(0, 5);
      briefing += `\n*📚 Study Topics:* ${subjectList.join(', ')}${Object.keys(subjects).length > 5 ? '...' : ''}\n`;
    }
    
    briefing += `\nHave a great ${day}! 🎓`;
    
    return briefing;
  } catch (error) {
    console.error(JSON.stringify({ event: 'briefing_failed', error: error.message }));
    return `☀️ *Good Morning!*\n\nCouldn't load your briefing today. Check /today and /upcoming for your schedule.`;
  }
}

export async function sendDailyBriefings(env, token) {
  const userIds = await getUserIdsWithReminders(env);
  
  let sentCount = 0;
  for (const userId of userIds) {
    try {
      const briefing = await generateDailyBriefing(env, userId);
      
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId,
          text: briefing,
          parse_mode: 'Markdown'
        })
      });
      
      sentCount++;
      console.log(JSON.stringify({ event: 'daily_briefing_sent', user_id: userId }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'briefing_send_failed', user_id: userId, error: error.message }));
    }
  }
  
  return sentCount;
}