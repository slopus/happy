FROM node:22-bookworm-slim
RUN mkdir -p /var/lib/abp && chown node:node /var/lib/abp
COPY scripts/browser-poc/fixture/server.mjs /app/server.mjs
RUN chmod 644 /app/server.mjs
USER node
ENV FIXTURE_PORT=8080 CONTROL_PORT=9099 LEDGER_FILE=/var/lib/abp/ledger.jsonl
EXPOSE 8080 9099
CMD ["node", "/app/server.mjs"]
