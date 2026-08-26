import Foundation
import UIKit

private final class AlyteSnapshotShieldView: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = true
    backgroundColor = .systemBackground
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    accessibilityIdentifier = "alyte.snapshot-shield"
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}

/**
 * The shield is deliberately native and opaque. It is installed synchronously on the main
 * thread before UIKit takes a background snapshot; JavaScript can only clear it after its access
 * policy and authentication gate have resolved.
 */
final class AlyteSnapshotShield: @unchecked Sendable {
  static let shared = AlyteSnapshotShield(installLifecycleObservers: true)

  private let windowProvider: () -> [UIWindow]
  private let stateLock = NSLock()
  private var installed = false
  // The lifecycle subscriber changes this before installing on resignation. A JS clear that
  // arrives after that boundary must be a no-op; otherwise it could remove the fresh shield.
  private var applicationActive = true
  // React must explicitly acknowledge that its opaque startup/lock surface is mounted before a
  // JS clear can remove the native shield. This prevents a bootstrap failure from leaving an
  // opaque native view above an invisible or missing React error surface.
  private var reactGateMounted = false
  private var lifecycleObserversInstalled = false

  init(
    windowProvider: @escaping () -> [UIWindow] = AlyteSnapshotShield.connectedWindows,
    installLifecycleObservers: Bool = false
  ) {
    self.windowProvider = windowProvider
    if installLifecycleObservers {
      if Thread.isMainThread {
        installLifecycleObserversIfNeeded()
      } else {
        DispatchQueue.main.sync { self.installLifecycleObserversIfNeeded() }
      }
    }
  }

  func install() {
    performOnMainSync { [self] in
      installLifecycleObserversIfNeeded()
      setInstalled(true)
      applyToAllWindows()
    }
  }

  @discardableResult
  func clear() -> Bool {
    var cleared = false
    performOnMainSync { [self] in
      guard isApplicationActive() else {
        setInstalled(true)
        applyToAllWindows()
        return
      }
      // A clear request can arrive before the React root has committed. If the native lifecycle
      // has not installed a shield yet, preserve that state; otherwise restore the opaque shield.
      // This keeps the bridge idempotent in tests and in environments without a lifecycle event
      // while still failing closed whenever an installed shield is asked to clear too early.
      guard isReactGateMounted() else {
        if isInstalled() {
          setInstalled(true)
          applyToAllWindows()
        }
        return
      }
      setInstalled(false)
      for window in windowProvider() {
        window.subviews
          .compactMap { $0 as? AlyteSnapshotShieldView }
          .forEach { $0.removeFromSuperview() }
      }
      cleared = true
    }
    return cleared
  }

  func isInstalled() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return installed
  }

  /// Called by the React root after its opaque startup/lock surface has committed. This is a
  /// one-way readiness acknowledgement for the lifetime of the process.
  func markReactGateMounted() {
    performOnMainSync { [self] in
      stateLock.lock()
      reactGateMounted = true
      stateLock.unlock()
    }
  }

  /// Called only by the native app-delegate subscriber. JS intentionally has no install or
  /// lifecycle-control API; this state makes the clear boundary fail safe during deactivation.
  func setApplicationActive(_ active: Bool) {
    performOnMainSync { [self] in
      stateLock.lock()
      applicationActive = active
      stateLock.unlock()
      if !active {
        setInstalled(true)
        applyToAllWindows()
      }
    }
  }

  /// Reconciles all windows after a newly connected scene. Kept internal for deterministic tests.
  func reconcileConnectedScenes() {
    performOnMainSync { [self] in
      guard isInstalled() else { return }
      applyToAllWindows()
    }
  }

  private func setInstalled(_ value: Bool) {
    stateLock.lock()
    installed = value
    stateLock.unlock()
  }

  private func isApplicationActive() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return applicationActive
  }

  private func isReactGateMounted() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return reactGateMounted
  }

  private func installLifecycleObserversIfNeeded() {
    guard !lifecycleObserversInstalled else { return }
    lifecycleObserversInstalled = true
    let center = NotificationCenter.default
    center.addObserver(
      forName: UIScene.willConnectNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.reconcileConnectedScenes()
    }
    center.addObserver(
      forName: UIScene.didActivateNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.reconcileConnectedScenes()
    }
    center.addObserver(
      forName: UIScene.willDeactivateNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.install()
    }
  }

  private func applyToAllWindows() {
    for window in windowProvider() {
      let shield = window.subviews.compactMap { $0 as? AlyteSnapshotShieldView }.first
        ?? AlyteSnapshotShieldView(frame: window.bounds)
      if shield.superview == nil { window.addSubview(shield) }
      shield.frame = window.bounds
      shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      window.bringSubviewToFront(shield)
    }
  }

  private func performOnMainSync(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.sync(execute: work)
    }
  }

  private static func connectedWindows() -> [UIWindow] {
    if Thread.isMainThread {
      return MainActor.assumeIsolated { allConnectedWindows() }
    }

    return DispatchQueue.main.sync {
      MainActor.assumeIsolated { allConnectedWindows() }
    }
  }

  @MainActor
  private static func allConnectedWindows() -> [UIWindow] {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
  }
}
