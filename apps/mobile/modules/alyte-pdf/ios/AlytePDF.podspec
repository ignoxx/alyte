Pod::Spec.new do |s|
  s.name           = 'AlytePDF'
  s.version        = '0.1.0'
  s.summary        = 'Alyte local PDF inspection'
  s.description    = 'Inspects local laboratory PDFs and holds password sessions in memory only.'
  s.author         = 'Alyte'
  s.homepage       = 'https://alyte.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.frameworks = 'NaturalLanguage'
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "**/*Tests.swift"
  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = '*Tests.swift'
    test_spec.frameworks = 'XCTest'
  end
end
