import Foundation

#if canImport(Darwin)
import Darwin
#endif

public enum EvaluationThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
    case unknown
}

public struct EvaluationRuntimeSettings: Codable, Equatable, Sendable {
    public let modelId: String
    public let modelRevision: String
    public let modelFilename: String
    public let modelSha256: String
    public let runtimeId: String
    public let runtimeRevision: String
    public let schemaVersion: String
    public let contextWindowTokens: Int
    public let outputTokenLimit: Int
    public let temperature: Double
    public let thinking: Bool

    public init(
        modelId: String,
        modelRevision: String,
        modelFilename: String,
        modelSha256: String,
        runtimeId: String,
        runtimeRevision: String,
        schemaVersion: String,
        contextWindowTokens: Int,
        outputTokenLimit: Int,
        temperature: Double,
        thinking: Bool
    ) {
        self.modelId = modelId
        self.modelRevision = modelRevision
        self.modelFilename = modelFilename
        self.modelSha256 = modelSha256
        self.runtimeId = runtimeId
        self.runtimeRevision = runtimeRevision
        self.schemaVersion = schemaVersion
        self.contextWindowTokens = contextWindowTokens
        self.outputTokenLimit = outputTokenLimit
        self.temperature = temperature
        self.thinking = thinking
    }
}

public struct DeviceMetricSnapshot: Codable, Equatable, Sendable {
    public let deviceClass: String
    public let deviceModel: String
    public let osVersion: String
    public let coldLoadMs: Double?
    public let warmInferenceMsP50: Double?
    public let warmInferenceMsP95: Double?
    public let peakMemoryBytes: UInt64?
    public let thermalState: EvaluationThermalState
    public let packBytes: UInt64
    public let runtimeBytes: UInt64

    public init(
        deviceClass: String,
        deviceModel: String,
        osVersion: String,
        coldLoadMs: Double?,
        warmInferenceMsP50: Double?,
        warmInferenceMsP95: Double?,
        peakMemoryBytes: UInt64?,
        thermalState: EvaluationThermalState,
        packBytes: UInt64,
        runtimeBytes: UInt64
    ) {
        self.deviceClass = deviceClass
        self.deviceModel = deviceModel
        self.osVersion = osVersion
        self.coldLoadMs = coldLoadMs
        self.warmInferenceMsP50 = warmInferenceMsP50
        self.warmInferenceMsP95 = warmInferenceMsP95
        self.peakMemoryBytes = peakMemoryBytes
        self.thermalState = thermalState
        self.packBytes = packBytes
        self.runtimeBytes = runtimeBytes
    }
}

/// Native-only timing/memory seam. It accepts aggregate values and never accepts prompts or model output.
public struct EvaluationMetricRecorder: Sendable {
    private var coldLoadStart: UInt64?
    private var coldLoadDuration: Double?
    private var warmInferenceDurations: [Double]
    private var peakMemoryBytes: UInt64?

    public init() {
        self.coldLoadStart = nil
        self.coldLoadDuration = nil
        self.warmInferenceDurations = []
        self.peakMemoryBytes = nil
    }

    public mutating func beginColdLoad() {
        coldLoadStart = Self.clockNanoseconds()
        observeMemory()
    }

    public mutating func endColdLoad() {
        guard let coldLoadStart else { return }
        coldLoadDuration = Self.elapsedMilliseconds(since: coldLoadStart)
        self.coldLoadStart = nil
        observeMemory()
    }

    public mutating func recordWarmInference(startNanoseconds: UInt64, endNanoseconds: UInt64) {
        guard endNanoseconds >= startNanoseconds else { return }
        warmInferenceDurations.append(Self.elapsedMilliseconds(start: startNanoseconds, end: endNanoseconds))
        observeMemory()
    }

    public mutating func recordCurrentMemory() {
        observeMemory()
    }

    public func snapshot(
        deviceClass: String,
        deviceModel: String,
        osVersion: String,
        packBytes: UInt64,
        runtimeBytes: UInt64,
        thermalState: EvaluationThermalState = Self.currentThermalState()
    ) -> DeviceMetricSnapshot {
        let sorted = warmInferenceDurations.sorted()
        return DeviceMetricSnapshot(
            deviceClass: deviceClass,
            deviceModel: deviceModel,
            osVersion: osVersion,
            coldLoadMs: coldLoadDuration,
            warmInferenceMsP50: Self.percentile(sorted, 0.50),
            warmInferenceMsP95: Self.percentile(sorted, 0.95),
            peakMemoryBytes: peakMemoryBytes,
            thermalState: thermalState,
            packBytes: packBytes,
            runtimeBytes: runtimeBytes
        )
    }

    public static func clockNanoseconds() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds
    }

    public static func currentThermalState() -> EvaluationThermalState {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return .nominal
        case .fair: return .fair
        case .serious: return .serious
        case .critical: return .critical
        @unknown default: return .unknown
        }
    }

    public static func residentMemoryBytes() -> UInt64? {
        #if os(iOS) || os(macOS)
        var info = mach_task_basic_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result: kern_return_t = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), rebound, &count)
            }
        }
        return result == KERN_SUCCESS ? UInt64(info.resident_size) : nil
        #else
        return nil
        #endif
    }

    private mutating func observeMemory() {
        guard let current = Self.residentMemoryBytes() else { return }
        peakMemoryBytes = max(peakMemoryBytes ?? 0, current)
    }

    private static func elapsedMilliseconds(start: UInt64, end: UInt64) -> Double {
        Double(end - start) / 1_000_000
    }

    private static func elapsedMilliseconds(since start: UInt64) -> Double {
        elapsedMilliseconds(start: start, end: clockNanoseconds())
    }

    private static func percentile(_ values: [Double], _ percentile: Double) -> Double? {
        guard !values.isEmpty else { return nil }
        let index = min(values.count - 1, Int(ceil(percentile * Double(values.count))) - 1)
        return values[index]
    }
}

public enum AggregateReportWriter {
    /// Writes only caller-provided aggregate Codable data. No prompt/output logging is provided by this target.
    public static func write<T: Encodable>(_ report: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(report).write(to: url, options: [.atomic])
    }
}
