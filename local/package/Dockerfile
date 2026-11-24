# Spotlight local server in a container (for a mini-PC, NAS or Raspberry Pi).
#   docker build -t spotlight .
#   docker run -d --name spotlight --restart unless-stopped -p 8787:8787 -v spotlight-data:/data spotlight
#   docker logs spotlight        <- shows the first admin password
# Then open http://<this machine's IP>:8787 on every device.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY worker/package.json worker/package.json
COPY worker/src worker/src
COPY local/runtime.mjs local/server.mjs local/
COPY public public
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8787
CMD ["node", "local/server.mjs"]
