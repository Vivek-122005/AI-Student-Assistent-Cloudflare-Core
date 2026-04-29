import * as db from './db.js';
import { ingestNote } from './knowledge.js';

function shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function seedDemo(env) {
  const summary = { events: [], subjects: [], profile: null, notes: [] };

  // 1) Insert exam events into D1 (idempotent by title+date)
  const exams = [
    { code: 'CSA334', title: 'Computer Graphics', date: '2026-05-18' },
    { code: 'CSA326', title: 'Machine Learning', date: '2026-05-19' },
    { code: 'CSA332', title: 'Operating Systems', date: '2026-05-20' },
    { code: 'CSA325', title: 'Advanced Databases', date: '2026-05-21' },
    { code: 'BUE212', title: 'Business Ethics', date: '2026-05-22' },
    { code: 'CSA331', title: 'Distributed Systems', date: '2026-05-23' },
    { code: 'CSA333', title: 'Compiler Design', date: '2026-05-24' }
  ];

  try {
    const existing = await db.getAllEvents(env);
    for (const e of exams) {
      const title = `${e.code} - ${e.title} Exam`;
      const already = existing.find(r => r.event_date === e.date && String(r.title).includes(e.code));
      if (already) {
        summary.events.push({ inserted: false, reason: 'exists', title, date: e.date });
        continue;
      }
      const id = await db.addEvent(env, title, e.date, '10:00 AM - 1:00 PM', 'exam', `Semester exam for ${e.title}`);
      summary.events.push({ inserted: true, id, title, date: e.date });
    }
  } catch (err) {
    summary.eventsError = err.message;
  }

  // 2) Subject registry (KV)
  const subjects = [
    { code: 'AML', name: 'Applied Machine Learning', category: 'Major' },
    { code: 'ADM', name: 'Advanced Data Mining', category: 'Major' },
    { code: 'OS', name: 'Operating Systems', category: 'Core' },
    { code: 'DL', name: 'Deep Learning', category: 'Elective' },
    { code: 'DevOps', name: 'DevOps Practices', category: 'Elective' }
  ];

  try {
    await env.NOTES_KV.put('subjects:registry', JSON.stringify(subjects));
    summary.subjects = subjects;
  } catch (err) {
    summary.subjectsError = err.message;
  }

  // 3) Student profile (KV)
  const profile = {
    userId: 'vivek',
    enrolmentNo: '230119',
    name: 'vivek',
    semester: 6,
    cgpa: 8.0,
    branch: 'Computer Science and AI',
    createdAt: new Date().toISOString()
  };

  try {
    await env.NOTES_KV.put(`profile:${profile.userId}`, JSON.stringify(profile));
    summary.profile = { stored: true, key: `profile:${profile.userId}` };
  } catch (err) {
    summary.profileError = err.message;
  }

  // 4) Notes dataset and ingestion (chunking + embeddings)
  const demoNotes = {
    'Applied Machine Learning': `Applied Machine Learning (AML) — Core concepts and exam-focused summary.\n\nTopics:\n- Supervised learning: regression, classification, evaluation metrics (accuracy, precision, recall, F1).\n- Unsupervised learning: clustering, dimensionality reduction (PCA).\n- Model selection: cross-validation, bias-variance tradeoff.\n- Practical tips: feature scaling, regularization (L1/L2), hyperparameter tuning.\n\nExam tips:\n- Show formula for linear regression and gradient descent.\n- Explain difference between overfitting and underfitting.\n`,

    'Advanced Data Mining': `Advanced Data Mining (ADM) — concise notes.\n\nTopics:\n- Association rule mining: Apriori algorithm, support, confidence, lift.\n- Frequent pattern mining and sequence mining.\n- Graph mining basics and community detection.\n\nExam tips:\n- Write steps of Apriori and compute support/confidence for examples.\n`,

    'Operating Systems': `Operating Systems (OS) — important concepts and summaries.\n\nTopics:\n- Processes and threads, concurrency, synchronization (mutexes, semaphores).\n- CPU scheduling algorithms: FCFS, SJF, Round Robin, Priority scheduling.\n- Memory management: paging, segmentation, virtual memory, TLBs.\n- File systems and I/O basics.\n\nExam tips:\n- Compare scheduling algorithms and their tradeoffs.\n- Draw diagrams for paging and virtual memory.\n`,

    'Deep Learning': `Deep Learning (DL) — compact guide.\n\nTopics:\n- Neural networks basics: forward/backpropagation, activation functions.\n- CNNs for vision, RNNs/LSTM for sequences, Transformers for attention.\n- Training tips: learning rate schedules, batch normalization, dropout.\n\nExam tips:\n- Explain backpropagation at high level and list common optimizers.\n`,

    'DevOps Practices': `DevOps Practices — overview for engineers.\n\nTopics:\n- CI/CD pipelines, containerization (Docker), orchestration (Kubernetes).\n- Infrastructure as code, monitoring, logging, and observability.\n- Testing strategies and deployment rollbacks.\n\nExam tips:\n- Describe a CI pipeline and benefits of containerization.\n`
  };

  try {
    for (const [subject, text] of Object.entries(demoNotes)) {
      try {
        const res = await ingestNote(env, text, subject, { noteId: `demo-${subject.replace(/\s+/g, '-')}-${shortId()}`, sourceType: 'seed' });
        summary.notes.push({ subject, noteId: res.noteId, chunkCount: res.chunkCount, embeddedCount: res.embeddedCount });
      } catch (err) {
        summary.notes.push({ subject, error: err.message });
      }
    }
  } catch (err) {
    summary.notesError = err.message;
  }

  return summary;
}

export default seedDemo;
