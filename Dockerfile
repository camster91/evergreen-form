FROM oven/bun:latest

WORKDIR /app

COPY package.json ./
RUN bun install

COPY src ./src

ENV PORT=3000
ENV DB_PATH=/data/submissions.db
ENV LOG_PATH=/data/app.log

# Email config — set via docker run -e
ENV MATON_API_KEY=""
ENV ALERT_EMAIL="cameron@ashbi.ca"
ENV FROM_EMAIL="cameron@ashbi.ca"

# Feature flags
ENV EMAIL_ON_SUBMIT=0
ENV ENABLE_CORS=1
ENV LOG_LEVEL=info

# Rate limiting
ENV RATE_LIMIT_WINDOW_MS=60000
ENV RATE_LIMIT_MAX=5
ENV RATE_LIMIT_CLEANUP_MS=300000

# App credentials — MUST be overridden in production
ENV ADMIN_USER=evergreen
ENV ADMIN_PASS=team2026

EXPOSE 3000

VOLUME ["/data"]

# Bun handles signals well, no tini needed
CMD ["bun", "run", "src/index.ts"]
