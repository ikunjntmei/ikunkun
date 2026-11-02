'use strict';
const fs = require('fs');

function run(args) {
  // 非 macOS 环境（Windows / Linux）：直接拷贝基础 logo 作为环境图标，避免崩溃
  if (process.platform !== 'darwin') {
    try {
      const src = args[0];
      const dest = args[2];
      if (src && dest && fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    } catch {
      // 容错处理，保证主流程不中断
    }
    return;
  }

  // 以下保持 macOS 原生 AppKit 逻辑
  ObjC.import('AppKit');
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(1024, 1024));
  image.lockFocus;
  $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.98, 0.98, 0.99, 1).setFill;
  $.NSBezierPath.bezierPathWithRect($.NSMakeRect(0, 0, 1024, 1024)).fill;
  const base = $.NSImage.alloc.initWithContentsOfFile(args[0]);
  if (!base || base.isValid !== true) throw new Error('Cannot load IKUN logo');

  const source = base.size;
  base.drawInRectFromRectOperationFraction(
    $.NSMakeRect(112, 48, 800, 625),
    $.NSMakeRect(source.width * 0.125, source.height * 0.1953125, source.width * 0.75, source.height * 0.5859375),
    $.NSCompositingOperationSourceOver,
    1
  );

  const number = $(args[1]);
  let fontSize = 320;
  const attrs = $.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey($.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.06, 0.19, 0.36, 1), $.NSForegroundColorAttributeName);
  let size;
  do {
    attrs.setObjectForKey($.NSFont.boldSystemFontOfSize(fontSize), $.NSFontAttributeName);
    size = number.sizeWithAttributes(attrs);
    fontSize -= 8;
  } while (size.width > 880 && fontSize > 32);

  number.drawAtPointWithAttributes($.NSMakePoint(512 - size.width / 2, 860 - size.height / 2), attrs);
  image.unlockFocus;

  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (!data.writeToFileAtomically(args[2], true)) throw new Error('Cannot write profile icon');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { run };
}
