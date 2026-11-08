# For MCP directories (such as Glama) that start a server in a container and talk to it over
# stdio. It runs the Worker locally with `wrangler dev` behind glama/stdio.mjs, so it lists its
# tools and answers calls, but it receives no texts. For real use, deploy the Worker (README.md).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV WRANGLER_SEND_METRICS=false
CMD ["node", "glama/stdio.mjs"]
