FROM node:22-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /app/data && adduser -D -u 10001 jarvis && chown -R jarvis:jarvis /app
USER jarvis
ENV NODE_ENV=production DATA_DIR=/app/data PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/__health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
