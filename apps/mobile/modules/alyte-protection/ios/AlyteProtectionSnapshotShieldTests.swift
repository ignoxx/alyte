import XCTest
import UIKit
@testable import AlyteProtection

final class AlyteProtectionSnapshotShieldTests: XCTestCase {
  func testClearBeforeInstallIsSafeAndIdempotent() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
    let shield = AlyteSnapshotShield(windowProvider: { [window] })

    shield.clear()
    shield.clear()

    XCTAssertFalse(shield.isInstalled())
    XCTAssertEqual(Self.shieldedViews(in: window).count, 0)
  }

  func testInstallsOpaqueShieldAcrossAllWindowsAndIsIdempotent() {
    let first = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
    let second = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
    var windows = [first, second]
    let shield = AlyteSnapshotShield(windowProvider: { windows })

    shield.install()
    shield.install()

    XCTAssertTrue(shield.isInstalled())
    XCTAssertEqual(Self.shieldedViews(in: first).count, 1)
    XCTAssertEqual(Self.shieldedViews(in: second).count, 1)
    XCTAssertTrue(Self.shieldedViews(in: first).first?.isOpaque == true)
    XCTAssertEqual(Self.shieldedViews(in: first).first?.backgroundColor, .systemBackground)

    let connected = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
    windows.append(connected)
    shield.reconcileConnectedScenes()
    XCTAssertEqual(Self.shieldedViews(in: connected).count, 1)
  }

  func testForegroundDoesNotAutoClearShield() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
    let shield = AlyteSnapshotShield(windowProvider: { [window] })

    shield.install()
    shield.reconcileConnectedScenes()

    XCTAssertTrue(shield.isInstalled())
    XCTAssertEqual(Self.shieldedViews(in: window).count, 1)
  }

  func testConcurrentInstallAndClearLeavesDeterministicClearResult() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
    let shield = AlyteSnapshotShield(windowProvider: { [window] })
    let finished = expectation(description: "concurrent lifecycle work finished")

    // Keep the test thread's main run loop available for the shield's synchronous UIKit work.
    DispatchQueue.global().async {
      let group = DispatchGroup()
      for _ in 0..<10 {
        group.enter()
        DispatchQueue.global().async {
          shield.install()
          group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
          shield.clear()
          group.leave()
        }
      }
      group.wait()
      DispatchQueue.main.async {
        shield.clear()
        XCTAssertFalse(shield.isInstalled())
        XCTAssertEqual(Self.shieldedViews(in: window).count, 0)
        finished.fulfill()
      }
    }

    wait(for: [finished], timeout: 10)
  }

  private static func shieldedViews(in window: UIWindow) -> [UIView] {
    window.subviews.filter { $0.accessibilityIdentifier == "alyte.snapshot-shield" }
  }
}
