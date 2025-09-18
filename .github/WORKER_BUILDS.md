# 🤖 Distributed Build with Workers

This repository uses a distributed GitHub Actions worker system to parallelize builds and tests, significantly reducing CI/CD pipeline time.

## 📋 Overview

The worker build system splits your build process into parallel jobs:

- **🌐 Web Builds**: Different optimization levels (development, production modern/legacy)
- **📱 Mobile Builds**: iOS and Android variants (development, production)  
- **🧪 Test Suites**: Parallel test execution (unit, integration, stress, e2e)
- **📊 Results Aggregation**: Combines all outputs and generates reports

## 🚀 Quick Start

### Automatic Triggering
Worker builds automatically start on pushes to `main` and `dev` branches.

### Manual Triggering
You can manually trigger worker builds with custom settings:

1. Go to **Actions** tab in your GitHub repository
2. Select **🤖 Distributed Build with Workers**
3. Click **Run workflow**
4. Configure options:
   - **Use workers**: Enable/disable distributed processing
   - **Worker count**: Number of parallel workers (1-8)

## ⚙️ Configuration

### Worker Configuration File
Edit `.github/worker-config.yml` to customize:

```yaml
worker_pool:
  default_count: 4        # Default parallel workers
  max_count: 8           # Maximum workers allowed
  
build_matrix:
  web:                   # Web build configurations
    - config: development
      optimize: false
  mobile:                # Mobile build configurations  
    - platform: ios
      variant: production
  tests:                 # Test suite configurations
    - suite: unit
      pattern: "**/*.test.ts"
```

### Environment Variables
Set these GitHub repository secrets for full functionality:

- `EXPO_TOKEN`: Expo authentication token for mobile builds

## 📊 Build Matrix

### Web Builds (3 parallel jobs)
1. **Development Modern**: Fast build for testing
2. **Production Modern**: Optimized for modern browsers  
3. **Production Legacy**: Optimized for older browsers

### Mobile Builds (4 parallel jobs)
1. **iOS Development**: Quick iOS build for testing
2. **iOS Production**: Optimized iOS build for app stores
3. **Android Development**: Quick Android build for testing  
4. **Android Production**: Optimized Android build for app stores

### Test Suites (4 parallel jobs)
1. **Unit Tests**: Component-level tests (`**/*.test.ts`)
2. **Integration Tests**: Component interaction tests (`**/*.integration.test.ts`)
3. **Stress Tests**: Performance tests (`**/*.stress.test.ts`)
4. **E2E Tests**: End-to-end user flow tests (`**/*.e2e.test.ts`)

## 🔧 Worker Performance

### Timing Improvements
- **Sequential build time**: ~30-45 minutes
- **Distributed build time**: ~10-15 minutes
- **Speed improvement**: ~3x faster

### Resource Usage
- **Concurrent jobs**: Up to 11 parallel jobs
- **GitHub Actions minutes**: Higher usage but faster completion
- **Artifact storage**: Temporary builds (7-day retention)

## 📦 Build Artifacts

All builds generate artifacts that are automatically uploaded:

### Web Build Artifacts
- `web-build-development-modern/`
- `web-build-production-modern/` 
- `web-build-production-legacy/`

### Mobile Build Artifacts  
- `mobile-build-ios-development/`
- `mobile-build-ios-production/`
- `mobile-build-android-development/`
- `mobile-build-android-production/`

### Test Result Artifacts
- `test-results-unit.json`
- `test-results-integration.json`
- `test-results-stress.json`
- `test-results-e2e.json`

## 🎯 Usage Examples

### Standard Development Workflow
```bash
# Push to dev branch - triggers automatic worker build
git push origin dev

# View progress in GitHub Actions tab
# Download artifacts when complete
```

### Custom Worker Count
```bash
# Trigger manually with 6 workers for faster builds
# Go to Actions → Distributed Build → Run workflow
# Set worker_count: 6
```

### Debugging Failed Builds
```bash
# Check individual worker logs in GitHub Actions
# Failed jobs show specific error details
# Artifacts available even for failed builds
```

## 🔍 Monitoring & Debugging

### Build Status
- **GitHub Status Checks**: Individual job status on commits
- **Action Summary**: Aggregated results with timing and sizes
- **Artifact Downloads**: Access build outputs directly

### Common Issues
1. **Worker timeout**: Increase timeout in `worker-config.yml`
2. **Missing secrets**: Add `EXPO_TOKEN` to repository secrets  
3. **Build failures**: Check individual worker logs for details
4. **Quota limits**: Reduce `max_parallel` settings

### Debug Mode
Enable debug logging in `worker-config.yml`:
```yaml
advanced:
  debug_mode: true
```

## 📈 Performance Metrics

The system automatically tracks and reports:
- **Build timing**: Per-job and total execution time
- **Artifact sizes**: Bundle size analysis for each build
- **Resource usage**: Memory and storage consumption  
- **Success rates**: Job completion statistics

### Example Output
```
📊 Distributed Build Summary

📈 Build Statistics:
- 🌐 Web Builds: 3
- 📱 Mobile Builds: 4  
- 🧪 Test Suites: 4

📊 Build Size Analysis:
- web-build-production-modern: 2.1MB
- web-build-production-legacy: 2.8MB
- mobile-build-ios-production: 15.2MB

🚀 Worker Performance:
- ⚡ Parallel execution completed in 12m 34s
- 🔄 All worker tasks finished successfully
- 📦 Build artifacts ready for deployment
```

## 🚨 Troubleshooting

### Worker Build Not Starting
- Check branch is in trigger list (main, dev, feature/*)
- Verify workflow file permissions
- Check GitHub Actions are enabled

### Individual Job Failures  
- Review specific worker logs in Actions tab
- Check for missing dependencies or environment setup
- Verify secrets are properly configured

### Resource Limits
- Reduce parallel job counts in configuration
- Use smaller build matrices for limited accounts
- Enable smart builds to skip unchanged code

### Build Artifacts Missing
- Check job completed successfully
- Verify artifact upload step didn't fail
- Check retention settings (default: 7 days)

## 🔄 Fallback Mode

If workers are disabled or unavailable, the system automatically falls back to sequential builds:

```yaml
# Disable workers
use_workers: false
```

This runs a single job with all build steps in sequence, ensuring your CI/CD pipeline always works.

## 🎛️ Advanced Configuration

### Custom Build Matrix
Modify the build matrix in the workflow file to add new combinations:

```yaml
# Add new web build configuration
- config: "staging"
  optimize: true  
  bundle: "modern"
```

### Resource Optimization
Fine-tune resource allocation:

```yaml
resources:
  max_parallel:
    web_builds: 2      # Reduce for limited accounts
    mobile_builds: 1   # Sequential mobile builds
    test_suites: 6     # Increase for more test parallelization
```

### Custom Triggers
Modify when worker builds are triggered:

```yaml
on:
  push:
    branches: [main, dev, staging]
    paths: ['sources/**', '*.ts', '*.js']
```

## 📚 Related Documentation

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Expo Build Documentation](https://docs.expo.dev/build/introduction/)
- [React Native Performance](https://reactnative.dev/docs/performance)

## 🤝 Support

If you encounter issues with the worker build system:

1. Check the troubleshooting section above
2. Review GitHub Actions logs for specific errors
3. Verify configuration files are valid YAML
4. Test with fallback mode to isolate worker-specific issues

The distributed build system is designed to be robust and fall back gracefully to sequential builds if needed.