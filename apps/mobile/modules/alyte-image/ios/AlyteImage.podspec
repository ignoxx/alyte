Pod::Spec.new do |s|
  s.name           = 'AlyteImage'
  s.version        = '0.1.0'
  s.summary        = 'Alyte local image privacy workspace'
  s.description    = 'Renders and flattens local report images without retaining source metadata.'
  s.author         = 'Alyte'
  s.homepage       = 'https://alyte.app'
  s.platforms      = { :ios => '26.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "**/*Tests.swift"
  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = '*Tests.swift'
    test_spec.frameworks = 'XCTest'
  end
end
