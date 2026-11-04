FROM node:24-alpine
RUN apk add --no-cache python3 py3-pip make g++
RUN python3 -m venv /opt/pdf && /opt/pdf/bin/pip install --no-cache-dir pypdf==6.10.0
ENV PDF_PYTHON=/opt/pdf/bin/python
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p uploads
EXPOSE 3001
CMD ["node", "src/index.js"]
