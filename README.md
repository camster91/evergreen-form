# Evergreen Form

An embeddable evergreen form system built with Next.js. Designed for lead capture and automated email follow-up workflows.

## Features
- Embeddable form builder
- Email automation integration
- Contact capture and management
- Evergreen scheduling support

## Tech Stack
- Next.js
- React
- TypeScript
- Supabase
- SendGrid / Email service

## Getting Started

```bash
git clone https://github.com/camster91/evergreen-form.git
cd evergreen-form
bun install
bun dev
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SENDGRID_API_KEY`

## Deployment

```bash
bun run build
```
