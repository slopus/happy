Pod::Spec.new do |s|
  s.name           = 'AECManager'
  s.version        = '1.0.0'
  s.summary        = 'Acoustic Echo Cancellation Manager for Expo'
  s.description    = 'Provides access to system-level AEC for voice communication'
  s.author         = ''
  s.homepage       = 'https://github.com/example/aec-manager'
  s.platform       = :ios, '13.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
