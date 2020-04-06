FROM node:13.2-alpine

RUN apk update

# Create app directory
WORKDIR /usr/src/app

COPY package*.json ./
COPY index.js .

RUN npm install --only=production

EXPOSE 3000

CMD [ "node", "index.js" ]
