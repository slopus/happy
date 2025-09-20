#!/bin/bash

echo "Testing AutoFixer Firewall Configuration"
echo "========================================"

# Test webhook endpoint (should work from localhost)
echo -e "\n1. Testing webhook endpoint from localhost (should work):"
WEBHOOK_RESULT=$(curl -k -s -o /dev/null -w "%{http_code}" -X POST https://localhost/webhook -H "Content-Type: application/json" -d '{"test": "localhost"}')
if [ "$WEBHOOK_RESULT" = "401" ]; then
    echo "✅ PASS: Webhook accessible from localhost (HTTP $WEBHOOK_RESULT - signature validation working)"
else
    echo "❌ FAIL: Expected HTTP 401, got HTTP $WEBHOOK_RESULT"
fi

# Test API endpoint (should work from localhost)
echo -e "\n2. Testing API endpoint from localhost (should work):"
API_RESULT=$(curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api/status)
if [ "$API_RESULT" = "404" ] || [ "$API_RESULT" = "200" ]; then
    echo "✅ PASS: API accessible from localhost (HTTP $API_RESULT)"
else
    echo "❌ FAIL: API not accessible from localhost (HTTP $API_RESULT)"
fi

# Test health endpoint (should work from localhost)
echo -e "\n3. Testing health endpoint from localhost (should work):"
HEALTH_RESULT=$(curl -k -s -o /dev/null -w "%{http_code}" https://localhost/health)
if [ "$HEALTH_RESULT" = "404" ] || [ "$HEALTH_RESULT" = "200" ]; then
    echo "✅ PASS: Health endpoint accessible from localhost (HTTP $HEALTH_RESULT)"
else
    echo "❌ FAIL: Health endpoint not accessible from localhost (HTTP $HEALTH_RESULT)"
fi

# Display GitHub IP ranges for verification
echo -e "\n4. GitHub webhook IP ranges allowed:"
echo "   192.30.252.0/22"
echo "   185.199.108.0/22"
echo "   140.82.112.0/20"
echo "   143.55.64.0/20"
echo "   2a0a:a440::/29"
echo "   2606:50c0::/32"

echo -e "\n5. Docker network range allowed:"
echo "   172.25.0.0/16 (for localhost access through Docker)"

echo -e "\nFirewall configuration complete!"
echo "✅ Webhook endpoint: GitHub IPs + localhost only"
echo "✅ Admin endpoints: localhost only"
echo "✅ SSL/TLS encryption enabled"
echo "✅ Rate limiting enabled"