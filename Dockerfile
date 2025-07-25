# Stage 1: Building the application
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package.json and yarn.lock
COPY patches ./patches
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile --ignore-engines

# Copy the rest of the application code
COPY sources ./sources
COPY assets ./assets
COPY modules ./modules
COPY 3rdparty ./3rdparty
COPY app.config.js ./
COPY metro.config.js ./
COPY tsconfig.json ./
COPY public ./public

# Build the Next.js application for web
RUN yarn build-web

# Stage 2: Runtime with Nginx
FROM nginx:alpine AS runner

# Copy the built static files from builder stage to nginx html directory
COPY --from=builder /app/dist /usr/share/nginx/html

# Remove default nginx configuration
RUN rm /etc/nginx/conf.d/default.conf

# Create custom nginx configuration directly in the Dockerfile
RUN echo 'server { \
    listen 80; \
    \
    location / { \
        root   /usr/share/nginx/html; \
        index  index.html index.htm; \
        try_files $uri $uri.html $uri/index.html $uri/index.htm $uri/ /index.html /index.htm =404; \
    } \
    \
    error_page 500 502 503 504 /50x.html; \
    location = /50x.html { \
        root /usr/share/nginx/html; \
        try_files $uri @redirect_to_index; \
        internal; \
    } \
    \
    error_page 404 = @handle_404; \
    \
    location @handle_404 { \
        root /usr/share/nginx/html; \
        try_files /404.html @redirect_to_index; \
        internal; \
    } \
    \
    location @redirect_to_index { \
        return 302 /; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Expose the standard nginx port
EXPOSE 80

# Nginx starts automatically in the foreground with CMD ["nginx", "-g", "daemon off;"] 