# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    biber \
    ca-certificates \
    dumb-init \
    ghostscript \
    latexmk \
    texlive-bibtex-extra \
    texlive-fonts-recommended \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-latex-recommended \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --chown=node:node server.js ./server.js
COPY --chown=node:node public ./public
COPY --chown=node:node workspace ./workspace

RUN mkdir -p /app/workspace \
  && chown -R node:node /app/workspace

USER node

EXPOSE 3000
VOLUME ["/app/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
