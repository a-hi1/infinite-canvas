FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3002
# Make global fetch honor HTTP(S)_PROXY for media/CDN pulls (Node 22+ experimental).
ENV NODE_USE_ENV_PROXY=1
EXPOSE 3002

CMD ["npm", "start"]
