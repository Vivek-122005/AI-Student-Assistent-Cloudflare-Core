const EXAMS = [
  { date: '2026-01-09', title: 'Advanced Discrete Mathematics Contest 1', type: 'exam' },
  { date: '2026-01-16', title: 'Operating Systems Contest 1', type: 'exam' },
  { date: '2026-01-23', title: 'Deep Learning Contest 1', type: 'exam' },
  { date: '2026-01-30', title: 'Advanced Machine Learning Contest 1', type: 'exam' },
  { date: '2026-02-13', title: 'Operating Systems Contest 2', type: 'exam' },
  { date: '2026-02-27', title: 'Advanced Discrete Mathematics Contest 2', type: 'exam' },
  { date: '2026-03-20', title: 'Operating Systems Contest 3', type: 'exam' },
  { date: '2026-03-27', title: 'Advanced Discrete Mathematics Contest 3', type: 'exam' },
  { date: '2026-04-03', title: 'Deep Learning Contest 2', type: 'exam' },
  { date: '2026-04-10', title: 'Advanced Machine Learning Contest 2', type: 'exam' },
  { date: '2026-05-01', title: 'Operating Systems Contest 4', type: 'exam' },
  { date: '2026-05-08', title: 'Advanced Discrete Mathematics Contest 4', type: 'exam' },
];

const TIMETABLE = [
  { day: 'Monday', start_time: '08:00', end_time: '09:30', subject: 'Deep Learning', location: 'L1' },
  { day: 'Monday', start_time: '09:30', end_time: '11:00', subject: 'Advanced Discrete Mathematics', location: 'L1' },
  { day: 'Monday', start_time: '12:00', end_time: '13:00', subject: 'Elective', location: 'L2' },
  { day: 'Monday', start_time: '14:00', end_time: '17:00', subject: 'Deep Learning Lab', location: 'Lab-1' },
  
  { day: 'Tuesday', start_time: '08:00', end_time: '09:30', subject: 'Operating Systems', location: 'L1' },
  { day: 'Tuesday', start_time: '09:30', end_time: '11:00', subject: 'Advanced Machine Learning', location: 'L1' },
  { day: 'Tuesday', start_time: '12:00', end_time: '13:00', subject: 'Elective', location: 'L2' },
  { day: 'Tuesday', start_time: '13:30', end_time: '15:00', subject: 'Operating Systems', location: 'L1' },
  { day: 'Tuesday', start_time: '15:00', end_time: '17:00', subject: 'Advanced Machine Learning Lab', location: 'Lab-2' },
  
  { day: 'Wednesday', start_time: '08:00', end_time: '09:30', subject: 'Deep Learning', location: 'L1' },
  { day: 'Wednesday', start_time: '09:30', end_time: '11:00', subject: 'Operating Systems', location: 'L1' },
  { day: 'Wednesday', start_time: '11:00', end_time: '12:30', subject: 'Advanced Discrete Mathematics', location: 'L1' },
  { day: 'Wednesday', start_time: '13:30', end_time: '15:00', subject: 'Advanced Discrete Mathematics Tutorial', location: 'T1' },
  { day: 'Wednesday', start_time: '15:00', end_time: '17:00', subject: 'Deep Learning Lab', location: 'Lab-1' },
  
  { day: 'Thursday', start_time: '08:00', end_time: '09:30', subject: 'Advanced Machine Learning', location: 'L1' },
  { day: 'Thursday', start_time: '09:30', end_time: '12:30', subject: 'Operating Systems Tutorial', location: 'T1' },
  { day: 'Thursday', start_time: '13:30', end_time: '15:00', subject: 'Advanced Machine Learning Lab', location: 'Lab-2' },
  { day: 'Thursday', start_time: '15:00', end_time: '17:00', subject: 'Elective Lab', location: 'Lab-3' },
  
  { day: 'Friday', start_time: '09:00', end_time: '11:00', subject: 'Contests/Internals', location: 'Exam Hall' },
  { day: 'Friday', start_time: '11:00', end_time: '12:30', subject: 'Leadership Colloquium', location: 'Auditorium' },
  { day: 'Friday', start_time: '15:00', end_time: '17:00', subject: 'Elective Lab', location: 'Lab-3' },
];

async function seedData(env) {
  console.log('Seeding exam data...');
  
  for (const exam of EXAMS) {
    await env.DB.prepare(
      `INSERT INTO events (title, event_date, event_time, type) VALUES (?, ?, ?, ?)`
    ).bind(exam.title, exam.date, '09:00', exam.type).run();
    console.log(`Inserted: ${exam.title} on ${exam.date}`);
  }
  
  console.log('Seeding timetable data...');
  
  for (const slot of TIMETABLE) {
    await env.DB.prepare(
      `INSERT INTO timetable (subject, day_of_week, start_time, end_time, location) VALUES (?, ?, ?, ?, ?)`
    ).bind(slot.subject, slot.day, slot.start_time, slot.end_time, slot.location).run();
    console.log(`Inserted: ${slot.subject} on ${slot.day} ${slot.start_time}-${slot.end_time}`);
  }
  
  console.log('Data seeding complete!');
  console.log(`Total exams: ${EXAMS.length}`);
  console.log(`Total timetable slots: ${TIMETABLE.length}`);
}

export { EXAMS, TIMETABLE, seedData };
