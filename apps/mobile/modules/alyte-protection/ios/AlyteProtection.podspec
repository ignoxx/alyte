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
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "**/*Tests.swift"
end
