# Stage 1: Building the application
FROM node:20-alpine AS builder

# Build argument for PostHog API key with default empty value
ARG POSTHOG_API_KEY=""
ARG REVENUE_CAT_STRIPE=""

WORKDIR /app

# Copy package.json and yarn.lock
COPY patches ./patches
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile --ignore-engines

# Copy the rest of the application code
COPY sources ./sources
COPY public ./public
COPY * ./

# Build the application for web in production mode
ENV NODE_ENV=production
ENV APP_ENV=production
ENV EXPO_PUBLIC_POSTHOG_API_KEY=$POSTHOG_API_KEY
ENV EXPO_PUBLIC_REVENUE_CAT_STRIPE=$REVENUE_CAT_STRIPE
RUN yarn expo export --platform web --output-dir dist

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