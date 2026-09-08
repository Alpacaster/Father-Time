FROM node:20-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Install FFmpeg for audio decoding
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
