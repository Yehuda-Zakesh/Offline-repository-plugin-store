// גשר תאימות ל-Tauri: בונה בדיוק את אותו window.api שה-preload.js הישן של Electron חשף,
// כדי ש-app.js יעבוד בלי שום שינוי. כל הבדל בין Electron ל-Tauri מבודד כאן בלבד.
//
// דורש tauri.conf.json עם "app.withGlobalTauri": true, כדי ש-window.__TAURI__ יהיה זמין
// בלי import/bundler (בדיוק כמו שאר הקבצים כאן - HTML/JS פשוטים בלי בנייה).
(function () {
  const invoke = window.__TAURI__.core.invoke
  const convertFileSrc = window.__TAURI__.core.convertFileSrc
  const listen = window.__TAURI__.event.listen

  // ה-backend מחזיר נתיבים מוחלטים גולמיים (imagePath / screenshotPaths) כי טעינת קובץ מקומי
  // ב-webview של Tauri (בניגוד ל-Electron) חייבת לעבור דרך פרוטוקול ה-asset המאובטח שלו.
  // convertFileSrc הופך נתיב מוחלט לכתובת asset: שה-webview מסכים לטעון.
  function decorate(plugin) {
    if (!plugin) return plugin
    return {
      ...plugin,
      imageUrl: plugin.imagePath ? convertFileSrc(plugin.imagePath) : null,
      screenshotUrls: (plugin.screenshotPaths || []).map((p) => convertFileSrc(p))
    }
  }

  window.api = {
    getPlugins: async () => {
      const result = await invoke('get_plugins')
      return { lastSync: result.lastSync, plugins: (result.plugins || []).map(decorate) }
    },
    getPlugin: async (id) => {
      const plugin = await invoke('get_plugin', { id })
      return decorate(plugin)
    },
    syncNow: () => invoke('sync_now'),
    getInstalledPlugins: () => invoke('get_installed_plugins'),
    downloadPlugin: (id) => invoke('download_plugin', { id }),
    directInstallPlugin: (id) => invoke('direct_install_plugin', { id }),
    openInstallUrl: (url) => invoke('open_external', { url }),
    openExternal: (url) => invoke('open_external', { url }),
    onSyncProgress: (callback) => {
      let unlisten = null
      let cancelled = false
      listen('sync-progress', (event) => callback(event.payload)).then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      return () => {
        cancelled = true
        if (unlisten) unlisten()
      }
    }
  }
})()
