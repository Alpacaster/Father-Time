FROM node:20-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Install FFmpeg and build tools for @discordjs/opus
RUN apk add --no-cache ffmpeg python3 make g++ build-base

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
