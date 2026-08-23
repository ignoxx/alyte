# Issue 31 privacy-workspace reference study

Studied on 2026-08-23. The unavailable Appllama catalogue was replaced with public product help,
App Store material, and the repo's pinned T3 Code notes. These are interaction patterns, not visual
assets to copy.

| Reference | Pattern extracted for Alyte |
| --- | --- |
| Apple Preview on iPhone — annotate | A document owns the canvas; editing tools become a compact bottom toolbar. |
| Apple Preview on iPhone — organize pages | Page transforms live with the selected thumbnail in a page manager/menu. |
| Apple Files Quick Look | The document is edge-to-edge, aspect-correct, and uses system navigation chrome. |
| Apple Notes PDF attachments | Page thumbnails navigate; rotate/crop are page actions rather than permanent canvas controls. |
| Apple Markup | Selection is explicit, handles are direct-manipulation targets, and Undo/Redo stay close to the tool. |
| Adobe Acrobat mobile — Organize Pages | Reorder is thumbnail-driven; deletion/exclusion and rotation are contextual page operations. |
| Adobe Acrobat mobile — Redact | Redaction is a deliberate mode and completion is distinguished from editable markup. |
| PDF Expert iOS — reader | One high-resolution page remains primary; reading gestures work without an editor-card wrapper. |
| PDF Expert iOS — Redact | Sensitive-area editing is direct on the page and destructive output is a separate save result. |
| Foxit PDF Editor iOS | Advanced page actions are grouped away from the everyday reading toolbar. |
| Smallpdf mobile editor | The primary task stays legible by separating canvas tools from document organization. |
| T3 Code mobile (repo-pinned study) | Native stack/modal grammar, restrained semantic color, and system-owned motion/materials. |

Resulting grammar: root full-screen modal above tabs; visible Cancel/Done; PDFKit owns zoom, pan,
double-tap, page geometry, and crisp rendering; Redact/Undo/Redo/Pages form the only persistent
bottom toolbar; transforms move into the page manager; no decorative motion or custom glass.

Public sources:

- https://support.apple.com/guide/iphone/add-delete-rotate-move-or-crop-pdf-pages-iphbf4977cff/26/ios/26
- https://support.apple.com/guide/iphone/iph73ca5c8e6/ios
- https://support.apple.com/guide/iphone/work-with-pdfs-iph8958dd125/ios
- https://helpx.adobe.com/acrobat/mobile/organize-pdfs/delete-pages.html
- https://www.adobe.com/acrobat/hub/how-to-edit-pdfs-on-iphone.html
- https://pdfexpert.com/ios/features/pdf-edit-ios
- https://pdfexpert.com/ios/how-to-edit-pdf
- https://pdfexpert.com/ios/features
- https://apps.apple.com/us/app/foxit-pdf-editor/id507040546
- https://www.smallpdf.com/mobile-app
