FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN chown -R node:node /app
ENV PORT=7860
EXPOSE 7860
USER node
CMD ["node", "server.js"]
