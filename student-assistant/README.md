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
│  Mistral AI API   │
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
��   (Mistral AI API)      │
│   (src/generator.js)    │
└────────────┬────────────┘
             │
             ▼
┌───────────────────┐
│ Telegram Reply   │
└──────────────────���┘
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Cache/Queue | Cloudflare KV |
| Embeddings | Cloudflare Workers AI (`@cf/baai/bge-base-zh-v1.5`) |
| LLM | Mistral AI (`mistral-large-2411`) |
| Intent Classification | Mistral AI |
| OCR | Cloudflare Workers AI (image models) |
| PDF Parsing | pdf-parse (in-worker) |
| File Storage | Cloudflare KV (base64) |

---

## Setup

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm i -g wrangler`)
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- Mistral AI API Key from [console.mistral.ai](https://console.mistral.ai)

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
MISTRAL_API_KEY=your_mistral_api_key
AI21_API_KEY=your_ai21_key        # optional
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
wrangler secret put MISTRAL_API_KEY
```

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

---

## Supported Queries

| Intent | Example Phrases |
|--------|---------------|
| Schedule (day) | "What do I have tomorrow?", "Wednesday schedule" |
| Schedule (time) | "9 AM tomorrow", "10 o'clock today" |
| Subject filter | "Operating systems on Tuesday", "Deep Learning next week" |
| Exam query | "When is the OS midterm?", "Upcoming exams" |
| Reminder set | "Remind me about DL midterm in 3 days", "Alert me tomorrow at 8" |
| Reminder cancel | "Cancel reminder", "Remove all reminders" |
| Knowledge query | "What is backpropagation?", "Explain gradient descent" |
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
│   ├── generator.js    # Mistral response generation
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