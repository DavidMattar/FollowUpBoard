FROM node:22-slim
WORKDIR /app
RUN chown node:node /app
# Roda como usuario sem privilegios (o "node" ja vem na imagem), nao como root.
USER node
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
ENV NODE_ENV=production TZ=America/Sao_Paulo
EXPOSE 3000
CMD ["node", "server.js"]
