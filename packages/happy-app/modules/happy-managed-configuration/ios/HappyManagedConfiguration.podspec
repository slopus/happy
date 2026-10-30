Pod::Spec.new do |s|
  s.name = 'HappyManagedConfiguration'
  s.version = '1.0.0'
  s.summary = 'Read Apple managed app configuration for Happy'
  s.description = 'Exposes an initial managed configuration snapshot to the Happy iOS app.'
  s.license = { :type => 'MIT' }
  s.author = 'Happy contributors'
  s.homepage = 'https://github.com/slopus/happy'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.0'
  s.source = { :git => 'https://github.com/slopus/happy.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
