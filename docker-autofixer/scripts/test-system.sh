#!/bin/bash

# Test script for GitHub AutoFixer system

set -e

echo "Testing GitHub AutoFixer system..."

# Test health endpoint
echo "Testing health endpoint..."
curl -f http://localhost:3000/health || {
    echo "Health check failed!"
    exit 1
}

# Test status endpoint
echo "Testing status endpoint..."
curl -f http://localhost:3000/status || {
    echo "Status check failed!"
    exit 1
}

# Test manual trigger with sample repository
echo "Testing manual trigger..."
curl -X POST http://localhost:3000/trigger \
    -H "Content-Type: application/json" \
    -d '{
        "repoUrl": "https://github.com/jeffersonwarrior/happy-fork.git",
        "branch": "main"
    }' || {
    echo "Manual trigger test failed!"
    exit 1
}

echo "All tests passed!"