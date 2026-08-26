#!/usr/bin/env ruby

# CocoaPods resolves vendored_frameworks relative to the pod root. The selected runtime remains
# external and is validated there; this helper copies only the device framework into an ignored,
# deterministic, visible staging directory so CocoaPods never receives an absolute vendored path
# or drops the framework from its local pod file glob.

require 'digest'
require 'fileutils'
require 'json'
require 'pathname'
require 'securerandom'

PINNED_REVISION = 'bb4caa7540188872173c44d161602d9271386413'.freeze
EXPECTED_IDENTITY = {
  'runtimeRepository' => 'ggml-org/llama.cpp',
  'runtimeRelease' => 'v0.2.0',
  'runtimeRevision' => PINNED_REVISION,
  'sourceRevision' => PINNED_REVISION,
  'platform' => 'ios-device',
  'module' => 'llama',
}.freeze
WEIGHT_EXTENSION = /\.(gguf|bin|safetensors|pt|pth|onnx)$/i.freeze

def fail_stage(message)
  raise "AlyteLocalModels runtime staging failed: #{message}"
end

def absolute_external_path!(value, repository_root)
  fail_stage('runtime path must be provided as an absolute path') unless Pathname.new(value).absolute?

  runtime = File.expand_path(value)
  relative = Pathname.new(runtime).relative_path_from(Pathname.new(repository_root)).to_s
  unless relative == '..' || relative.start_with?('../')
    fail_stage('runtime path must be outside the Alyte repository')
  end
  runtime
end

def read_identity!(runtime)
  identity_path = "#{runtime}.alyte-eval.json"
  fail_stage("missing identity manifest: #{identity_path}") unless File.file?(identity_path)

  identity = JSON.parse(File.read(identity_path))
  EXPECTED_IDENTITY.each do |key, expected|
    fail_stage("identity.#{key} must equal #{expected}") unless identity[key] == expected
  end
  fail_stage('identity.frameworkPath does not match the selected XCFramework') unless
    File.expand_path(identity['frameworkPath'].to_s) == runtime
  identity
rescue JSON::ParserError => e
  fail_stage("identity manifest is not valid JSON (#{e.message})")
end

def reject_weights!(root)
  Pathname.new(root).find do |path|
    next unless path.file?
    fail_stage("runtime artifact contains forbidden model weight #{path}") if path.basename.to_s.match?(WEIGHT_EXTENSION)
  end
end

def stage_runtime!(runtime_xcframework, stage_root, repository_root:)
  runtime = absolute_external_path!(runtime_xcframework, repository_root)
  identity = read_identity!(runtime)

  device_framework = File.join(runtime, 'ios-arm64', 'llama.framework')
  device_binary = File.join(device_framework, 'llama')
  device_header = File.join(device_framework, 'Headers', 'llama.h')
  fail_stage("missing device framework: #{device_framework}") unless File.directory?(device_framework)
  fail_stage("missing device runtime binary: #{device_binary}") unless File.file?(device_binary)
  fail_stage("missing device runtime header: #{device_header}") unless File.file?(device_header)
  digest = Digest::SHA256.file(device_binary).hexdigest
  fail_stage('device runtime binary checksum does not match identity manifest') unless
    identity['deviceBinarySha256'] == digest
  reject_weights!(runtime)

  stage = File.expand_path(stage_root)
  stage_parent = File.dirname(stage)
  FileUtils.mkdir_p(stage_parent)
  temporary = "#{stage}.tmp-#{Process.pid}-#{SecureRandom.hex(6)}"
  FileUtils.rm_rf(temporary)
  FileUtils.mkdir_p(temporary)
  FileUtils.cp_r(device_framework, temporary)
  File.write(
    File.join(temporary, '.alyte-runtime.json'),
    JSON.pretty_generate(
      {
        'sourceFrameworkPath' => device_framework,
        'runtimeRevision' => identity['runtimeRevision'],
        'deviceBinarySha256' => digest,
      },
    ) + "\n",
  )

  staged_framework = File.join(temporary, 'llama.framework')
  staged_binary = File.join(staged_framework, 'llama')
  fail_stage('staged runtime binary checksum does not match source runtime') unless
    Digest::SHA256.file(staged_binary).hexdigest == digest
  reject_weights!(temporary)

  # No stale stage can be used when staging fails: validation and copy complete before this
  # replacement. CocoaPods only sees the replacement after all checks above pass.
  FileUtils.rm_rf(stage)
  FileUtils.mv(temporary, stage)
  File.join(stage, 'llama.framework')
rescue StandardError
  FileUtils.rm_rf(temporary) if defined?(temporary) && temporary
  raise
end

if $PROGRAM_NAME == __FILE__
  runtime = ARGV.fetch(0)
  stage = ARGV.fetch(1)
  repository_root = File.expand_path('../../../../..', __dir__)
  puts stage_runtime!(runtime, stage, repository_root: repository_root)
end
