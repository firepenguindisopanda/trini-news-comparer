# Trinidad News Comparer

**Deconstruct slant, framing, and omissions across major Trinidadian news sources.**

An open platform that reveals how different newsrooms cover the same story - powered by a multi-agent NVIDIA NIMs LLM pipeline.

> "When someone shares misinformation that confirms their world view, they are not just passing along bad information - they are participating in a system that rewards intellectual shortcuts over careful analysis, emotional reaction over thoughtful consideration, and tribal loyalty over independent judgement. The algorithm feeds them more of the curated content. This is what researchers call **filter bubbles**."

This tool is not a replacement for reading articles. It is a lens to help you see the editorial choices each newsroom makes - so you can read more critically and compare coverage before forming an opinion.

---

## Architecture

```
User → Express API (202 Accepted)
         │
         ├─ Cache hit? → Return cached result immediately
         │
         └─ Cache miss → Background worker starts
                          │
                          ├─ AgentOrchestrator (NVIDIA NIMs, primary)
                          │   ├─ 1. TopicExpander      (llama-3.1-8b, 30 articles max)
                          │   ├─ 2. ArticleMatcher     (llama-3.1-8b)
                          │   ├─ 3. SourceAnalyst      (llama-3.1-8b, parallel per source, resilient)
                          │   ├─ 4. CrossSourceSynthesizer (llama-3.1-8b)
                          │   └─ 5. Verifier           (llama-3.1-8b)
                          │
                          └─ Programmatic template fallback (no LLM call)
```

### LLM Model Tuning for Performance

The pipeline defaults to **8B-parameter models** for all five agents. This keeps total response time under ~40 seconds on the NVIDIA NIMs API. If you need higher-quality analysis and can tolerate longer wait times, you can switch individual agents back to larger models via environment variables:

| Env Variable | Default | Larger Option | Trade-off |
|---|---|---|---|
| `NVIDIA_EXPANDER_MODEL` | `meta/llama-3.1-8b-instruct` | `meta/llama-3.1-70b-instruct` | 70B is slower (~60s) but may produce more nuanced topic expansion |
| `NVIDIA_MATCHER_MODEL` | `meta/llama-3.1-8b-instruct` | `meta/llama-3.1-70b-instruct` | 70B with 100+ articles can cause 120s+ timeouts; 8B handles 30 articles in ~10s |
| `NVIDIA_ANALYST_MODEL` | `meta/llama-3.1-8b-instruct` | `meta/llama-3.1-70b-instruct` | 8B runs parallel per source (~10s each); 70B may timeout on sources with many articles |
| `NVIDIA_SYNTHESIZER_MODEL` | `meta/llama-3.1-8b-instruct` | `meta/llama-3.1-70b-instruct` | 8B produces concise (~200 token) analysis quickly; 70B generates deeper 3-5 paragraph comparisons |
| `NVIDIA_VERIFIER_MODEL` | `meta/llama-3.1-8b-instruct` | `meta/llama-3.1-70b-instruct` | 8B gives adequate verification for most cases; 70B catches more subtle hallucination |

**To restore the original 70B pipeline with 100 articles**, set:
```env
NVIDIA_MATCHER_MODEL=meta/llama-3.1-70b-instruct
NVIDIA_SYNTHESIZER_MODEL=meta/llama-3.1-70b-instruct
NVIDIA_VERIFIER_MODEL=meta/llama-3.1-70b-instruct
NVIDIA_EXPANDER_MODEL=meta/llama-3.1-70b-instruct
```

You must also increase the HTTP timeout in `src/orchestrator/NvidiaNimsClient.ts` (`timeout: 120_000` → `300_000`) and raise `maxTokens` (line 175, `2048` → `4096`). Expect 2–5 minute total response times.

**To send more than 30 articles to the matcher**, edit the slice in `src/orchestrator/AgentOrchestrator.ts`:
```ts
// Line 196: change 30 to 100 or higher
articles: articles.slice(0, 100)
```
Only do this with the 70B matcher model — the 8B model may produce degraded relevance scores with large batches.

### Key Components

| Component | Role |
|-----------|------|
| **5-Agent Pipeline** | Topic expansion → article matching → per-source analysis → cross-source synthesis → verification |
| **Circuit Breaker** | After 3 consecutive failures the NVIDIA calls fail-fast for 30s, protecting downstream costs |
| **Redis Cache** | Upstash Redis for scraped articles (5min TTL) and comparison results (24h TTL), plus rate limiting |
| **Pusher Channels** | Real-time WebSocket progress events to the frontend for each agent stage |
| **Background Worker** | Separate process that scrapes all sources every 5 minutes to keep the cache warm |

### Tech Stack

- **Backend:** Express.js, TypeScript, esbuild
- **Frontend:** React 19, Vite, Tailwind CSS, Framer Motion
- **LLM:** NVIDIA NIMs API (`llama-3.1-70b`, `llama-3.1-8b`, `nemotron-4-340b`)
- **Cache:** Upstash Redis (REST-based, no TCP needed)
- **Real-Time:** Pusher Channels
- **Deployment:** Render (Web Service + Background Worker)

---

## Prerequisites

- **Node.js** 18+ (tested on 22)
- **NVIDIA NIMs API key** - get one from [build.nvidia.com](https://build.nvidia.com)
- **Upstash Redis** account - [upstash.com](https://upstash.com) (free tier works)
- **Pusher Channels** account - [pusher.com](https://pusher.com) (free tier: 200K messages/day)

---

## Local Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd trinidad-news-comparer
npm install
```

### 2. Configure environment

Copy the example env and fill in your keys:

```bash
cp .env.example .env
```

Required variables:

```env
# NVIDIA NIMs - primary LLM provider for the 5-agent pipeline
NVIDIA_NIM_API_KEY="nvapi-your-key-here"

# Upstash Redis - caching and rate limiting
UPSTASH_REDIS_URL="https://your-endpoint.upstash.io"
UPSTASH_REDIS_TOKEN="your-token"

# Pusher Channels - real-time progress events
PUSHER_APP_ID="your-app-id"
PUSHER_KEY="your-key"
PUSHER_SECRET="your-secret"
PUSHER_CLUSTER="us2"
VITE_PUSHER_KEY="your-key"           # Same as PUSHER_KEY (public, bundled in frontend)
VITE_PUSHER_CLUSTER="us2"
```

### 3. Run in development

Start the web server (with Vite dev middleware):

```bash
npm run dev
```

Visit **http://localhost:3000**

Optionally start the background worker in a separate terminal:

```bash
npm run dev:worker
```

### 4. Verify it works

- Open the browser → you should see the Trinidad News Comparer UI
- Click a preset topic or type a custom search
- The 202 Accepted response starts the 5-agent pipeline
- Progress events stream via Pusher (look for progress bar in the UI)
- After ~15–30s the comparison result renders with source cards

### Building for production

```bash
npm run build
```

Produces three outputs in `dist/`:

| File | Purpose |
|------|---------|
| `dist/index.html` + `assets/` | Frontend SPA (Vite build) |
| `dist/server.cjs` | Express web server |
| `dist/worker.cjs` | Background scrape worker |

---

## Deployment (Render)

This project includes a [`render.yaml`](render.yaml) blueprint for one-click deployment on Render.

### Services

| Service | Plan | Command |
|---------|------|---------|
| **Web** | Starter ($7/mo) | `npm run start` |
| **Worker** | Starter ($7/mo) | `npm run start:worker` |

### Manual Deploy Steps

1. Push your repo to GitHub/GitLab
2. In the Render Dashboard, create a **new Blueprint**
3. Connect your repo - Render auto-detects `render.yaml`
4. Set the environment variables in the Render dashboard (or in `render.yaml`):

   - `NVIDIA_NIM_API_KEY`
   - `UPSTASH_REDIS_URL`
   - `UPSTASH_REDIS_TOKEN`
   - `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER`
   - `VITE_PUSHER_KEY`, `VITE_PUSHER_CLUSTER`
   - `APP_URL` (set to your Render domain, e.g. `https://your-app.onrender.com`)

5. Deploy - Render builds using `npm run build` and starts both services

### Blueprint (render.yaml) Summary

```yaml
services:
  - type: web
    name: trinidad-news-comparer
    env: node
    buildCommand: npm run build
    startCommand: npm run start
    plan: starter

  - type: worker
    name: trinidad-news-comparer-worker
    env: node
    buildCommand: npm run build
    startCommand: npm run start:worker
    plan: starter
```

**Important:** Both services share the same build step. The worker shares the Redis cache with the web service - no additional infrastructure needed.

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NVIDIA_NIM_API_KEY` | Yes | - | NVIDIA NIMs API key |
| `NVIDIA_EXPANDER_MODEL` | No | `meta/llama-3.1-70b-instruct` | Topic expander model |
| `NVIDIA_MATCHER_MODEL` | No | `meta/llama-3.1-70b-instruct` | Article matcher model |
| `NVIDIA_ANALYST_MODEL` | No | `meta/llama-3.1-8b-instruct` | Per-source analyst (parallel) |
| `NVIDIA_SYNTHESIZER_MODEL` | No | `meta/llama-3.1-70b-instruct` | Cross-source synthesizer |
| `NVIDIA_FALLBACK_SYNTHESIZER_MODEL` | No | `nvidia/nemotron-4-340b-instruct` | Fallback for low-confidence syntheses |
| `NVIDIA_VERIFIER_MODEL` | No | `meta/llama-3.1-70b-instruct` | Fact-check and verification |
| `UPSTASH_REDIS_URL` | Yes | - | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_TOKEN` | Yes | - | Upstash Redis auth token |
| `PUSHER_APP_ID` | Yes | - | Pusher Channels app ID |
| `PUSHER_KEY` | Yes | - | Pusher Channels key (public) |
| `PUSHER_SECRET` | Yes | - | Pusher Channels secret |
| `PUSHER_CLUSTER` | No | `us2` | Pusher cluster region |
| `VITE_PUSHER_KEY` | Yes | - | Must match `PUSHER_KEY` (inlined into frontend bundle) |
| `VITE_PUSHER_CLUSTER` | No | `us2` | Must match `PUSHER_CLUSTER` |
| `APP_URL` | No | `http://localhost:3000` | Public URL (for SEO/opengraph) |
| `WORKER_SCRAPE_INTERVAL_MINUTES` | No | `5` | Background scrape interval |

---

## Limitations & Disclaimer

- **This is NOT a replacement for reading full articles.** AI summaries provide a starting point - always click through to the original source.
- **We do not determine which source is "right."** Every newsroom has an editorial perspective. This tool surfaces differences so you can judge for yourself.
- **We do not display full article text.** Copyright belongs to the respective news organisations.
- **AI analysis quality varies.** LLMs can hallucinate, miss nuance, or mischaracterise tone. Treat the analysis as a suggestive lens, not definitive truth.
- **Caveat lector** - let the reader beware. Cross-reference what you see here with the actual reporting.

---

## Project Structure

```
├── server.ts                  # Express web server entry point
├── worker.ts                  # Background scrape worker
├── scraper.ts                 # RSS/DOM scraping engine
├── server/
│   └── services/
│       ├── cache.ts           # Upstash Redis cache service
│       ├── pusher.ts          # Pusher Channels real-time events
│       └── comparisonRunner.ts # Async comparison runner (orchestrator + fallback)
├── src/
│   ├── App.tsx                # Main React application
│   ├── types.ts               # Shared TypeScript types
│   ├── components/
│   │   ├── NewsSourceCard.tsx  # Source comparison card
│   │   └── AboutDrawer.tsx     # About/transparency slide-out
│   ├── hooks/
│   │   └── useComparisonJob.ts # Pusher progress hook
│   └── orchestrator/
│       ├── AgentOrchestrator.ts  # 5-agent NVIDIA pipeline manager
│       ├── CircuitBreaker.ts     # Circuit breaker pattern
│       ├── NvidiaNimsClient.ts   # NVIDIA NIMs API client
│       └── prompts.ts            # Agent system prompts
├── render.yaml                # Render deployment blueprint
├── .env.example               # Environment template
├── package.json
└── tsconfig.json
```

---

## License

MIT - use freely, attribute kindly.
