FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir cryptography
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 8080
CMD ["python","server/app.py"]
