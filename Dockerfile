# Brand Kit trên Cloud Run. Node 24 chạy thẳng file .ts nên không có bước build.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

# Chỉ cài dependencies chạy (express). mupdf/pngjs chỉ dùng khi dựng template trên máy.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.ts ./
COPY lib ./lib
COPY public ./public

# Cloud Run tiêm biến PORT; server.ts đọc process.env.PORT
EXPOSE 8080
CMD ["node", "server.ts"]
