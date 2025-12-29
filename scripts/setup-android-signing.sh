#!/bin/bash
#
# Setup Android signing keystore and configure GitHub Actions secrets
#
# Usage: ./scripts/setup-android-signing.sh [--repo owner/repo]
#
# This script will:
# 1. Generate a new Android signing keystore (if not exists)
# 2. Set up GitHub Actions secrets for release signing
#
# Requirements:
# - keytool (comes with JDK)
# - gh CLI (authenticated)
# - base64
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
KEYSTORE_PATH="android-release.keystore"
KEY_ALIAS="happy-release"
VALIDITY_DAYS=10000

# Parse arguments
REPO=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --repo)
            REPO="$2"
            shift 2
            ;;
        --keystore)
            KEYSTORE_PATH="$2"
            shift 2
            ;;
        --alias)
            KEY_ALIAS="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [--repo owner/repo] [--keystore path] [--alias key-alias]"
            echo ""
            echo "Options:"
            echo "  --repo      GitHub repository (e.g., owner/repo). Auto-detected if not provided."
            echo "  --keystore  Path for the keystore file (default: android-release.keystore)"
            echo "  --alias     Key alias name (default: happy-release)"
            echo "  -h, --help  Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Check requirements
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}Error: $1 is required but not installed.${NC}"
        exit 1
    fi
}

check_command keytool
check_command gh
check_command base64

# Check gh auth status
if ! gh auth status &> /dev/null; then
    echo -e "${RED}Error: GitHub CLI is not authenticated. Run 'gh auth login' first.${NC}"
    exit 1
fi

# Auto-detect repo if not provided
if [ -z "$REPO" ]; then
    REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
    if [ -z "$REPO" ]; then
        echo -e "${RED}Error: Could not detect repository. Use --repo owner/repo${NC}"
        exit 1
    fi
    echo -e "${GREEN}Detected repository: ${REPO}${NC}"
fi

echo ""
echo -e "${YELLOW}=== Android Signing Setup ===${NC}"
echo ""

# Generate keystore if it doesn't exist
if [ -f "$KEYSTORE_PATH" ]; then
    echo -e "${YELLOW}Keystore already exists at ${KEYSTORE_PATH}${NC}"
    read -p "Do you want to use the existing keystore? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Please remove the existing keystore or specify a different path with --keystore${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}Generating new Android signing keystore...${NC}"
    echo ""

    # Prompt for passwords
    read -s -p "Enter keystore password (min 6 characters): " KEYSTORE_PASSWORD
    echo
    read -s -p "Confirm keystore password: " KEYSTORE_PASSWORD_CONFIRM
    echo

    if [ "$KEYSTORE_PASSWORD" != "$KEYSTORE_PASSWORD_CONFIRM" ]; then
        echo -e "${RED}Error: Passwords do not match${NC}"
        exit 1
    fi

    if [ ${#KEYSTORE_PASSWORD} -lt 6 ]; then
        echo -e "${RED}Error: Password must be at least 6 characters${NC}"
        exit 1
    fi

    read -s -p "Enter key password (press Enter to use same as keystore): " KEY_PASSWORD
    echo

    if [ -z "$KEY_PASSWORD" ]; then
        KEY_PASSWORD="$KEYSTORE_PASSWORD"
    fi

    # Prompt for certificate details
    echo ""
    echo "Enter certificate details (press Enter for defaults):"
    read -p "  Common Name (CN) [Happy App]: " CN
    CN=${CN:-"Happy App"}
    read -p "  Organization (O) [Happy]: " O
    O=${O:-"Happy"}
    read -p "  Country (C) [US]: " C
    C=${C:-"US"}

    # Generate the keystore
    keytool -genkeypair \
        -v \
        -storetype PKCS12 \
        -keystore "$KEYSTORE_PATH" \
        -alias "$KEY_ALIAS" \
        -keyalg RSA \
        -keysize 2048 \
        -validity $VALIDITY_DAYS \
        -storepass "$KEYSTORE_PASSWORD" \
        -keypass "$KEY_PASSWORD" \
        -dname "CN=${CN}, O=${O}, C=${C}"

    echo ""
    echo -e "${GREEN}Keystore generated successfully at ${KEYSTORE_PATH}${NC}"
fi

# If we used an existing keystore, prompt for passwords
if [ -z "$KEYSTORE_PASSWORD" ]; then
    read -s -p "Enter keystore password: " KEYSTORE_PASSWORD
    echo
    read -s -p "Enter key password (press Enter if same as keystore): " KEY_PASSWORD
    echo
    if [ -z "$KEY_PASSWORD" ]; then
        KEY_PASSWORD="$KEYSTORE_PASSWORD"
    fi
fi

# Encode keystore to base64
echo ""
echo -e "${GREEN}Encoding keystore to base64...${NC}"
KEYSTORE_BASE64=$(base64 -w 0 "$KEYSTORE_PATH" 2>/dev/null || base64 -i "$KEYSTORE_PATH")

# Set GitHub secrets
echo ""
echo -e "${GREEN}Setting GitHub Actions secrets for ${REPO}...${NC}"
echo ""

echo "$KEYSTORE_BASE64" | gh secret set ANDROID_KEYSTORE_BASE64 --repo "$REPO"
echo -e "  ${GREEN}✓${NC} ANDROID_KEYSTORE_BASE64"

echo "$KEYSTORE_PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$REPO"
echo -e "  ${GREEN}✓${NC} ANDROID_KEYSTORE_PASSWORD"

echo "$KEY_ALIAS" | gh secret set ANDROID_KEY_ALIAS --repo "$REPO"
echo -e "  ${GREEN}✓${NC} ANDROID_KEY_ALIAS"

echo "$KEY_PASSWORD" | gh secret set ANDROID_KEY_PASSWORD --repo "$REPO"
echo -e "  ${GREEN}✓${NC} ANDROID_KEY_PASSWORD"

echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "GitHub Actions secrets have been configured for release signing."
echo ""
echo -e "${YELLOW}Important:${NC}"
echo "  - Keep your keystore file (${KEYSTORE_PATH}) safe and backed up"
echo "  - Never commit the keystore to version control"
echo "  - Store your passwords securely"
echo ""
echo "The keystore is valid for $VALIDITY_DAYS days (~27 years)."
echo ""
echo "To trigger a release build, use:"
echo "  gh workflow run build-android.yml -f build_type=release -f app_env=production"
