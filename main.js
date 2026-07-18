const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const AdmZip = require('adm-zip')

// כתובת האתר החי של אוצריא, ממנו שואבים את רשימת התוספים
const BASE_URL = 'https://otzaria.org'

// תיקיית האפליקציה עצמה - המקום שאליו נשמרים הנתונים, כדי שיהיו צמודים לתוכנה (נייד לגמרי):
//   • גרסה ניידת (portable): electron-builder מחלץ את האפליקציה לתיקייה זמנית ומריץ משם,
//     ולכן process.execPath מצביע על התיקייה הזמנית ולא על מיקום ה-EXE שהמשתמש הפעיל.
//     המשתנה PORTABLE_EXECUTABLE_DIR מכיל את התיקייה של ה-EXE האמיתי - זה מה שאנחנו רוצים.
//   • גרסה מותקנת (NSIS): תיקיית קובץ ההרצה המותקן.
//   • זמן פיתוח: תיקיית הפרויקט.
const APP_DIR =
  process.env.PORTABLE_EXECUTABLE_DIR ||
  (app.isPackaged ? path.dirname(process.execPath) : __dirname)

// תיקיית הנתונים המקומית - צמודה לתיקיית האפליקציה עצמה, כדי שהעתקת התיקייה (למשל לדיסק-און-קי) תעביר גם את הנתונים
const DATA_DIR = path.join(APP_DIR, 'plugins-store-data')
const FILES_DIR = path.join(DATA_DIR, 'files')
const DB_PATH = path.join(DATA_DIR, 'db.json')

let mainWindow = null

function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(FILES_DIR, { recursive: true })
}

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { lastSync: null, plugins: [] }
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8')
}

// ---- עזרי הורדה ----

const EXT_BY_CONTENT_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg'
}

function extFromContentDisposition(header) {
  if (!header) return null
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match) {
    try {
      const name = decodeURIComponent(utf8Match[1])
      return { name, ext: path.extname(name) || '' }
    } catch {
      /* ignore */
    }
  }
  const plainMatch = header.match(/filename="?([^";]+)"?/i)
  if (plainMatch) {
    const name = plainMatch[1]
    return { name, ext: path.extname(name) || '' }
  }
  return null
}

async function downloadToFile(url, destPathNoExt, { preferredExt } = {}) {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} עבור ${url}`)
  }
  const contentType = res.headers.get('content-type') || ''
  const disposition = res.headers.get('content-disposition')
  const fromDisposition = extFromContentDisposition(disposition)

  let ext = preferredExt || null
  let originalName = null
  if (fromDisposition) {
    ext = fromDisposition.ext || ext
    originalName = fromDisposition.name
  } else if (EXT_BY_CONTENT_TYPE[contentType.split(';')[0].trim()]) {
    ext = EXT_BY_CONTENT_TYPE[contentType.split(';')[0].trim()]
  }
  if (!ext) ext = ''

  const buf = Buffer.from(await res.arrayBuffer())
  const destPath = destPathNoExt + ext
  await fsp.writeFile(destPath, buf)
  return { ext, size: buf.length, originalName, path: destPath }
}

// ---- חילוץ ה-id האמיתי מתוך manifest.json שבתוך קובץ ה-.otzplugin עצמו ----
// שדה ה-id שה-API הציבורי של האתר מחזיר הוא מזהה מסד-הנתונים של האתר, ולא ה-id
// שאוצריא בפועל משתמשת בו לתיקיית ההתקנה אצל המשתמש (installed/<manifestId>).
// לכן חייבים לחלץ אותו ישירות מתוך קובץ התוסף שכבר יש לנו מקומית.
function readManifestIdFromPluginFile(filePath) {
  try {
    const zip = new AdmZip(filePath)
    const entry = zip.getEntry('manifest.json')
    if (!entry) return null
    const manifest = JSON.parse(entry.getData().toString('utf-8'))
    return typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : null
  } catch {
    return null // קובץ פגום/לא ZIP תקין - פשוט מתעלמים, ההתאמה למותקן פשוט לא תעבוד לתוסף הזה
  }
}

// ---- לוגיקת סנכרון ----

async function syncNow(sender) {
  ensureDataDirs()
  const send = (payload) => {
    if (sender && !sender.isDestroyed()) sender.send('sync-progress', payload)
  }

  send({ phase: 'start', message: 'טוען את רשימת התוספים מהאתר...' })

  const listRes = await fetch(`${BASE_URL}/api/plugins`)
  if (!listRes.ok) {
    throw new Error(`לא ניתן לטעון את רשימת התוספים (HTTP ${listRes.status})`)
  }
  const remotePlugins = await listRes.json()

  const db = loadDB()
  const existingById = new Map((db.plugins || []).map((p) => [p.id, p]))
  const newPlugins = []
  let done = 0
  const total = remotePlugins.length

  for (const rp of remotePlugins) {
    done += 1
    send({
      phase: 'plugin',
      current: done,
      total,
      message: `מסנכרן: ${rp.name} (${done}/${total})`
    })

    const pluginDir = path.join(FILES_DIR, rp.id)
    fs.mkdirSync(pluginDir, { recursive: true })

    const existing = existingById.get(rp.id)
    const localPlugin = {
      id: rp.id,
      name: rp.name,
      shortDescription: rp.shortDescription,
      description: rp.description,
      version: rp.version,
      status: rp.status,
      author: rp.author,
      updatedAt: rp.updatedAt,
      originalDate: rp.originalDate,
      compatibleWith: rp.compatibleWith,
      maxAppVersion: rp.maxAppVersion,
      requiresNetwork: rp.requiresNetwork,
      tags: rp.tags || [],
      homepage: rp.homepage || '',
      downloadCount: rp.downloadCount || 0,
      supportsDirectInstall: rp.supportsDirectInstall,
      isPinned: rp.isPinned,
      remoteDownloadUrl: `${BASE_URL}${rp.downloadUrl}`,
      image: existing?.image || null,
      screenshots: existing?.screenshots || [],
      localFile: existing?.localFile || null,
      manifestId: existing?.manifestId || null
    }

    // התמונה וצילומי המסך קטנים ומתעדכנים בכל סנכרון
    if (rp.image) {
      try {
        const imgResult = await downloadToFile(`${BASE_URL}${rp.image}`, path.join(pluginDir, 'image'))
        localPlugin.image = path.relative(DATA_DIR, imgResult.path)
      } catch (err) {
        send({ phase: 'warning', message: `לא ניתן להוריד תמונה עבור ${rp.name}: ${err.message}` })
      }
    }

    const screenshots = []
    for (let i = 0; i < (rp.screenshots || []).length; i++) {
      try {
        const shotResult = await downloadToFile(
          `${BASE_URL}${rp.screenshots[i]}`,
          path.join(pluginDir, `screenshot-${i}`)
        )
        screenshots.push(path.relative(DATA_DIR, shotResult.path))
      } catch (err) {
        send({ phase: 'warning', message: `לא ניתן להוריד צילום מסך עבור ${rp.name}: ${err.message}` })
      }
    }
    if (screenshots.length > 0) localPlugin.screenshots = screenshots

    // מדלגים על הורדה חוזרת של קובץ התוסף (עלול להיות גדול) אם הגרסה לא השתנתה וכבר קיים קובץ מקומי
    const versionUnchanged = existing && existing.version === rp.version && existing.localFile
    if (!versionUnchanged) {
      // קובץ התוסף עצמו
      try {
        const fileResult = await downloadToFile(
          `${BASE_URL}${rp.downloadUrl}`,
          path.join(pluginDir, 'plugin'),
          { preferredExt: '.otzplugin' }
        )
        localPlugin.localFile = {
          path: path.relative(DATA_DIR, fileResult.path),
          fileName: fileResult.originalName || `${rp.name}${fileResult.ext}`,
          ext: fileResult.ext,
          size: fileResult.size
        }
        localPlugin.manifestId = readManifestIdFromPluginFile(fileResult.path)
      } catch (err) {
        send({ phase: 'warning', message: `לא ניתן להוריד את קובץ התוסף ${rp.name}: ${err.message}` })
      }
    } else if (!localPlugin.manifestId && localPlugin.localFile) {
      // תוסף שכבר סונכרן בעבר (לפני שהתוספת הזו נכתבה) - נחלץ את ה-manifestId מהקובץ הקיים בלי להוריד מחדש
      localPlugin.manifestId = readManifestIdFromPluginFile(path.join(DATA_DIR, localPlugin.localFile.path))
    }

    newPlugins.push(localPlugin)
  }

  db.plugins = newPlugins
  db.lastSync = new Date().toISOString()
  saveDB(db)

  send({ phase: 'done', total, message: 'הסנכרון הושלם' })
  return { total, lastSync: db.lastSync }
}

// ---- זיהוי תוספים המותקנים כבר באוצריא ----

// אוצריא שומרת כל תוסף מותקן בתיקייה משלו, ובתוכה תת-תיקיית current/manifest.json עם הגרסה המותקנת:
// %APPDATA%/otzaria/plugins/installed/<plugin-id>/current/manifest.json
const OTZARIA_INSTALLED_DIR = path.join(app.getPath('appData'), 'otzaria', 'plugins', 'installed')

function readInstalledManifest(pluginId) {
  const manifestPath = path.join(OTZARIA_INSTALLED_DIR, pluginId, 'current', 'manifest.json')
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    const manifest = JSON.parse(raw)
    return manifest.version || null
  } catch {
    return null // אין מניפסט תקין - מתעלמים בשקט מהתוסף הזה
  }
}

function scanInstalledPlugins() {
  const result = {}
  let entries
  try {
    entries = fs.readdirSync(OTZARIA_INSTALLED_DIR, { withFileTypes: true })
  } catch {
    return result // אוצריא לא מותקנת, או שאין עדיין תוספים מותקנים
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const version = readInstalledManifest(entry.name)
    if (version) result[entry.name] = version
  }
  return result
}

// ---- עזרי הגשת נתיבים מקומיים לחלון (file://) ----

function toFileUrl(relPath) {
  if (!relPath) return null
  const abs = path.join(DATA_DIR, relPath)
  let posixPath = abs.split(path.sep).join('/')
  if (!posixPath.startsWith('/')) posixPath = '/' + posixPath // makes Windows "C:/..." -> "/C:/..."
  return 'file://' + encodeURI(posixPath)
}

function decorateForRenderer(plugin) {
  return {
    ...plugin,
    imageUrl: toFileUrl(plugin.image),
    screenshotUrls: (plugin.screenshots || []).map(toFileUrl)
  }
}

// ---- IPC ----

ipcMain.handle('get-plugins', () => {
  const db = loadDB()
  return {
    lastSync: db.lastSync,
    plugins: (db.plugins || []).map(decorateForRenderer)
  }
})

ipcMain.handle('get-plugin', (_event, id) => {
  const db = loadDB()
  const plugin = (db.plugins || []).find((p) => p.id === id)
  return plugin ? decorateForRenderer(plugin) : null
})

ipcMain.handle('sync-now', async (event) => {
  return syncNow(event.sender)
})

ipcMain.handle('get-installed-plugins', () => {
  return scanInstalledPlugins()
})

ipcMain.handle('download-plugin', async (_event, id) => {
  const db = loadDB()
  const plugin = (db.plugins || []).find((p) => p.id === id)
  if (!plugin || !plugin.localFile) {
    return { ok: false, error: 'הקובץ אינו זמין באופן מקומי. יש לבצע סנכרון קודם.' }
  }
  const sourcePath = path.join(DATA_DIR, plugin.localFile.path)
  const suggestedName = plugin.localFile.fileName || `${plugin.name}${plugin.localFile.ext || ''}`

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'שמירת התוסף',
    defaultPath: suggestedName,
    filters: plugin.localFile.ext
      ? [{ name: 'קובץ תוסף', extensions: [plugin.localFile.ext.replace('.', '')] }]
      : undefined
  })

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true }
  }

  await fsp.copyFile(sourcePath, result.filePath)
  return { ok: true, path: result.filePath }
})

ipcMain.handle('open-install-url', (_event, url) => {
  shell.openExternal(url)
})

ipcMain.handle('open-external', (_event, url) => {
  shell.openExternal(url)
})

// ---- יצירת חלון ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'חנות תוספים לאוצריא - אופליין',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
}

app.whenReady().then(() => {
  ensureDataDirs()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
