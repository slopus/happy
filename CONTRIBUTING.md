# Contributing to Happy

Thank you for your interest in contributing to Happy! This document provides guidelines and information for contributors.

## 🚀 Getting Started

### Prerequisites
- **Node.js** 22+ with npm
- **Rust** (latest stable) for desktop builds
- **Git** for version control
- **Expo CLI**: `npm install -g @expo/cli`

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/jeffersonwarrior/happy.git
   cd happy
   ```

2. **Install dependencies**
   ```bash
   npm install --legacy-peer-deps
   ```

3. **Start development server**
   ```bash
   npm run start
   ```

4. **Platform-specific development**
   ```bash
   npm run ios          # iOS simulator
   npm run android      # Android emulator
   npm run web          # Web browser
   ```

## 📱 Project Architecture

Happy is a cross-platform React Native app built with:
- **Frontend**: React Native + Expo SDK 53
- **Styling**: Unistyles with theme system
- **Navigation**: Expo Router v5
- **State**: React Context + custom reducers
- **Real-time**: Socket.io WebSocket
- **Encryption**: End-to-end with tweetnacl
- **Desktop**: Tauri (Rust + WebView)
- **Internationalization**: Custom i18n system

### Key Directories
```
sources/
├── app/              # Expo Router screens
├── components/       # Reusable UI components
├── sync/             # Real-time sync engine
├── auth/             # Authentication logic
├── text/             # Internationalization
└── utils/            # Utility functions
```

## 🛠 Development Guidelines

### Code Style
- **Indentation**: 4 spaces
- **Package Manager**: npm (yarn.lock exists for compatibility)
- **TypeScript**: Strict mode enabled
- **Path Aliases**: `@/*` maps to `./sources/*`

### Important Rules
- ✅ Always run `npm run typecheck` after changes
- ✅ Use `t(...)` function for ALL user-visible strings
- ✅ Apply layout constraints from `@/components/layout`
- ✅ Use `@/modal` instead of React Native Alert
- ❌ Never hardcode strings in JSX
- ❌ Never use `yarn` commands (use npm)

### Internationalization
**CRITICAL**: All user-visible text must use the `t(...)` function:

```typescript
import { t } from '@/text';

// ✅ Correct
<Text>{t('common.cancel')}</Text>
<Text>{t('common.welcome', { name: 'User' })}</Text>

// ❌ Wrong
<Text>Cancel</Text>
```

When adding new strings:
1. Check existing keys in `common.*` first
2. Add to ALL language files in `sources/text/translations/`
3. Use descriptive, hierarchical keys

### Styling with Unistyles
Always use `StyleSheet.create` from 'react-native-unistyles':

```typescript
import { StyleSheet } from 'react-native-unistyles'

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        backgroundColor: theme.colors.background,
        paddingTop: runtime.insets.top,
    }
}))
```

## 🧪 Testing

```bash
npm test              # Run tests
npm run typecheck     # TypeScript validation
```

### Test Requirements
- Write tests for new features
- Maintain or improve test coverage
- Test on multiple platforms when possible

## 🔄 Pull Request Process

1. **Fork & Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Changes**
   - Follow code style guidelines
   - Add tests for new features
   - Update documentation if needed
   - Add translations for new strings

3. **Test Thoroughly**
   ```bash
   npm run typecheck
   npm test
   npm run start  # Test on target platforms
   ```

4. **Commit with Conventional Format**
   ```bash
   git commit -m "feat: add new feature description"
   ```

   Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

5. **Push & Create PR**
   - Use the provided PR template
   - Include screenshots for UI changes
   - Link related issues

## 🐛 Bug Reports

Use the bug report template and include:
- Platform and device details
- Steps to reproduce
- Expected vs actual behavior
- Screenshots/videos if applicable

## ✨ Feature Requests

Use the feature request template and include:
- Clear problem statement
- Proposed solution
- Alternative approaches considered
- Priority level

## 📚 Documentation

When contributing:
- Update relevant README sections
- Add/update code comments
- Update CHANGELOG.md for user-facing changes
- Consider updating CLAUDE.md for AI development context

## 🚀 Release Process

Releases are automated via GitHub Actions:
1. Desktop builds for macOS, Windows, Linux
2. Mobile builds via EAS (for maintainers)
3. Automatic changelog generation

## 🔐 Security

- Report security vulnerabilities privately to jeffersonwarrior
- Never commit secrets, API keys, or credentials
- Follow secure coding practices
- Security scans run automatically on all PRs

## 📞 Getting Help

- **Issues**: Use GitHub issue templates
- **Discussions**: GitHub Discussions for questions
- **Code Review**: Maintainers will review all PRs

## 📄 License

By contributing, you agree that your contributions will be licensed under the same license as the project.

---

Thank you for contributing to Happy! 🎉