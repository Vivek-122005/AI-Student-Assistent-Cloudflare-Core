# AI Student Assistant

A production-ready Telegram bot that combines **natural language understanding**, **retrieval-augmented generation (RAG)**, and **Cloudflare Workers AI** to give students instant answers about their academic schedule, class timetables, exam dates, and personal reminders.

---

## Features

| Feature | Description |
|---------|-------------|
| **Natural Language Scheduling** | Ask things like "What do I have tomorrow?" or "Next Wednesday's operating systems lecture" |
| **Personal Reminders** | Set reminders for any subject or event: "Remind me about the OS midterm in 3 days" |
| **Weekly Timetable** | Get your full or filtered weekly schedule |
| **Exam Calendar** | View upcoming exams with dates and times |
| **Knowledge Base (RAG)** | Ingest lecture notes, PDFs, and images — chat with your notes |
| **Daily Briefing** | Automatic 7 AM reminder of the day's schedule |
| **Multimodal Ingestion** | Upload PDF slides or images with embedded text |
| **Secure** | User whitelisting, rate limiting, and input sanitization |
| **Student Profile Q&A** | Answer "What is my CGPA?", "Which semester am I in?", and "What is my branch?" from stored KV profile data |

---

## Architecture

```
User Message (Telegram)
        │
        ▼
┌───────────────────┐
│  Telegram Webhook  │
│   (src/telegram.js)│
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Intent Classifier │
│ Cloudflare Workers AI │
│ (src/router.js)   │
└────────┬──────────┘
         │
    ┌────┴──────────────────────┐
    ▼                              ▼
┌─────────┐                 ┌──────────┐
│ Schedule│                 │  Knowledge│
│  Query  │                 │   Query  │
│(D1 + KV)│                 │ (RAG +   │
└────┬────┘                 │Vectorize)│
     │                      └────┬─────┘
     └────────────┬───────────────┘
                  ▼
┌─────────────────────────┐
│   Response Generator   │
│ Cloudflare Workers AI (Llama-3.1 instruct) │
│   (src/generator.js)    │
└────────────┬────────────┘
             │
             ▼
┌───────────────────┐
│ Telegram Reply   │
└───────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Cache/Queue | Cloudflare KV |
| Embeddings | Cloudflare Workers AI (`@cf/baai/bge-large-en-v1.5`) |
| LLM | Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) |
| Intent Classification | Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) |
| OCR | Cloudflare Workers AI (image models) |
| PDF Parsing | pdf-parse (in-worker) |
| File Storage | Cloudflare KV (base64) |

---

## Setup

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm i -g wrangler`)
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- Gemini API Key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- Cloudflare account with Workers AI, D1, KV, and Vectorize enabled

### Installation

```bash
cd student-assistant
npm install
```

### Configuration

1. Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

```env
# .env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
GEMINI_API_KEY=your_gemini_api_key
USER_TIMEZONE=Asia/Kolkata        # your timezone
```

2. Update `wrangler.toml` with your account ID:

```toml
name = "student-assistant"
compatibility_date = "2025-01-01"
account_id = "YOUR_CLOUDFLARE_ACCOUNT_ID"
```

3. Create the D1 database:

```bash
wrangler d1 create student-db
```

4. Add the `[[d1_databases]]` binding to `wrangler.toml`. The output of the create command will include the binding config — paste it in.

5. Apply the schema:

```bash
wrangler d1 execute student-db --file=./schema.sql --remote
```

6. Create the KV namespace:

```bash
wrangler kv:namespace create SCHEDULER_KV
```

7. Add the `[[kv_namespaces]]` binding to `wrangler.toml`.

8. Create the Vectorize index:

```bash
wrangler vectorsize create student-knowledge-index --dimensions=768 --metric=cosine
```

9. Add the `[[vectorize]]` binding to `wrangler.toml`.

10. Set secrets:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put GEMINI_API_KEY
```

### PDF Ingestion via Gemini

The Worker supports PDF extraction through Gemini document input.

- Upload PDF from Telegram
- Worker downloads file via Telegram file API
- Worker sends PDF bytes to Gemini (`models/gemini-flash-latest`)
- Gemini returns clean markdown text
- Worker stores raw text and chunked text in KV
- Worker generates embeddings via Workers AI and stores vectors in Vectorize

Configurable vars in `wrangler.toml`:

- `GEMINI_MODEL` (default: `models/gemini-flash-latest`)
- `PDF_MAX_BYTES` (default: 10MB)
- `GEMINI_TIMEOUT_MS` (default: 45s)
- `GEMINI_RATE_LIMIT_WINDOW_SEC` and `GEMINI_RATE_LIMIT_MAX`
- `PDF_CACHE_TTL_SEC`

Debug & Admin endpoints:

**Debug:**
- `GET /debug/gemini-test` or `GET /debug/gemini-validate` checks Gemini from the Worker runtime
- `GET /debug/gemini-key` returns a masked key summary for secret verification
- `POST /debug/pdf-test` accepts `{ "pdfBase64": "..." }` and runs the PDF ingestion pipeline
- `GET /debug/vector-test` runs a small retrieval query against Vectorize

**Admin:**
- `GET /admin/seed-demo?secret=<TELEGRAM_TOKEN>` populates demo data (exams, subjects, student profile, notes + embeddings) for demonstrations and testing. Returns a JSON summary of what was seeded.

Common issues:

- `API_KEY_INVALID`: re-upload the secret in Cloudflare, then confirm the key has no restrictive application/IP rules in Google AI Studio
- `404` on generateContent: use the full model id in `models/...` form and make sure the model supports `generateContent`
- Timeout or large-file failures: split the PDF or lower the file size before ingestion
- Empty extraction result: the PDF may be image-only or too sparse; use a text-based PDF or OCR first

### Seeding Demo Data

To populate the system with demo academic data for testing or demonstrations, call:

```bash
curl "https://<your-worker-url>/admin/seed-demo?secret=<TELEGRAM_TOKEN>"
```

This will seed:
- **Exam Schedule** → D1 events table (May 2026, 7 exams across major subjects)
- **Subject Registry** → KV (AML, ADM, OS, DL, DevOps with codes and categories)
- **Student Profile** → KV under `profile:vivek` (semester 6, CGPA 8.0, Computer Science and AI)
- **Study Notes** → KV + Vectorize (chunked, embedded notes for each subject, ready for RAG queries)

Once seeded, the bot will answer questions like:
- "What is my CGPA?"
- "When is my OS exam?"
- "Summarize AML notes"
- "Explain CPU scheduling"

**Note:** The seeding endpoint is guarded by your `TELEGRAM_TOKEN` secret. Requires authentication.

To persist optional ingestion metadata, re-run schema migration:

```bash
wrangler d1 execute student-db --file=./schema.sql --remote
```

### Gemini setup checklist

1. Create a key in Google AI Studio.
2. Keep application restrictions off while testing from Cloudflare Workers.
3. Make sure API restrictions allow the Generative Language API.
4. Upload the key with `wrangler secret put GEMINI_API_KEY`.
5. Verify `GET /debug/gemini-test` returns HTTP 200 before testing PDFs.

### Deploy

```bash
npx wrangler deploy
```

### Set Telegram Webhook

Replace `YOUR_BOT_TOKEN` and `YOUR_WORKER_URL`:

```bash
curl -X POST "https://api.telegram.org/YOUR_BOT_TOKEN/setWebhook?url=https://YOUR_WORKER.workers.dev/telegram"
```

Verify:

```bash
curl "https://api.telegram.org/YOUR_BOT_TOKEN/getWebhookInfo"
```

---

## Database Schema

### timetable

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment ID |
| subject | TEXT NOT NULL | Subject name |
| day_of_week | TEXT NOT NULL | Day (Monday–Friday) |
| start_time | TEXT NOT NULL | Start time (HH:MM) |
| end_time | TEXT NOT NULL | End time (HH:MM) |
| location | TEXT | Room/lab location |
| created_at | DATETIME | Creation timestamp |

### events

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment ID |
| title | TEXT NOT NULL | Event title |
| event_date | TEXT | Date (YYYY-MM-DD) |
| event_time | TEXT | Time (HH:MM) |
| type | TEXT DEFAULT 'event' | Type: exam, assignment, etc. |

### reminders

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment ID |
| user_id | TEXT NOT NULL | Chat ID |
| content | TEXT NOT NULL | Reminder message |
| remind_at | TEXT NOT NULL | ISO timestamp |
| status | TEXT DEFAULT 'pending' | pending/sent/cancelled |
| message_id | INTEGER | Telegram message ID |
| created_at | DATETIME | Creation timestamp |

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/telegram` | POST | Telegram webhook receiver |
| `/telegram/setwebhook` | GET | Set webhook for Telegram |
| `/reminders/cron` | GET | Cron trigger for reminders (internal) |
| `/ingest` | POST | Ingest notes endpoint |
| `/health` | GET | Health check |
| `/admin/seed-demo` | POST | Idempotently seeds demo exams, student profile, subject registry, and structured study notes (including embedding/index creation for RAG) |
| `/admin/test-demo-queries` | POST | Runs demo validation queries end-to-end and returns the bot responses as JSON |

---

## Supported Queries

| Intent | Example Phrases |
|--------|---------------|
| Schedule (day) | "What do I have tomorrow?", "Wednesday schedule" |
| Schedule (time) | "9 AM tomorrow", "10 o'clock today" |
| Subject filter | "Operating systems on Tuesday", "Deep Learning next week" |
| Exam query | "When is the OS midterm?", "Upcoming exams", "What are my upcoming exams?" |
| Exam time (course-specific) | "When is my OS exam?", "When is my AML exam?" |
| Reminder set | "Remind me about DL midterm in 3 days", "Alert me tomorrow at 8" |
| Reminder cancel | "Cancel reminder", "Remove all reminders" |
| Knowledge query | "What is backpropagation?", "Explain gradient descent" |
| Student profile | "What is my CGPA?", "Which semester am I in?", "What is my branch?" |
| Summaries | "Summarize OS notes", "Summarize AML in short" |
| Schedule add | "Add operating systems tomorrow 9 AM L1" |
| Note ingest | "Ingest this file" (with file attachment) |
| Help | "Help", "/start", "/help" |

---

## Scheduled Jobs

| Cron | Job |
|------|-----|
| `*/30 * * * *` | Process pending reminders |
| `0 7 * * *` | Send daily schedule briefing |

---

## Project Structure

```
student-assistant/
├── src/
│   ├── index.js          # Worker entry point
│   ├── telegram.js      # Telegram webhook handler
│   ├── router.js       # Intent classification + routing
│   ├── db.js           # D1 database operations
│   ├── knowledge.js    # Knowledge ingestion + RAG
│   ├── retriever.js    # Vectorize retrieval
│   ├── generator.js    # Workers AI (Llama-3.1) response generation
│   ├── reminders.js    # Reminder processing
│   ├── wiki.js         # Wikipedia enrichment
│   ├── date_parser.js  # NL date resolution
│   ├── file_processor.js # Multimodal file processing
│   ├── pdf_text_extractor.js
│   └── image_ocr.js
├── schema.sql
├── wrangler.toml
├── package.json
└── README.md
```

---

## License

MIT