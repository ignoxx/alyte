Pod::Spec.new do |s|
  s.name           = 'AlyteProtection'
  s.version        = '0.1.0'
  s.summary        = 'Alyte local database protection'
  s.description    = 'Applies iOS Data Protection and iCloud Backup exclusion to local health files.'
  s.author         = 'Alyte'
  s.homepage       = 'https://alyte.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'ZIPFoundation', '0.9.20'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "**/*Tests.swift"
  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = '*Tests.swift'
    test_spec.frameworks = 'XCTest'
  end
end
