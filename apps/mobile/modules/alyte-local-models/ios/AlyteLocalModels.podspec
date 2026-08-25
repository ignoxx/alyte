Pod::Spec.new do |s|
  s.name           = 'AlyteLocalModels'
  s.version        = '0.1.0'
  s.summary        = 'Alyte verified local semantic model storage'
  s.description    = 'Downloads, verifies, protects, activates, and releases the pinned Gemma model pack.'
  s.author         = 'Alyte'
  s.homepage       = 'https://alyte.app'
  s.platforms      = { :ios => '26.0' }
  s.source         = { :path => '.' }
  s.license        = {
    :type => 'Proprietary',
    :text => 'Alyte local model support is distributed only as part of the private Alyte application.',
  }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  repository_root = File.expand_path('../../../../..', __dir__)
  pod_root = File.expand_path(__dir__)
  staged_runtime_root = File.join(pod_root, '.alyte-local-model-runtime')
  require File.join(pod_root, 'stage-runtime.rb')
  runtime_xcframework = ENV['ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK'] || ENV['ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK']
  runtime_manifest = runtime_xcframework && "#{runtime_xcframework}.alyte-eval.json"
  allow_simulator_fake = ENV['ALYTE_LOCAL_MODEL_ALLOW_SIMULATOR_FAKE'] == '1' &&
    ENV['ALYTE_LOCAL_MODEL_SIMULATOR'] == '1' &&
    ENV['APP_VARIANT'] != 'production'
  if runtime_xcframework && File.directory?(runtime_xcframework)
    require 'digest'
    require 'json'
    raise 'Pinned llama.cpp runtime identity manifest is required' unless runtime_manifest && File.file?(runtime_manifest)
    identity = JSON.parse(File.read(runtime_manifest))
    expected_revision = 'bb4caa7540188872173c44d161602d9271386413'
    expected_framework = File.expand_path(runtime_xcframework)
    unless identity['runtimeRepository'] == 'ggml-org/llama.cpp' &&
        identity['runtimeRelease'] == 'v0.2.0' &&
        identity['runtimeRevision'] == expected_revision &&
        identity['sourceRevision'] == expected_revision &&
        identity['platform'] == 'ios-device' &&
        identity['module'] == 'llama' &&
        File.expand_path(identity['frameworkPath'].to_s) == expected_framework
      raise 'AlyteLocalModels requires the exact pinned llama.cpp runtime'
    end
    device_framework = File.join(runtime_xcframework, 'ios-arm64', 'llama.framework')
    device_binary = File.join(device_framework, 'llama')
    device_header = File.join(device_framework, 'Headers', 'llama.h')
    raise "Missing pinned llama framework at #{device_framework}" unless File.directory?(device_framework)
    raise "Missing pinned llama runtime header at #{device_header}" unless File.file?(device_header)
    raise "Missing pinned llama runtime binary at #{device_binary}" unless File.file?(device_binary)
    unless identity['deviceBinarySha256'] == Digest::SHA256.file(device_binary).hexdigest
      raise 'Pinned llama.cpp runtime binary checksum does not match its identity manifest'
    end
    staged_framework = stage_runtime!(
      runtime_xcframework,
      staged_runtime_root,
      repository_root: repository_root,
    )
    staged_relative_framework = File.join(File.basename(staged_runtime_root), 'llama.framework')
    raise 'AlyteLocalModels staged runtime path must be relative' if Pathname.new(staged_relative_framework).absolute?
    raise 'AlyteLocalModels staged runtime path is missing' unless File.directory?(staged_framework)
    s.vendored_frameworks = staged_relative_framework
    s.pod_target_xcconfig = {
      'DEFINES_MODULE' => 'YES',
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) ALYTE_LLAMA_RUNTIME',
      'OTHER_CFLAGS' => '$(inherited) -DALYTE_LLAMA_RUNTIME',
      'HEADER_SEARCH_PATHS' => "$(inherited) $(PODS_TARGET_SRCROOT)/#{File.basename(staged_runtime_root)}/llama.framework/Headers",
      'FRAMEWORK_SEARCH_PATHS' => "$(inherited) $(PODS_TARGET_SRCROOT)/#{File.basename(staged_runtime_root)}",
    }
    runtime_checker = File.join(repository_root, 'scripts/check-local-model-runtime.mjs')
    s.script_phase = {
      :name => 'Verify pinned Alyte llama.cpp runtime',
      :script => <<-SCRIPT,
set -eu
/usr/bin/env node "#{runtime_checker}" --variant "${APP_VARIANT:-development}" --runtime-path "#{File.expand_path(runtime_xcframework)}"
SCRIPT
      :execution_position => :before_compile,
    }
  elsif allow_simulator_fake
    s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  else
    raise 'AlyteLocalModels requires ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK built from the exact pinned llama.cpp revision; simulator-only fake builds must set ALYTE_LOCAL_MODEL_ALLOW_SIMULATOR_FAKE=1 and ALYTE_LOCAL_MODEL_SIMULATOR=1'
  end
  s.source_files = '**/*.{h,m,mm,c,swift,hpp,cpp}'
  s.exclude_files = [
    '**/*Tests.swift',
    "#{File.basename(staged_runtime_root)}/**/*",
  ]
  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = '*Tests.swift'
    test_spec.frameworks = 'XCTest'
  end
end
