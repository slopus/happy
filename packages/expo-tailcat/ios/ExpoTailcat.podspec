require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ExpoTailcat'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.license = { :type => 'MIT', :file => '../LICENSE' }
  s.author = 'Happy contributors'
  s.homepage = 'https://github.com/slopus/happy/tree/main/packages/expo-tailcat'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.0'
  s.source = { :git => 'https://github.com/slopus/happy.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'ExpoTailcatModule.swift'
  s.vendored_frameworks = 'Frameworks/Tailcat.xcframework'
  s.frameworks = 'Foundation', 'Security'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end