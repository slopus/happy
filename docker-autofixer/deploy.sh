#!/bin/bash

# GitHub AutoFixer Deployment Script

set -e

echo "🚀 Deploying GitHub AutoFixer System..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
print_status "Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed!"
    exit 1
fi

if ! docker compose version &> /dev/null; then
    print_error "Docker Compose is not available!"
    exit 1
fi

print_success "Prerequisites check passed"

# Create environment file if it doesn't exist
if [ ! -f .env ]; then
    print_warning ".env file not found, creating from example..."
    cp .env.example .env
    print_warning "Please edit .env file with your actual credentials before proceeding"
    read -p "Press Enter to continue after editing .env file..."
fi

# Create necessary directories
print_status "Creating necessary directories..."
mkdir -p workspace logs ssl

# Make scripts executable
chmod +x scripts/*.sh

# Pull latest images
print_status "Pulling latest Docker images..."
docker compose pull

# Build the autofixer image
print_status "Building AutoFixer image..."
docker compose build autofixer

# Start the services
print_status "Starting services..."
docker compose up -d

# Wait for services to be ready
print_status "Waiting for services to be ready..."
sleep 30

# Check health
print_status "Checking service health..."

# Check AutoFixer
if curl -f -s http://localhost:3000/health > /dev/null; then
    print_success "AutoFixer service is healthy"
else
    print_error "AutoFixer service is not responding"
    docker compose logs autofixer
    exit 1
fi

# Check SonarQube
if curl -f -s http://localhost:9000 > /dev/null; then
    print_success "SonarQube service is healthy"
else
    print_warning "SonarQube service is still starting up (this can take a few minutes)"
fi

# Display status
print_status "Service status:"
docker compose ps

print_success "Deployment completed successfully!"

echo ""
echo "📊 Service URLs:"
echo "   AutoFixer API: http://localhost:3000"
echo "   Health Check:  http://localhost:3000/health"
echo "   Status:        http://localhost:3000/status"
echo "   Webhook:       http://localhost:3000/webhook"
echo "   SonarQube:     http://localhost:9000"
echo "   Grafana:       http://localhost:3001 (admin/admin)"
echo "   Prometheus:    http://localhost:9090"

echo ""
echo "🔧 Management Commands:"
echo "   View logs:     docker compose logs -f"
echo "   Stop services: docker compose down"
echo "   Restart:       docker compose restart"
echo "   Update:        ./deploy.sh"

echo ""
echo "🌐 GitHub Webhook URL:"
echo "   http://your-server:3000/webhook"
echo ""
echo "📝 Next Steps:"
echo "   1. Configure GitHub webhook to point to your server"
echo "   2. Set GITHUB_TOKEN and WEBHOOK_SECRET in .env"
echo "   3. Create RC.txt with 'Ready' in your repository"
echo "   4. Push commits to trigger automated fixing"

print_success "GitHub AutoFixer is ready to use!"