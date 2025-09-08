# Specification: 11Labs Authentication and Paywall

## Overview

This specification outlines the implementation of authentication and paywall features for the 11Labs voice conversation feature in Happy. The goal is to secure session creation with proper backend authentication and implement a 30-minute free trial with a subscription-based paywall.

## Current State Analysis

### Existing Infrastructure

1. **Authentication System**
   - App uses token-based authentication via `AuthContext` 
   - Backend API calls use `Bearer ${credentials.token}` headers
   - Token storage handled by `TokenStorage` service
   - Auth flow: QR code → token + secret → backend verification

2. **11Labs Integration** 
   - Voice sessions managed by `RealtimeVoiceSession` component
   - Uses hardcoded agent IDs (dev/prod environments)
   - Session initiated via `startRealtimeSession()` from microphone button
   - No current authentication before session creation

3. **Modal System**
   - Custom modal system via `ModalProvider` and `Modal` manager
   - Supports alert, confirm, prompt, and custom modal types
   - Ready for paywall UI implementation

## Authentication Requirements

### Priority 1: Secure Session Creation

Before creating any 11Labs voice session, the app must:

1. **Verify User Authentication**
   - Check if user has valid credentials in `AuthContext`
   - If not authenticated, redirect to login flow
   - Block voice session creation for unauthenticated users

2. **Backend Token Validation**
   - Call new backend endpoint to validate 11Labs access
   - Endpoint: `POST /v1/voice/validate`
   - Headers: `Authorization: Bearer ${credentials.token}`
   - Response includes:
     - User subscription status
     - Remaining free trial minutes
     - Total usage statistics

3. **Session Token Generation**
   - Backend generates temporary session token for 11Labs
   - Token passed to `startSession()` configuration
   - Enables backend tracking of voice usage per user

### Implementation Points

```typescript
// sources/realtime/RealtimeVoiceSession.tsx
async startSession(config: VoiceSessionConfig): Promise<void> {
    // NEW: Add authentication check
    const authResponse = await validateVoiceAccess(credentials);
    
    if (!authResponse.allowed) {
        // Show paywall or error
        return;
    }
    
    // Existing session start logic
    await conversationInstance.startSession({
        agentId: __DEV__ ? 'agent_...' : 'agent_...',
        // NEW: Add session token from backend
        sessionToken: authResponse.sessionToken,
        dynamicVariables: {
            sessionId: config.sessionId,
            initialConversationContext: config.initialContext || ''
        }
    });
}
```

## Paywall System

### Free Trial Structure

- **Duration**: 30 minutes cumulative usage (not calendar time)
- **Tracking**: Backend tracks actual voice conversation time
- **Persistence**: Usage persists across app restarts and devices
- **No session interruption**: Active sessions continue even after limit

### Pricing Model

- **Free Trial**: 30 minutes total usage
- **Subscription**: $20/month 
- **Trial Period**: 1 week free trial before billing starts
- **Payment Processing**: RevenueCat integration (future phase)

### User Flow

#### First-Time User Flow

1. User taps microphone button
2. Backend validates → returns `firstTimeUser: true`
3. Show welcome modal:
   ```
   Title: "Try Voice Assistant"
   Message: "You can use voice conversations for 30 minutes free. 
            After that, it's $20/month with a 1-week free trial."
   Buttons: [Continue] [Learn More]
   ```
4. User proceeds → session starts
5. Track usage in backend

#### Returning User Flow (Within Free Trial)

1. User taps microphone button
2. Backend validates → returns usage stats
3. If under 30 minutes:
   - Start session immediately
   - Optionally show remaining time in UI
4. If over 30 minutes:
   - Show paywall modal (see below)

#### Paywall Modal

```typescript
interface PaywallModalConfig {
    title: "Free Trial Expired",
    message: "You've used your 30 minutes of free voice conversations.",
    details: "Continue with unlimited voice access for $20/month",
    features: [
        "Unlimited voice conversations",
        "Priority response times", 
        "Advanced voice commands"
    ],
    buttons: [
        { text: "Start 1-Week Free Trial", action: 'subscribe' },
        { text: "Maybe Later", action: 'dismiss' }
    ]
}
```

### Technical Implementation

#### Backend API Endpoints

1. **Voice Access Validation**
   ```
   POST /v1/voice/validate
   Headers: Authorization: Bearer {token}
   
   Response:
   {
     "allowed": boolean,
     "sessionToken": string | null,
     "subscription": {
       "status": "none" | "trial" | "active" | "expired",
       "trialMinutesUsed": number,
       "trialMinutesLimit": 30,
       "subscriptionEndDate": string | null
     },
     "firstTimeUser": boolean
   }
   ```

2. **Usage Tracking**
   ```
   POST /v1/voice/usage
   Headers: Authorization: Bearer {token}
   Body: {
     "sessionId": string,
     "duration": number, // seconds
     "timestamp": string
   }
   ```

3. **Subscription Management**
   ```
   POST /v1/voice/subscribe
   Headers: Authorization: Bearer {token}
   Body: {
     "plan": "monthly",
     "receipt": string // RevenueCat receipt (future)
   }
   ```

#### Frontend Components

1. **VoiceAccessManager** (New)
   - Handles authentication before session start
   - Shows appropriate modals based on subscription status
   - Manages usage tracking

2. **PaywallModal** (New)
   - Custom modal component for subscription UI
   - Integrates with Modal system
   - Handles subscription flow

3. **UsageIndicator** (New)
   - Shows remaining free trial time
   - Visual indicator in voice UI
   - Updates in real-time during session

#### State Management

Add to `storage.ts`:
```typescript
interface VoiceSubscription {
    status: 'none' | 'trial' | 'active' | 'expired';
    trialMinutesUsed: number;
    trialMinutesLimit: number;
    subscriptionEndDate: Date | null;
    lastChecked: Date;
}
```

## Implementation Phases

### Phase 1: Authentication (Immediate Priority)
1. Add backend validation before session creation
2. Block unauthenticated users from voice access
3. Implement session token passing
4. Add error handling and user feedback

### Phase 2: Basic Paywall (Week 1)
1. Implement usage tracking in backend
2. Add welcome modal for first-time users
3. Create paywall modal component
4. Implement 30-minute free trial logic
5. Add usage indicators to UI

### Phase 3: Subscription System (Week 2)
1. Integrate subscription endpoints
2. Add subscription status to user profile
3. Implement subscription management UI
4. Add receipt validation (stub for RevenueCat)

### Phase 4: RevenueCat Integration (Future)
1. Replace stub payment flow with RevenueCat
2. Implement receipt validation
3. Add subscription restoration
4. Handle edge cases (refunds, cancellations)

## Success Metrics

1. **Security**
   - 100% of voice sessions authenticated
   - No unauthorized access to 11Labs API
   - Proper token rotation and expiry

2. **User Experience**
   - Clear communication of pricing
   - Smooth transition from trial to paid
   - No interruption of active sessions

3. **Business Metrics**
   - Track conversion rate from trial to paid
   - Monitor average usage before subscription
   - Measure churn rate post-subscription

## Error Handling

### Authentication Failures
- Network errors → Retry with exponential backoff
- Invalid token → Redirect to login
- Expired session → Refresh token automatically

### Subscription Issues
- Payment failure → Grace period of 3 days
- Subscription expired → Revert to paywall
- Backend unavailable → Cache subscription status locally

## Testing Strategy

1. **Unit Tests**
   - Authentication flow validation
   - Usage calculation accuracy
   - Modal display logic

2. **Integration Tests**
   - End-to-end auth + voice session flow
   - Subscription state transitions
   - Error recovery scenarios

3. **User Testing**
   - First-time user experience
   - Paywall conversion flow
   - Subscription management

## Security Considerations

1. **Token Security**
   - Session tokens expire after 1 hour
   - Tokens bound to specific user + device
   - No client-side storage of 11Labs API keys

2. **Usage Validation**
   - Backend validates all usage reports
   - Prevent client-side manipulation
   - Rate limiting on API endpoints

3. **Subscription Verification**
   - Server-side receipt validation only
   - Regular subscription status checks
   - Audit trail for all transactions

## Future Enhancements

1. **Tiered Pricing**
   - Basic: 2 hours/month for $10
   - Pro: Unlimited for $20
   - Team: Multi-user for $50

2. **Usage Analytics**
   - Dashboard showing usage patterns
   - Voice session history
   - Conversation quality metrics

3. **Advanced Features**
   - Voice training for personalization
   - Custom voice commands
   - Integration with external services

## Appendix: Code Locations

### Files to Modify

1. **Authentication Integration**
   - `sources/realtime/RealtimeVoiceSession.tsx` - Add auth check
   - `sources/realtime/RealtimeSession.ts` - Pass auth tokens
   - `sources/app/(app)/session/[id].tsx` - Handle auth errors

2. **Paywall Implementation**
   - `sources/components/PaywallModal.tsx` - New component
   - `sources/modal/types.ts` - Add paywall modal type
   - `sources/sync/storage.ts` - Add subscription state

3. **Backend Integration**
   - `sources/sync/apiVoice.ts` - New API client
   - `sources/sync/types.ts` - Add voice types
   - `sources/utils/subscription.ts` - Subscription utilities

### Configuration

1. **Environment Variables**
   - `ELEVENLABS_API_KEY` - Server-side only
   - `VOICE_SUBSCRIPTION_PRICE` - For display
   - `FREE_TRIAL_MINUTES` - Configurable limit

2. **Feature Flags**
   - `ENABLE_VOICE_PAYWALL` - Gradual rollout
   - `SHOW_USAGE_INDICATOR` - UI testing
   - `REVECAT_ENABLED` - Payment integration

## IMPLEMENTATION DETAILS

### SUBSCRIPTION ALREADY FUCKING EXISTS

Found in `/sources/sync/sync.ts`:
```typescript
// Line 320-321: PURCHASE PRODUCT
const { customerInfo } = await RevenueCat.purchaseStoreProduct(product);

// Storage updates automatically
storage.getState().applyPurchases(customerInfo);
```

Purchase flow:
1. `sync.purchaseProduct(productId)` - main entry point
2. Gets product from RevenueCat
3. Calls `RevenueCat.purchaseStoreProduct(product)`
4. Updates storage with customer info
5. Returns success/error

### MODAL SYSTEM - USE THIS SHIT

From `/sources/modal/`:
```typescript
// SIMPLE PAYWALL MODAL
Modal.alert(
    'Voice Access Required',
    'Subscribe for unlimited voice conversations',
    [
        { text: 'Subscribe', onPress: () => sync.purchaseProduct('voice_monthly') },
        { text: 'Cancel', style: 'cancel' }
    ]
);

// CUSTOM PAYWALL COMPONENT
Modal.show({
    component: VoicePaywallModal,
    props: { 
        minutesUsed: 30,
        onSubscribe: () => sync.purchaseProduct('voice_monthly')
    }
});
```

### 11LABS USAGE TRACKING - SERVER SIDE ONLY

NO CLIENT USAGE API. Must track server-side:
1. Backend tracks session duration
2. Backend validates before session start
3. Backend returns usage in validation response

### EXACT IMPLEMENTATION

#### 1. Backend Validation (sources/realtime/RealtimeVoiceSession.tsx)
```typescript
// BEFORE SESSION START
const validation = await fetch('/v1/voice/validate', {
    headers: { Authorization: `Bearer ${credentials.token}` }
});

if (!validation.allowed) {
    // Show paywall
    Modal.show({
        component: VoicePaywallModal,
        props: {
            status: validation.subscription.status,
            minutesUsed: validation.subscription.trialMinutesUsed,
            onSubscribe: async () => {
                const result = await sync.purchaseProduct('voice_monthly');
                if (result.success) {
                    // Retry session
                    startSession(config);
                }
            }
        }
    });
    return;
}

// Continue with session using validation.sessionToken
```

#### 2. Paywall Modal Component (sources/components/VoicePaywallModal.tsx)
```typescript
export function VoicePaywallModal({ onClose, status, minutesUsed, onSubscribe }) {
    const isTrialExpired = status === 'none' && minutesUsed >= 30;
    
    return (
        <View>
            <Text>{isTrialExpired ? 'Trial Expired' : 'Unlock Voice'}</Text>
            <Text>{`${30 - minutesUsed} minutes remaining`}</Text>
            <RoundButton 
                title="Subscribe $20/month"
                onPress={async () => {
                    await onSubscribe();
                    onClose();
                }}
            />
        </View>
    );
}
```

#### 3. Check Entitlements (sources/sync/storage.ts)
```typescript
// CHECK IF USER HAS VOICE ACCESS
const hasVoiceAccess = () => {
    const purchases = storage.getState().purchases;
    return purchases.entitlements['voice_unlimited'] === true;
};
```

## Conclusion

This specification provides a comprehensive plan for securing the 11Labs voice feature with authentication and implementing a sustainable monetization model through a paywall system. The phased approach ensures critical security issues are addressed immediately while building towards a full subscription system.