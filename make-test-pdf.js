const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Test Page ${i}`, { x: 200, y: 700, size: 36, font, color: rgb(0.1, 0.2, 0.6) });
    page.drawRectangle({ x: 100, y: 300, width: 400, height: 200, borderColor: rgb(0.8, 0.2, 0.2), borderWidth: 3 });
  }
  fs.writeFileSync('test.pdf', await doc.save());
  console.log('test.pdf written');
})();
