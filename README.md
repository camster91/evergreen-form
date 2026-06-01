# Evergreen Form 🥣

**Free Sample Order Form & Fulfillment Dashboard** — A lightweight, self-contained server for the Evergreen food brand's free sample program. Customers submit their details to receive product samples, and the admin dashboard manages order fulfillment from pending to delivery.

Built with **Bun + Elysia** and **SQLite** — zero external database required.

---

## Overview

This app provides two interfaces:

1. **Customer-facing form** — A branded, mobile-friendly form (routed at `/`) where customers enter their name, address, email, and preferred delivery window to request free Evergreen product samples.

2. **Admin dashboard** — A password-protected dashboard (`/admin`) for fulfillment staff to track, update, and export submissions through a defined workflow: **Pending → Preparing → Shipped → Delivered** (with **Cancelled** for exceptions).

---

## Features

### Customer Form
- Clean, branded UI with Fredoka font and Evergreen coral (#F06464) color scheme
- Delivery window selection: Tuesday 9-11am, Tuesday 4-6pm, Thursday 9-11am, Thursday 4-6pm
- Marketing opt-in checkbox (Klaviyo-compatible)
- Shopify-embeddable via iframe (with embed instructions page)
- Mobile responsive design

### Anti-Spam & Security
- Per-IP rate limiting (configurable window/max)
- Daily submission cap per IP (10/day)
- Honeypot field to catch bots
- Duplicate detection (same email + address on same day)
- Email validation (RFC 5322-ish)
- Content Security Policy headers
- Frame-ancestors CSP for Shopify embedding

### Admin Dashboard
- HTTP Basic Auth protected
- View all submissions with status badges
- Status management: Pending, Preparing, Shipped, Delivered, Cancelled
- **Bulk actions** — select multiple rows, apply status updates, or delete
- **Inline editing** — edit any submission fields directly in a modal
- **Filters** — filter by status or delivery window
- Filter combinability (window + status at the same time)
- Stats overview: total, today, pending, fulfilled, errors, uptime
- Quick "Ship" button per row for fast fulfillment

### CSV Export
- Downloads all submissions in CSV format (Klaviyo-friendly columns)
- Includes: first name, last name, email, phone, address, city, region, zip, country, status, opt-in, date

### Monitoring & Alerts
- Health check endpoints (`/health`, `/api/health`) for Traefik/monitoring
- Email alerts via Maton API on errors and new submissions (configurable)
- Structured logging with log rotation (configurable max file size)
- SQLite integrity checks (hourly)
- Request/response metrics (counts, timings)

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | [Bun](https://bun.sh/) |
| **Framework** | [Elysia](https://elysiajs.com/) (TypeScript) |
| **Database** | SQLite via `bun:sqlite` (zero config, WAL mode) |
| **Email** | [Maton API](https://maton.ai) (Gmail send) |
| **Auth** | HTTP Basic Auth with timing-safe credential comparison |
| **Deployment** | Docker (included), runs on Coolify |

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (latest)
- No external database or services required (SQLite is built-in)

### Installation

```bash
# Clone
git clone https://github.com/camster91/evergreen-form.git
cd evergreen-form

# Install dependencies
bun install

# Configure environment
cp .env.example .env
# Edit .env — see below for required variables
```

### Running

```bash
# Development (with file watching)
bun run src/index.ts

# Production
bun run start    # alias for: bun run src/index.ts
```

The server starts on port 3000 by default (configurable via `PORT`).

### Docker

```bash
# Build
bun run docker:build

# Run (with persistent SQLite volume)
bun run docker:run
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Server port |
| `ADMIN_USER` | **Yes** | — | Username for admin dashboard |
| `ADMIN_PASS` | **Yes** | — | Password for admin dashboard |
| `DB_PATH` | No | `/data/submissions.db` | SQLite database file path |
| `MATON_API_KEY` | No | — | Maton API key for email alerts |
| `ALERT_EMAIL` | No | `cameron@ashbi.ca` | Email to receive alerts |
| `FROM_EMAIL` | No | `cameron@ashbi.ca` | Sender email for alerts |
| `EMAIL_ON_SUBMIT` | No | `0` | Send email alert on each submission (`1` to enable) |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | No | `5` | Max requests per window per IP |
| `LOG_PATH` | No | `/data/app.log` | Log file path |
| `MAX_LOG_SIZE_MB` | No | `10` | Max log size before rotation |
| `LOG_LEVEL` | No | `info` | Log level (debug, info, warn, error) |
| `ENABLE_CORS` | No | `1` | Set to `0` to disable CORS |

---

## API / Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | None | Customer submission form |
| `POST` | `/submit` | None | Submit a sample request |
| `GET` | `/admin` | Basic | Admin fulfillment dashboard |
| `GET` | `/export` | Basic | Download CSV export |
| `GET` | `/embed` | None | iframe embed instructions page |
| `GET` | `/health` | None | Health check (JSON) |
| `GET` | `/api/health` | None | Health check alias |
| `PATCH` | `/api/status` | Basic | Update submission status |
| `PATCH` | `/api/notes` | Basic | Update submission notes |
| `PATCH` | `/api/submission/:id` | Basic | Edit submission fields |
| `DELETE` | `/api/submission/:id` | Basic | Delete a single submission |
| `POST` | `/api/bulk-status` | Basic | Bulk status update |
| `POST` | `/api/bulk-delete` | Basic | Bulk delete |

---

## License

Proprietary — All rights reserved.

---

**For support, contact cameron@ashbi.ca**
