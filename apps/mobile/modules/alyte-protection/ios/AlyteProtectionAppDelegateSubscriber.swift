import ExpoModulesCore
import UIKit

public final class AlyteProtectionAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func applicationWillResignActive(_ application: UIApplication) {
    AlyteSnapshotShield.shared.install()
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    AlyteSnapshotShield.shared.install()
  }

  // Deliberately no clear in either foreground callback. JS clears only after the lock policy and
  // any required authentication have resolved.
  public func applicationWillEnterForeground(_ application: UIApplication) {}

  public func applicationDidBecomeActive(_ application: UIApplication) {}
}
