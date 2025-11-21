# Session Header Responsive Breakpoint Bug
**Date:** 2025-11-21
**Status:** 🐛 BUG IDENTIFIED - NOT CAUSED BY TODAY'S PROFILEEDITFORM WORK

## Problem Statement

**Symptom:** Session view header (floating panel at top with back arrow, title, path, session image) disappears at medium window widths.

**Specific Behavior:**
1. **Very narrow window** → Header visible (mobile mode, 1 column layout)
2. **Medium width window** → **Header DISAPPEARS** (transition bug)
3. **Wide window** → Sidebar appears + header reappears (desktop mode, 2 column layout)

**User Description:**
> "Where there would be a floating panel I'm guessing ~100-200 pixels high at the very top of the screen, it is simply not there anymore. The back arrow is present but semi-transparent, the rest of it is not there, and I'm able to select text where it should be."

## Investigation

### Timeline
1. **Tested at commit eaecc75** (docs-only, before ProfileEditForm integration)
   - Bug **already present** at this commit
   - Confirms regression NOT caused by today's integration work

2. **Tested at commit 8b1ba7c** (latest, after ProfileEditForm integration)
   - Bug **still present** (no change)

3. **Conclusion:** Bug existed before ProfileEditForm/EnvironmentVariablesList work

### Root Cause

**Problem:** Two different configurations for mobile→desktop transition instead of one immediate conversion point.

**What should happen:**
- Single breakpoint width where:
  - Below: mobile mode (no sidebar, show header)
  - Above: desktop mode (show sidebar, show header)

**What's happening now:**
- Two different breakpoints:
  - Breakpoint A: Header visibility transition
  - Breakpoint B: Sidebar visibility transition
  - **Gap between A and B creates "dead zone" where neither shows**

### Architecture

**Sidebar Control:**
- File: `sources/components/SidebarNavigator.tsx:11`
- Logic: `showPermanentDrawer = auth.isAuthenticated && isTablet`
- Uses `useIsTablet()` hook

**Tablet Detection:**
- File: `sources/utils/responsive.ts:61-63`
- Logic: `deviceType === 'tablet'`
- Based on **diagonal inches** calculation (not window width)
- Threshold: **9 inches diagonal** (line: `sources/utils/deviceCalculations.ts:40`)
- Calculation: `Math.sqrt(widthInches² + heightInches²) >= 9`
- Points to inches: `width / pointsPerInch` (163 for iOS, 160 for Android)

**Header Control:**
- File: `sources/app/(app)/_layout.tsx:67`
- Route `session/[id]` has `headerShown: false`
- SessionView manages its own header
- File: `sources/-session/SessionView.tsx:116-120`
- Renders `<ChatHeaderView>` for landscape phone mode
- May have conditional rendering based on `isTablet` (line 153, 329)

## Technical Details

**Breakpoint Mismatch:**
- Sidebar uses: Diagonal inches calculation (physical size)
- Header might use: Different conditional logic
- Window resize changes width/height → diagonal changes → `isTablet` toggles → mismatch

**Files Involved:**
- `sources/utils/responsive.ts` - `useIsTablet()` hook
- `sources/utils/deviceCalculations.ts` - Diagonal inch threshold (line 40)
- `sources/components/SidebarNavigator.tsx` - Sidebar visibility (line 11)
- `sources/-session/SessionView.tsx` - Header rendering logic (lines 116-120, 329)
- `sources/app/(app)/_layout.tsx` - Navigation header config (line 67)

## Solution Required

**Fix:** Ensure header and sidebar use identical breakpoint threshold.

**Approach:**
1. Find where SessionView conditionally renders ChatHeaderView
2. Ensure it uses same `isTablet` check as SidebarNavigator
3. Verify no intermediate state where both are hidden
4. Test window resize: narrow → medium → wide should show consistent UI

**Expected Behavior:**
- **!isTablet** → Mobile: show header, no sidebar
- **isTablet** → Desktop: show header, show sidebar
- **No intermediate state** where header disappears

## Next Steps

1. [ ] Read SessionView.tsx completely to find all ChatHeaderView rendering
2. [ ] Identify conditional logic controlling header visibility
3. [ ] Compare with SidebarNavigator's `showPermanentDrawer` logic
4. [ ] Ensure both use identical `isTablet` check
5. [ ] Test at various window widths (600px, 900px, 1200px)
6. [ ] Verify header always visible regardless of window width
