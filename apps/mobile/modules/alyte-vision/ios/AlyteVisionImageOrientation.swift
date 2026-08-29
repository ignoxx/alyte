import CoreGraphics
import UIKit

/// Returns the only explicit page rotations accepted by the import contract.
///
/// The modulo is intentional: callers may persist a negative or wrapped right-angle value, but
/// no arbitrary angle is accepted and no orientation is inferred from recognized content.
func alyteValidatedRightAngleOrientation(_ orientation: Int) -> Int? {
  let normalized = ((orientation % 360) + 360) % 360
  guard normalized == 0 || normalized == 90 || normalized == 180 || normalized == 270 else {
    return nil
  }
  return normalized
}

/// Rasterizes a UIImage's raw pixels into a new, metadata-free, upright UIImage.
///
/// UIImage may carry EXIF orientation separately from its CGImage. Vision receives a CGImage, so
/// passing that raw image directly would discard the orientation. This function maps all eight
/// UIImage orientations explicitly and renders at native pixel dimensions. The input image and
/// its source bytes are never changed.
func alyteNormalizedImportedImage(_ image: UIImage) -> UIImage? {
  guard let source = image.cgImage else { return nil }

  let sourceSize = CGSize(width: source.width, height: source.height)
  let rotatesAxes = image.imageOrientation == .left
    || image.imageOrientation == .right
    || image.imageOrientation == .leftMirrored
    || image.imageOrientation == .rightMirrored
  let targetSize = rotatesAxes
    ? CGSize(width: sourceSize.height, height: sourceSize.width)
    : sourceSize

  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = false
  let rawImage = UIImage(cgImage: source, scale: 1, orientation: .up)
  return UIGraphicsImageRenderer(size: targetSize, format: format).image { context in
    context.cgContext.saveGState()
    context.cgContext.concatenate(alyteUIImageOrientationTransform(
      image.imageOrientation,
      sourceSize: sourceSize
    ))

    // The wrapper explicitly carries .up, so UIImage.draw(in:) has no metadata to interpret while
    // still using UIKit's renderer coordinate system consistently across simulator and device.
    rawImage.draw(in: CGRect(origin: .zero, size: sourceSize))
    context.cgContext.restoreGState()
  }
}

/// Applies one explicit Alyte right-angle rotation to an already normalized image.
///
/// This is deliberately separate from EXIF normalization so the two transforms are composed in a
/// visible, fixed order exactly once. The returned UIImage is always metadata-free and uses native
/// pixel dimensions, which is the CGImage passed to Vision.
func alyteRotatedImportedImage(_ image: UIImage, orientation: Int) -> UIImage? {
  guard let normalized = alyteValidatedRightAngleOrientation(orientation) else { return nil }
  guard normalized != 0, let source = image.cgImage else { return image }

  let sourceSize = CGSize(width: source.width, height: source.height)
  let targetSize = normalized == 90 || normalized == 270
    ? CGSize(width: sourceSize.height, height: sourceSize.width)
    : sourceSize
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = false
  let rawImage = UIImage(cgImage: source, scale: 1, orientation: .up)
  return UIGraphicsImageRenderer(size: targetSize, format: format).image { context in
    context.cgContext.saveGState()
    switch normalized {
    case 90:
      context.cgContext.translateBy(x: targetSize.width, y: 0)
      context.cgContext.rotate(by: .pi / 2)
    case 180:
      context.cgContext.translateBy(x: targetSize.width, y: targetSize.height)
      context.cgContext.rotate(by: .pi)
    case 270:
      context.cgContext.translateBy(x: 0, y: targetSize.height)
      context.cgContext.rotate(by: -.pi / 2)
    default:
      break
    }
    rawImage.draw(in: CGRect(origin: .zero, size: sourceSize))
    context.cgContext.restoreGState()
  }
}

/// Maps UIImage orientation metadata from raw-image coordinates into the top-left UIKit image
/// coordinates used by the rasterizer above. The eight transforms correspond to EXIF 1–8:
/// upright, mirrored upright, upside down, mirrored upside down, transpose, clockwise, transverse,
/// and counter-clockwise.
private func alyteUIImageOrientationTransform(
  _ orientation: UIImage.Orientation,
  sourceSize: CGSize
) -> CGAffineTransform {
  let width = sourceSize.width
  let height = sourceSize.height
  switch orientation {
  case .up:
    return .identity
  case .upMirrored:
    return CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: width, ty: 0)
  case .down:
    return CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: width, ty: height)
  case .downMirrored:
    return CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: height)
  case .leftMirrored:
    return CGAffineTransform(a: 0, b: 1, c: 1, d: 0, tx: 0, ty: 0)
  case .right:
    return CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: height, ty: 0)
  case .rightMirrored:
    return CGAffineTransform(a: 0, b: -1, c: -1, d: 0, tx: height, ty: width)
  case .left:
    return CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: width)
  @unknown default:
    return .identity
  }
}
