FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    iproute2 \
    iptables \
    procps \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

COPY canary/container-entrypoint.sh /usr/local/bin/chatgpt-web-canary-entrypoint
RUN chmod 0755 /usr/local/bin/chatgpt-web-canary-entrypoint

ENTRYPOINT ["/usr/local/bin/chatgpt-web-canary-entrypoint"]
