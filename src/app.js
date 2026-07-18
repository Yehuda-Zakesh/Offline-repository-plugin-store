(() => {
  'use strict'

  const root = document.getElementById('app-root')
  const syncBtn = document.getElementById('sync-btn')
  const lastSyncLabel = document.getElementById('last-sync-label')
  const syncOverlay = document.getElementById('sync-overlay')
  const syncMessage = document.getElementById('sync-message')
  const syncProgressBar = document.getElementById('sync-progress-bar')
  const syncWarnings = document.getElementById('sync-warnings')

  const STATUS_LABELS = { stable: 'יציב', beta: 'בטא', experimental: 'ניסיוני' }

  let state = {
    plugins: [],
    lastSync: null,
    search: '',
    status: 'all',
    tag: 'all',
    installedMap: {}, // { pluginId: 'installedVersion' } - נטען מאוצריא בפועל אצל המשתמש
    hideInstalled: true // הצג רק מה שלא מותקן / יש לו עדכון זמין - מופעל כברירת מחדל
  }

  // ---------- השוואת גרסאות (semver בסיסי: major.minor.patch) ----------

  function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0)
      if (diff !== 0) return diff > 0 ? 1 : -1
    }
    return 0
  }

  // מחזיר: 'not-installed' | 'up-to-date' | 'update-available' | 'unknown'
  // ההשוואה מתבצעת לפי manifestId (ה-id האמיתי מתוך manifest.json בתוך קובץ התוסף),
  // ולא לפי id הקטלוג (שהוא מזהה מסד-הנתונים של האתר ולא תואם לתיקיות ההתקנה של אוצריא).
  function getInstallStatus(plugin) {
    if (!plugin.manifestId) return 'unknown' // עדיין לא חולץ (למשל התוסף לא הורד/נסרק מעולם)
    const installedVersion = state.installedMap[plugin.manifestId]
    if (!installedVersion) return 'not-installed'
    return compareVersions(plugin.version, installedVersion) > 0 ? 'update-available' : 'up-to-date'
  }

  // ---------- עברית: המרת מספר לגימטריה ותאריך עברי ----------

  function toHebrewNumeral(num) {
    const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט']
    const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ']
    const hundreds = ['', 'ק', 'ר', 'ש', 'ת']
    const thousands = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט']

    if (num === 0) return ''
    if (num > 9999) return String(num)

    let result = ''
    const thousandsDigit = Math.floor(num / 1000)
    if (thousandsDigit > 0) {
      result += thousands[thousandsDigit] + "'"
      num %= 1000
    }

    const hundredsDigit = Math.floor(num / 100)
    if (hundredsDigit > 0) {
      if (hundredsDigit <= 4) result += hundreds[hundredsDigit]
      else if (hundredsDigit === 5) result += 'תק'
      else if (hundredsDigit === 6) result += 'תר'
      else if (hundredsDigit === 7) result += 'תש'
      else if (hundredsDigit === 8) result += 'תת'
      else if (hundredsDigit === 9) result += 'תתק'
      num %= 100
    }

    if (num === 15) {
      result += 'טו'
    } else if (num === 16) {
      result += 'טז'
    } else {
      const tensDigit = Math.floor(num / 10)
      if (tensDigit > 0) {
        result += tens[tensDigit]
        num %= 10
      }
      if (num > 0) result += ones[num]
    }

    if (result.length === 1) result += "'"
    else if (result.length > 1) result = result.slice(0, -1) + '"' + result.slice(-1)

    return result
  }

  function formatHebrewDate(dateStr) {
    if (!dateStr) return ''
    try {
      let date
      if (dateStr.includes('T')) {
        date = new Date(dateStr)
      } else {
        const [year, month, dayNum] = dateStr.split('-').map(Number)
        date = new Date(Date.UTC(year, month - 1, dayNum, 12))
      }
      const formatter = new Intl.DateTimeFormat('he-u-ca-hebrew', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
      })
      const parts = formatter.formatToParts(date)
      const dayPart = parts.find((p) => p.type === 'day')
      const monthPart = parts.find((p) => p.type === 'month')
      const yearPart = parts.find((p) => p.type === 'year')
      if (!dayPart || !monthPart || !yearPart) return formatter.format(date)
      return `${toHebrewNumeral(parseInt(dayPart.value, 10))} ${monthPart.value} ${toHebrewNumeral(parseInt(yearPart.value, 10))}`
    } catch (err) {
      console.error('formatHebrewDate error', err)
      return dateStr
    }
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }

  // ---------- טעינת נתונים ----------

  async function loadPlugins() {
    const data = await window.api.getPlugins()
    state.plugins = data.plugins || []
    state.lastSync = data.lastSync
    updateLastSyncLabel()
    try {
      state.installedMap = await window.api.getInstalledPlugins()
    } catch (err) {
      console.error('getInstalledPlugins error', err)
      state.installedMap = {}
    }
  }

  function updateLastSyncLabel() {
    lastSyncLabel.textContent = state.lastSync
      ? `סונכרן לאחרונה: ${new Date(state.lastSync).toLocaleString('he-IL')}`
      : 'טרם בוצע סנכרון'
  }

  // ---------- ניתוב ----------

  function currentRoute() {
    const hash = location.hash.replace(/^#\/?/, '')
    if (hash.startsWith('plugin/')) {
      return { view: 'detail', id: decodeURIComponent(hash.slice('plugin/'.length)) }
    }
    return { view: 'list' }
  }

  window.addEventListener('hashchange', render)

  async function render() {
    const route = currentRoute()
    if (route.view === 'detail') {
      renderDetail(route.id)
    } else {
      renderList()
    }
  }

  function navigate(hash) {
    location.hash = hash
  }

  // ---------- תצוגת רשימה ----------

  function getFilteredPlugins() {
    let list = state.plugins
    if (state.search) {
      const q = state.search.toLowerCase()
      list = list.filter((p) =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.shortDescription || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(q))
      )
    }
    if (state.status !== 'all') {
      list = list.filter((p) => p.status === state.status)
    }
    if (state.tag !== 'all') {
      list = list.filter((p) => (p.tags || []).includes(state.tag))
    }
    if (state.hideInstalled) {
      list = list.filter((p) => getInstallStatus(p) !== 'up-to-date')
    }
    return list
  }

  function getAllTags() {
    const tags = new Set()
    state.plugins.forEach((p) => (p.tags || []).forEach((t) => tags.add(t)))
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'he'))
  }

  const INSTALL_STATUS_BADGE = {
    'up-to-date': '<span class="badge badge--installed">✓ מותקן</span>',
    'update-available': '<span class="badge badge--update">↑ עדכון זמין</span>'
  }

  function pluginCardHtml(plugin) {
    const imgSrc = plugin.imageUrl || '../assets/logo.svg'
    const tags = (plugin.tags || []).slice(0, 4)
    const installBadge = INSTALL_STATUS_BADGE[getInstallStatus(plugin)] || ''
    return `
      <article class="plugin-card ${plugin.isPinned ? 'pinned' : ''}" data-id="${escapeHtml(plugin.id)}">
        <div class="plugin-card__image-wrap" data-action="open-detail">
          <img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(plugin.name)}" loading="lazy" />
          ${plugin.isPinned ? '<span class="pinned-badge">📌 מומלץ</span>' : ''}
        </div>
        <div class="plugin-card__body">
          <div class="badge-row">
            <span class="badge badge--status">${STATUS_LABELS[plugin.status] || 'לא ידוע'}</span>
            <span class="badge">גרסה ${escapeHtml(plugin.version)}</span>
            <span class="badge">⬇ ${(plugin.downloadCount || 0).toLocaleString('he-IL')}</span>
            ${installBadge}
          </div>
          <div>
            <div class="plugin-card__title" data-action="open-detail">${escapeHtml(plugin.name)}</div>
            <p class="plugin-card__desc">${escapeHtml(plugin.shortDescription)}</p>
          </div>
          <div class="mini-tags">
            ${tags.map((t) => `<span class="mini-tag">${escapeHtml(t)}</span>`).join('')}
          </div>
          <div class="plugin-card__actions">
            <button class="btn btn--primary btn--sm" data-action="download">הורדה</button>
            ${plugin.supportsDirectInstall
              ? '<button class="btn btn--outline btn--sm" data-action="direct-install">התקנה ישירה</button>'
              : ''}
          </div>
          <div class="plugin-card__footer">
            <a href="#" data-action="open-detail">לפרטים מלאים</a>
            <span>עודכן ב־${formatHebrewDate(plugin.originalDate || plugin.updatedAt)}</span>
          </div>
        </div>
      </article>
    `
  }

  function renderList() {
    const filtered = getFilteredPlugins()
    const allTags = getAllTags()

    let summaryText
    if (filtered.length === 0) summaryText = 'לא נמצאו תוספים לפי הסינון שבחרתם'
    else if (filtered.length === state.plugins.length) summaryText = 'כל התוספים מוצגים'
    else summaryText = `מוצגים ${filtered.length} מתוך ${state.plugins.length} תוספים`

    const gridHtml = filtered.length === 0
      ? `<div class="empty-state">
          <h3>${state.plugins.length === 0 ? 'עדיין לא סונכרנו תוספים' : 'לא נמצאו תוספים לפי הסינון שבחרתם'}</h3>
          <p>${state.plugins.length === 0
            ? 'לחצו על "סנכרון מהאתר" כדי לטעון את רשימת התוספים העדכנית מ־otzaria.org.'
            : 'נסו לחפש בשם אחר, להסיר תגית, או לבחור סטטוס שונה כדי לראות תוצאות נוספות.'}</p>
        </div>`
      : `<div class="plugin-grid">${filtered.map(pluginCardHtml).join('')}</div>`

    root.innerHTML = `
      <section class="filters">
        <div class="filters__row">
          <div class="field">
            <label for="search-input">חיפוש</label>
            <input id="search-input" type="search" placeholder="שם, תיאור או תגית..." value="${escapeHtml(state.search)}" />
          </div>
          <div class="field">
            <label for="status-select">סטטוס</label>
            <select id="status-select">
              <option value="all">הכול</option>
              <option value="stable">יציב</option>
              <option value="beta">בטא</option>
              <option value="experimental">ניסיוני</option>
            </select>
          </div>
          <div class="field field--toggle">
            <span class="field__label-spacer"></span>
            <button type="button" id="hide-installed-toggle" class="toggle-switch ${state.hideInstalled ? 'is-on' : ''}" role="switch" aria-checked="${state.hideInstalled}">
              <span class="toggle-switch__track"><span class="toggle-switch__thumb"></span></span>
              <span class="toggle-switch__label">הצג רק מה שלא מותקן / יש לו עדכון</span>
            </button>
            <span class="field__hint">זוהו ${Object.keys(state.installedMap).length} תוספים מותקנים באוצריא</span>
          </div>
        </div>
        ${allTags.length > 0 ? `
          <div class="tags-row">
            <button class="tag-pill ${state.tag === 'all' ? 'active' : ''}" data-tag="all">כל התגיות</button>
            ${allTags.map((t) => `<button class="tag-pill ${state.tag === t ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
          </div>` : ''}
      </section>

      <div class="results-summary">
        <h2>בחרו את התוסף שמתאים לכם</h2>
        <p>${summaryText}</p>
      </div>

      ${gridHtml}
    `

    const searchInput = document.getElementById('search-input')
    searchInput.addEventListener('input', (e) => {
      state.search = e.target.value
      renderList()
      searchInput.focus()
      searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length
    })

    const statusSelect = document.getElementById('status-select')
    statusSelect.value = state.status
    statusSelect.addEventListener('change', (e) => {
      state.status = e.target.value
      renderList()
    })

    const hideInstalledToggle = document.getElementById('hide-installed-toggle')
    hideInstalledToggle.addEventListener('click', () => {
      state.hideInstalled = !state.hideInstalled
      renderList()
    })

    root.querySelectorAll('.tag-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.tag = btn.dataset.tag
        renderList()
      })
    })

    root.querySelectorAll('.plugin-card').forEach((card) => {
      const id = card.dataset.id
      card.querySelectorAll('[data-action="open-detail"]').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.preventDefault()
          navigate(`plugin/${encodeURIComponent(id)}`)
        })
      })
      const dl = card.querySelector('[data-action="download"]')
      if (dl) dl.addEventListener('click', () => handleDownload(id, dl))
      const inst = card.querySelector('[data-action="direct-install"]')
      if (inst) inst.addEventListener('click', () => handleDirectInstall(id))
    })
  }

  // ---------- תצוגת פרטי תוסף ----------

  let lightboxIndex = null

  function renderDetail(id) {
    const plugin = state.plugins.find((p) => p.id === id)
    if (!plugin) {
      root.innerHTML = `
        <div class="empty-state">
          <h3>התוסף לא נמצא</h3>
          <p>ייתכן שהתוסף הוסר, או שטרם בוצע סנכרון.</p>
          <div style="margin-top:16px;"><button class="btn btn--ghost" id="back-to-list">חזרה לחנות</button></div>
        </div>`
      document.getElementById('back-to-list').addEventListener('click', () => navigate(''))
      return
    }

    lightboxIndex = null
    const imgSrc = plugin.imageUrl || '../assets/logo.svg'
    const screenshots = plugin.screenshotUrls || []

    root.innerHTML = `
      <button class="back-link" id="back-link">→ חזרה לחנות</button>

      <div class="detail-panel">
        <div class="detail-hero">
          <div class="detail-hero__image"><img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(plugin.name)}" /></div>
          <div>
            <h1 class="detail-hero__title">${escapeHtml(plugin.name)}</h1>
            <p class="detail-hero__desc">${escapeHtml(plugin.description)}</p>
            <div class="badge-row" style="margin-bottom:16px;">
              <span class="badge badge--status">${STATUS_LABELS[plugin.status] || 'לא ידוע'}</span>
              <span class="badge">גרסה ${escapeHtml(plugin.version)}</span>
              <span class="badge">⬇ ${(plugin.downloadCount || 0).toLocaleString('he-IL')} הורדות</span>
              ${INSTALL_STATUS_BADGE[getInstallStatus(plugin)] || ''}
            </div>
            <div class="plugin-card__actions" style="flex-wrap:wrap;">
              <button class="btn btn--primary" id="detail-download">⬇ הורדה</button>
              ${plugin.supportsDirectInstall ? '<button class="btn btn--outline" id="detail-install">💻 התקנה ישירה לאוצריא</button>' : ''}
              ${plugin.homepage ? `<button class="btn btn--ghost" id="detail-homepage">🔗 מקור</button>` : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="info-panel">
          <h2>מידע כללי</h2>
          <div class="info-cells">
            <div class="info-cell"><div class="label">גרסה</div><div class="value">${escapeHtml(plugin.version)}</div></div>
            <div class="info-cell"><div class="label">סטטוס</div><div class="value">${STATUS_LABELS[plugin.status] || 'לא ידוע'}</div></div>
            <div class="info-cell"><div class="label">מפתח</div><div class="value">${escapeHtml(plugin.author)}</div></div>
            <div class="info-cell"><div class="label">עודכן</div><div class="value">${formatHebrewDate(plugin.originalDate || plugin.updatedAt)}</div></div>
            <div class="info-cell span-2"><div class="label">תאימות</div><div class="value">${escapeHtml(plugin.compatibleWith)}</div></div>
            <div class="info-cell span-2"><div class="label">חיבור אינטרנט</div><div class="value">${plugin.requiresNetwork ? 'נדרש' : 'לא נדרש'}</div></div>
          </div>
        </div>
        <div class="tags-panel">
          <h2>תגיות</h2>
          <div class="mini-tags">
            ${(plugin.tags || []).map((t) => `<button class="tag-pill tag-jump" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('') || '<span>אין תגיות</span>'}
          </div>
        </div>
      </div>

      ${screenshots.length > 0 ? `
        <div class="screenshots-panel">
          <h2>צילומי מסך</h2>
          <div class="screenshots-grid">
            ${screenshots.map((src, i) => `<button data-index="${i}"><img src="${escapeHtml(src)}" alt="צילום מסך ${i + 1}" loading="lazy" /></button>`).join('')}
          </div>
        </div>` : ''}
    `

    document.getElementById('back-link').addEventListener('click', () => navigate(''))
    document.getElementById('detail-download').addEventListener('click', (e) => handleDownload(plugin.id, e.currentTarget))
    const installBtn = document.getElementById('detail-install')
    if (installBtn) installBtn.addEventListener('click', () => handleDirectInstall(plugin.id))
    const homeBtn = document.getElementById('detail-homepage')
    if (homeBtn) homeBtn.addEventListener('click', () => window.api.openExternal(plugin.homepage))

    root.querySelectorAll('.tag-jump').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.tag = btn.dataset.tag
        state.search = ''
        state.status = 'all'
        navigate('')
      })
    })

    if (screenshots.length > 0) {
      root.querySelectorAll('.screenshots-grid button').forEach((btn) => {
        btn.addEventListener('click', () => openLightbox(parseInt(btn.dataset.index, 10), screenshots))
      })
    }
  }

  function openLightbox(index, screenshots) {
    lightboxIndex = index
    renderLightbox(screenshots)
  }

  function renderLightbox(screenshots) {
    let el = document.querySelector('.lightbox')
    if (lightboxIndex === null) {
      if (el) el.remove()
      return
    }
    if (!el) {
      el = document.createElement('div')
      el.className = 'lightbox'
      document.body.appendChild(el)
      el.addEventListener('click', () => { lightboxIndex = null; renderLightbox(screenshots) })
    }
    el.innerHTML = `
      <button class="lightbox-nav lightbox-nav--prev">›</button>
      <img src="${escapeHtml(screenshots[lightboxIndex])}" alt="צילום מסך ${lightboxIndex + 1}" />
      <button class="lightbox-nav lightbox-nav--next">‹</button>
      <button class="lightbox-close">✕</button>
      <div class="lightbox-counter">${lightboxIndex + 1} / ${screenshots.length}</div>
    `
    el.querySelector('img').addEventListener('click', (e) => e.stopPropagation())
    el.querySelector('.lightbox-nav--prev').addEventListener('click', (e) => {
      e.stopPropagation()
      lightboxIndex = lightboxIndex > 0 ? lightboxIndex - 1 : screenshots.length - 1
      renderLightbox(screenshots)
    })
    el.querySelector('.lightbox-nav--next').addEventListener('click', (e) => {
      e.stopPropagation()
      lightboxIndex = lightboxIndex < screenshots.length - 1 ? lightboxIndex + 1 : 0
      renderLightbox(screenshots)
    })
    el.querySelector('.lightbox-close').addEventListener('click', (e) => {
      e.stopPropagation()
      lightboxIndex = null
      renderLightbox(screenshots)
    })
  }

  document.addEventListener('keydown', (e) => {
    if (lightboxIndex === null) return
    const route = currentRoute()
    if (route.view !== 'detail') return
    const plugin = state.plugins.find((p) => p.id === route.id)
    const screenshots = plugin ? (plugin.screenshotUrls || []) : []
    if (screenshots.length === 0) return
    if (e.key === 'Escape') { lightboxIndex = null; renderLightbox(screenshots) }
    if (e.key === 'ArrowLeft') { lightboxIndex = lightboxIndex < screenshots.length - 1 ? lightboxIndex + 1 : 0; renderLightbox(screenshots) }
    if (e.key === 'ArrowRight') { lightboxIndex = lightboxIndex > 0 ? lightboxIndex - 1 : screenshots.length - 1; renderLightbox(screenshots) }
  })

  // ---------- פעולות: הורדה / התקנה ישירה ----------

  async function handleDownload(id, triggerEl) {
    const original = triggerEl ? triggerEl.textContent : null
    if (triggerEl) { triggerEl.disabled = true; triggerEl.textContent = 'שומר...' }
    try {
      const result = await window.api.downloadPlugin(id)
      if (result.canceled) return
      if (!result.ok) {
        alert(result.error || 'שגיאה בהורדת הקובץ')
      }
    } catch (err) {
      alert('שגיאה בהורדת הקובץ: ' + err.message)
    } finally {
      if (triggerEl) { triggerEl.disabled = false; triggerEl.textContent = original }
    }
  }

  function handleDirectInstall(id) {
    const plugin = state.plugins.find((p) => p.id === id)
    if (!plugin || !plugin.remoteDownloadUrl) return
    const url = `otzaria://plugin/install?url=${encodeURIComponent(plugin.remoteDownloadUrl)}`
    window.api.openInstallUrl(url)
  }

  // ---------- סנכרון ----------

  function setSyncOverlay(visible) {
    syncOverlay.classList.toggle('hidden', !visible)
  }

  async function runSync() {
    syncBtn.disabled = true
    setSyncOverlay(true)
    syncWarnings.innerHTML = ''
    syncMessage.textContent = 'מתחיל סנכרון...'
    syncProgressBar.style.width = '0%'

    const unsubscribe = window.api.onSyncProgress((payload) => {
      if (payload.phase === 'plugin' && payload.total) {
        const pct = Math.round((payload.current / payload.total) * 100)
        syncProgressBar.style.width = pct + '%'
      }
      if (payload.message) syncMessage.textContent = payload.message
      if (payload.phase === 'warning') {
        const line = document.createElement('div')
        line.textContent = '⚠ ' + payload.message
        syncWarnings.appendChild(line)
      }
    })

    try {
      await window.api.syncNow()
      syncProgressBar.style.width = '100%'
      await loadPlugins()
      render()
    } catch (err) {
      syncMessage.textContent = 'שגיאת סנכרון: ' + err.message
      await new Promise((r) => setTimeout(r, 2500))
    } finally {
      unsubscribe()
      syncBtn.disabled = false
      setSyncOverlay(false)
    }
  }

  syncBtn.addEventListener('click', runSync)

  // ---------- הודעת "עדכונים זמינים" בפתיחת האפליקציה ----------

  function getUpdatablePlugins() {
    return state.plugins.filter((p) => getInstallStatus(p) === 'update-available')
  }

  function showUpdatesModal(list) {
    const el = document.createElement('div')
    el.className = 'sync-overlay'
    el.innerHTML = `
      <div class="sync-modal updates-modal">
        <h2 class="updates-modal__title">🔔 יש עדכונים זמינים (${list.length})</h2>
        <p class="updates-modal__subtitle">התוספים הבאים מותקנים אצלך באוצריא בגרסה ישנה יותר מזו שבחנות:</p>
        <div class="updates-modal__list">
          ${list.map((p) => `
            <button class="updates-modal__item" data-id="${escapeHtml(p.id)}">
              <span class="updates-modal__item-name">${escapeHtml(p.name)}</span>
              <span class="updates-modal__item-version">גרסה מותקנת ${escapeHtml(state.installedMap[p.manifestId] || '?')} ← גרסה חדשה ${escapeHtml(p.version)}</span>
            </button>
          `).join('')}
        </div>
        <button class="btn btn--primary" id="updates-modal-close">סגירה</button>
      </div>
    `
    document.body.appendChild(el)

    el.querySelector('#updates-modal-close').addEventListener('click', () => el.remove())
    el.querySelectorAll('.updates-modal__item').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.remove()
        navigate(`plugin/${encodeURIComponent(btn.dataset.id)}`)
      })
    })
  }

  // ---------- אתחול ----------

  async function init() {
    root.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>טוען את חנות התוספים...</p>
      </div>`
    await loadPlugins()
    if (!location.hash) location.hash = '#/'
    render()

    const updatable = getUpdatablePlugins()
    if (updatable.length > 0) showUpdatesModal(updatable)
  }

  init()
})()
