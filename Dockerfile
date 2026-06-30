# Stage 1: Build the frontend React app
FROM node:18-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
COPY packages/frontend/package*.json ./packages/frontend/
RUN npm ci --workspace=castpay-frontend
COPY packages/frontend ./packages/frontend
RUN npm run build --workspace=castpay-frontend

# Stage 2: Build the backend Express server
FROM node:18-alpine AS backend-builder
WORKDIR /app
COPY package*.json ./
COPY packages/backend/package*.json ./packages/backend/
RUN npm ci --workspace=castpay-backend
COPY packages/backend ./packages/backend
RUN npm run build --workspace=castpay-backend

# Stage 3: Runner stage
FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY packages/backend/package*.json ./packages/backend/
RUN npm ci --only=production --workspace=castpay-backend

COPY --from=backend-builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=frontend-builder /app/packages/frontend/dist ./packages/frontend/dist

EXPOSE 3001

CMD ["node", "packages/backend/dist/server.js"]
