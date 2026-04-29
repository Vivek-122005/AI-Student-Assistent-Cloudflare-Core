import { processDueReminders, sendDailyBriefings } from './reminders.js';

export default {
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