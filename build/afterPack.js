// afterPack: מסיר קובצי שפה (locales) מיותרים של Chromium כדי להקטין את גודל האפליקציה.
// שומרים רק עברית ואנגלית. זה חוסך כמה מגהבייטים בקובץ ה-EXE הסופי.
const fs = require('fs')
const path = require('path')

// שמות הקבצים שנשמרים (שאר קובצי ה-.pak יימחקו)
const KEEP = new Set(['he.pak', 'en-US.pak'])

exports.default = async function afterPack(context) {
  const localesDir = path.join(context.appOutDir, 'locales')
  if (!fs.existsSync(localesDir)) return

  let removed = 0
  for (const file of fs.readdirSync(localesDir)) {
    if (file.endsWith('.pak') && !KEEP.has(file)) {
      fs.rmSync(path.join(localesDir, file))
      removed++
    }
  }
  console.log(`[afterPack] removed ${removed} unused locale files`)
}
