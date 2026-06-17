# Telegram Mini App Integration

This document explains how to set up and use the Telegram Mini App integration in Happy.

## Overview

Happy now supports running as a **Telegram Mini App**, allowing users to control Claude Code and Codex sessions directly from Telegram messenger.

### Features

- ✅ **Telegram WebApp SDK** - Full integration with Telegram's Web App API
- ✅ **Automatic Authentication** - Seamless login using Telegram credentials
- ✅ **Theme Integration** - Matches Telegram's dark/light mode
- ✅ **Native UI Elements** - Back button, main button, haptic feedback
- ✅ **Graceful Fallback** - Works as standalone web app if not in Telegram

## Architecture

### Frontend (Happy App)

The integration consists of several key hooks and utilities:

1. **`useTelegram.ts`** - Low-level Telegram SDK integration
   - Environment detection
   - SDK loading
   - Type definitions

2. **`useAuthSource.ts`** - Authentication source detection
   - Detects Telegram vs access token auth
   - Handles token storage
   - Retry logic for delayed SDK initialization

3. **`useHappyTelegram.ts`** - Main integration hook
   - SDK initialization
   - Auto-authentication
   - Theme synchronization

4. **`authTelegram.ts`** - Server authentication
   - Validates Telegram initData
   - Obtains Happy credentials
   - Account binding

### Backend (Happy Server)

**TODO**: The following endpoints need to be implemented in `happy-server`:

1. **`POST /v1/auth/telegram`**
   - Validates Telegram initData signature
   - Creates or retrieves user account
   - Returns auth token + secret

2. **`POST /v1/auth/telegram/bind`**
   - Binds Telegram account to existing Happy user
   - Requires existing auth token

## Setup Instructions

### 1. Create Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow prompts to create your bot
3. Copy the bot token (e.g., `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`)

### 2. Create Mini App

1. Message @BotFather again
2. Send `/newapp`
3. Select your bot
4. Provide:
   - **Title**: Happy Coder
   - **Description**: Control Claude Code and Codex from anywhere
   - **Photo**: Upload app icon (512x512 PNG)
   - **Demo GIF/Video**: (optional)
   - **Short name**: `happy` (used in URL)
   - **Web App URL**: `https://app.happy.engineering`

### 3. Configure Environment Variables

Add to your `happy-server` environment:

```bash
# Telegram Bot Token (from @BotFather)
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Enable Telegram notifications (optional)
TELEGRAM_NOTIFICATION=true
```

### 4. Implement Server Endpoints

In `happy-server/sources/apps/api/routes/authRoutes.ts`, add:

```typescript
// POST /v1/auth/telegram
// Validate Telegram initData and authenticate user
fastify.post('/v1/auth/telegram', {
  schema: {
    body: z.object({
      initData: z.string(),
    }),
  },
}, async (request, reply) => {
  const { initData } = request.body

  // 1. Validate Telegram initData signature
  const telegramData = await validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN!)

  if (!telegramData.valid) {
    return reply.code(401).send({ error: 'Invalid Telegram data' })
  }

  // 2. Get or create user
  const user = await getUserByTelegramId(telegramData.user.id)
    ?? await createUserFromTelegram(telegramData.user)

  // 3. Generate Happy credentials
  const token = generateAuthToken(user.id)
  const secret = user.encryptionSecret

  return { token, secret, user }
})
```

## Usage

### In Your React App

```typescript
import { useHappyTelegram } from '@/hooks/useHappyTelegram'

function App() {
  const {
    isTelegram,
    telegram,
    isLoading,
    error,
    authenticateWithTelegram
  } = useHappyTelegram('https://api.happy-servers.com')

  useEffect(() => {
    if (isTelegram && !isLoading) {
      // Auto-authenticate when app loads in Telegram
      authenticateWithTelegram().catch(console.error)
    }
  }, [isTelegram, isLoading])

  if (isLoading) {
    return <LoadingScreen />
  }

  if (error) {
    return <ErrorScreen message={error} />
  }

  return <MainApp isTelegram={isTelegram} />
}
```

### Using Telegram UI Elements

```typescript
import { getTelegramWebApp } from '@/hooks/useTelegram'

function SessionScreen() {
  const telegram = getTelegramWebApp()

  useEffect(() => {
    if (!telegram) return

    // Show back button
    telegram.BackButton?.show()
    telegram.BackButton?.onClick(() => {
      // Handle back navigation
      router.back()
    })

    return () => {
      telegram.BackButton?.hide()
    }
  }, [telegram])

  const handleApprove = () => {
    // Haptic feedback on button press
    telegram?.HapticFeedback?.impactOccurred('medium')

    // Approve permission...
  }

  return (
    <View>
      {/* Your UI */}
    </View>
  )
}
```

### Theme Integration

```typescript
import { useTelegramTheme } from '@/hooks/useHappyTelegram'

function ThemedComponent() {
  const themeColors = useTelegramTheme()

  return (
    <View style={{ backgroundColor: themeColors.background }}>
      <Text style={{ color: themeColors.text }}>
        This text matches Telegram's theme!
      </Text>
    </View>
  )
}
```

## Testing

### Local Testing (Browser)

The app will work as a standalone web app when not in Telegram:

```bash
cd packages/happy-app
yarn web
```

Open `http://localhost:8081` - app runs normally without Telegram features.

### Testing in Telegram

1. **Development**: Use ngrok or similar to expose localhost:
   ```bash
   ngrok http 8081
   ```

2. **Update Bot**: Tell @BotFather to use ngrok URL:
   ```
   /setmenubutton
   <select your bot>
   https://abc123.ngrok.io
   ```

3. **Open in Telegram**:
   - Open your bot in Telegram
   - Tap the menu button (bottom left)
   - Mini app should open!

### Debugging

Enable debug logging:

```typescript
// In your app initialization
if (__DEV__) {
  // Log Telegram environment
  console.log('Telegram env:', isTelegramEnvironment())
  console.log('Telegram SDK:', getTelegramWebApp())
  console.log('Init data:', getTelegramInitData())
}
```

## Security Notes

### Telegram initData Validation

**CRITICAL**: Always validate `initData` on the server!

The server MUST:
1. Parse initData (URL-encoded parameters)
2. Extract `hash` parameter
3. Compute HMAC-SHA256 of other parameters using bot token
4. Compare computed hash with provided hash
5. Check `auth_date` timestamp (reject if >24h old)

Example validation (server-side):

```typescript
import crypto from 'crypto'

function validateTelegramInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  params.delete('hash')

  // Sort params alphabetically
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  // Compute secret key
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest()

  // Compute hash
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex')

  // Verify hash
  if (computedHash !== hash) {
    return { valid: false, error: 'Invalid hash' }
  }

  // Check timestamp
  const authDate = parseInt(params.get('auth_date') || '0')
  if (Date.now() / 1000 - authDate > 86400) {
    return { valid: false, error: 'Data too old' }
  }

  return {
    valid: true,
    user: JSON.parse(params.get('user') || '{}')
  }
}
```

### Storage Security

- `initData` contains signed user info from Telegram
- Token/secret stored in localStorage (encrypted storage on mobile)
- WebSocket encryption via TweetNaCl (existing Happy security)

## Deployment

### Production Checklist

- [ ] Bot created with @BotFather
- [ ] Mini app registered with web app URL
- [ ] `TELEGRAM_BOT_TOKEN` set in server environment
- [ ] Server endpoints implemented (`/v1/auth/telegram`)
- [ ] initData validation working correctly
- [ ] SSL/TLS enabled (required by Telegram)
- [ ] Bot menu button configured

### CDN Optimization

Add to `web/src/sw.ts` (service worker):

```typescript
{
  urlPattern: /^https:\/\/telegram\.org\/.*/,
  handler: 'CacheFirst',
  options: {
    cacheName: 'cdn-telegram',
    expiration: {
      maxEntries: 10,
      maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
    },
  },
}
```

## Troubleshooting

### "Telegram SDK not loading"

- Check network connection
- Verify Telegram CDN is accessible
- Increase timeout: `loadTelegramSdk(5000)`

### "initData not available"

- Ensure app opened via Telegram (not direct URL)
- Check Telegram app version (update if old)
- Verify bot menu button configured correctly

### "Authentication failed"

- Check server logs for validation errors
- Verify `TELEGRAM_BOT_TOKEN` is correct
- Ensure initData timestamp is fresh

### "Theme not applying"

- Telegram theme available only in mini app
- Check `getTelegramWebApp()?.themeParams`
- Fallback to default theme for web

## Resources

- [Telegram Mini Apps Docs](https://core.telegram.org/bots/webapps)
- [WebApp API Reference](https://core.telegram.org/bots/webapps#initializing-mini-apps)
- [Bot API](https://core.telegram.org/bots/api)
- [Happy Coder](https://happy.engineering)

## Next Steps

1. **Implement server endpoints** - Add `/v1/auth/telegram` to happy-server
2. **Test authentication flow** - Verify initData validation works
3. **Add Telegram bot notifications** - Optional: Send notifications via bot
4. **Optimize for mobile** - Test on iOS/Android Telegram apps
5. **Add analytics** - Track Telegram mini app usage

---

**Questions?** Check the [Happy Discord](https://discord.gg/fX9WBAhyfD) or open an issue on GitHub.
