// otzaria-plugins-store - גרסת Tauri (Rust) של main.js המקורי (Electron).
// המטרה: אותה התנהגות בדיוק, קובץ exe קטן פי כמה כי אין Chromium+Node ארוזים בפנים -
// המשתמש טוען ב-WebView שכבר קיים בוינדוז.
//
// הערה: הקוד נכתב/נבדק תחביר-ית ביד (ה-sandbox הזה מריץ Rust ישן מדי כדי לקמפל Tauri v2
// במלואו). יש לבנות ולבדוק אצלך בוינדוז עם `cargo tauri build` / `cargo tauri dev` -
// ייתכנו תיקונים קטנים נדרשים בממשקי ה-API של tauri-plugin-dialog / tauri-plugin-shell
// אם הגרסה המדויקת שתתקין שונה מהצפוי (מסומן בהערות למטה במקומות הרגישים).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

const BASE_URL: &str = "https://otzaria.org";

// ---- נתיבים (מקביל ל-APP_DIR/DATA_DIR/FILES_DIR/DB_PATH ב-main.js) ----
// ב-Tauri (בניגוד ל-Electron portable) קובץ ה-exe רץ ישירות מהמיקום שלו בלי חילוץ
// לתיקייה זמנית, כך שאין צורך בלוגיקת PORTABLE_EXECUTABLE_DIR המיוחדת שהייתה ב-Electron.

struct AppPaths {
    data_dir: PathBuf,
    files_dir: PathBuf,
    db_path: PathBuf,
}

fn app_paths() -> AppPaths {
    let app_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let data_dir = app_dir.join("plugins-store-data");
    let files_dir = data_dir.join("files");
    let db_path = data_dir.join("db.json");
    AppPaths { data_dir, files_dir, db_path }
}

fn ensure_data_dirs(paths: &AppPaths) {
    let _ = fs::create_dir_all(&paths.data_dir);
    let _ = fs::create_dir_all(&paths.files_dir);
}

fn load_db(paths: &AppPaths) -> Value {
    fs::read_to_string(&paths.db_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({ "lastSync": null, "plugins": [] }))
}

fn save_db(paths: &AppPaths, db: &Value) -> std::io::Result<()> {
    let raw = serde_json::to_string_pretty(db).unwrap_or_default();
    fs::write(&paths.db_path, raw)
}

// ---- עזרי הורדה (מקביל ל-downloadToFile ב-main.js) ----

struct DownloadResult {
    path: PathBuf,
    ext: String,
    size: u64,
    original_name: Option<String>,
}

fn ext_by_content_type(ct: &str) -> Option<&'static str> {
    match ct {
        "image/png" => Some(".png"),
        "image/jpeg" | "image/jpg" => Some(".jpg"),
        "image/webp" => Some(".webp"),
        "image/gif" => Some(".gif"),
        "image/svg+xml" => Some(".svg"),
        _ => None,
    }
}

// מקביל ל-extFromContentDisposition ב-main.js
fn parse_content_disposition(header: &str) -> Option<(String, String)> {
    let lower = header.to_lowercase();
    if let Some(idx) = lower.find("filename*=utf-8''") {
        let rest = &header[idx + "filename*=utf-8''".len()..];
        let end = rest.find(';').unwrap_or(rest.len());
        let encoded = rest[..end].trim();
        if let Ok(decoded) = urlencoding::decode(encoded) {
            let decoded = decoded.into_owned();
            let ext = Path::new(&decoded)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            return Some((decoded, ext));
        }
    }
    if let Some(idx) = lower.find("filename=") {
        let rest = header[idx + "filename=".len()..].trim();
        let name = if let Some(stripped) = rest.strip_prefix('"') {
            let end = stripped.find('"').unwrap_or(stripped.len());
            stripped[..end].to_string()
        } else {
            let end = rest.find(';').unwrap_or(rest.len());
            rest[..end].trim().to_string()
        };
        if !name.is_empty() {
            let ext = Path::new(&name)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            return Some((name, ext));
        }
    }
    None
}

async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    dest_path_no_ext: &Path,
    preferred_ext: Option<&str>,
) -> Result<DownloadResult, String> {
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} עבור {}", res.status(), url));
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let disposition = res
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut ext = preferred_ext.map(|s| s.to_string());
    let mut original_name = None;
    if let Some(disp) = &disposition {
        if let Some((name, e)) = parse_content_disposition(disp) {
            original_name = Some(name);
            if !e.is_empty() {
                ext = Some(e);
            }
        }
    } else if let Some(e) = ext_by_content_type(content_type.split(';').next().unwrap_or("").trim()) {
        ext = Some(e.to_string());
    }
    let ext = ext.unwrap_or_default();

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let dest_path = PathBuf::from(format!("{}{}", dest_path_no_ext.display(), ext));
    fs::write(&dest_path, &bytes).map_err(|e| e.to_string())?;
    Ok(DownloadResult { path: dest_path, ext, size: bytes.len() as u64, original_name })
}

// ---- חילוץ ה-id האמיתי מתוך manifest.json בתוך קובץ ה-.otzplugin (zip) ----
fn read_manifest_id_from_plugin_file(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name("manifest.json").ok()?;
    let mut contents = String::new();
    entry.read_to_string(&mut contents).ok()?;
    let manifest: Value = serde_json::from_str(&contents).ok()?;
    manifest
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ---- לוגיקת סנכרון (מקביל ל-syncNow ב-main.js) ----

#[tauri::command]
async fn sync_now(window: tauri::Window) -> Result<Value, String> {
    let paths = app_paths();
    ensure_data_dirs(&paths);
    let send = |payload: Value| {
        let _ = window.emit("sync-progress", payload);
    };

    send(json!({ "phase": "start", "message": "טוען את רשימת התוספים מהאתר..." }));

    let client = reqwest::Client::new();
    let list_res = client
        .get(format!("{}/api/plugins", BASE_URL))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !list_res.status().is_success() {
        return Err(format!("לא ניתן לטעון את רשימת התוספים (HTTP {})", list_res.status()));
    }
    let remote_plugins: Vec<Value> = list_res.json().await.map_err(|e| e.to_string())?;

    let mut db = load_db(&paths);
    let existing_by_id: HashMap<String, Value> = db
        .get("plugins")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.get("id").and_then(|i| i.as_str()).map(|id| (id.to_string(), p.clone())))
                .collect()
        })
        .unwrap_or_default();

    let mut new_plugins = Vec::new();
    let total = remote_plugins.len();

    for (i, rp) in remote_plugins.iter().enumerate() {
        let done = i + 1;
        let rp_id = rp.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let rp_name = rp.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        send(json!({
            "phase": "plugin",
            "current": done,
            "total": total,
            "message": format!("מסנכרן: {} ({}/{})", rp_name, done, total)
        }));

        let plugin_dir = paths.files_dir.join(&rp_id);
        let _ = fs::create_dir_all(&plugin_dir);

        let existing = existing_by_id.get(&rp_id);
        let download_url = rp
            .get("downloadUrl")
            .and_then(|v| v.as_str())
            .map(|s| format!("{}{}", BASE_URL, s))
            .unwrap_or_default();

        let mut local_plugin = json!({
            "id": rp_id,
            "name": rp.get("name").cloned().unwrap_or(Value::Null),
            "shortDescription": rp.get("shortDescription").cloned().unwrap_or(Value::Null),
            "description": rp.get("description").cloned().unwrap_or(Value::Null),
            "version": rp.get("version").cloned().unwrap_or(Value::Null),
            "status": rp.get("status").cloned().unwrap_or(Value::Null),
            "author": rp.get("author").cloned().unwrap_or(Value::Null),
            "updatedAt": rp.get("updatedAt").cloned().unwrap_or(Value::Null),
            "originalDate": rp.get("originalDate").cloned().unwrap_or(Value::Null),
            "compatibleWith": rp.get("compatibleWith").cloned().unwrap_or(Value::Null),
            "maxAppVersion": rp.get("maxAppVersion").cloned().unwrap_or(Value::Null),
            "requiresNetwork": rp.get("requiresNetwork").cloned().unwrap_or(Value::Null),
            "tags": rp.get("tags").cloned().unwrap_or(json!([])),
            "homepage": rp.get("homepage").cloned().unwrap_or(json!("")),
            "downloadCount": rp.get("downloadCount").cloned().unwrap_or(json!(0)),
            "supportsDirectInstall": rp.get("supportsDirectInstall").cloned().unwrap_or(Value::Null),
            "isPinned": rp.get("isPinned").cloned().unwrap_or(Value::Null),
            "remoteDownloadUrl": download_url,
            "image": existing.and_then(|e| e.get("image")).cloned().unwrap_or(Value::Null),
            "screenshots": existing.and_then(|e| e.get("screenshots")).cloned().unwrap_or(json!([])),
            "localFile": existing.and_then(|e| e.get("localFile")).cloned().unwrap_or(Value::Null),
            "manifestId": existing.and_then(|e| e.get("manifestId")).cloned().unwrap_or(Value::Null),
        });

        // תמונה (מתעדכנת בכל סנכרון)
        if let Some(image_path) = rp.get("image").and_then(|v| v.as_str()) {
            match download_to_file(&client, &format!("{}{}", BASE_URL, image_path), &plugin_dir.join("image"), None).await {
                Ok(result) => {
                    if let Ok(rel) = result.path.strip_prefix(&paths.data_dir) {
                        local_plugin["image"] = json!(rel.to_string_lossy());
                    }
                }
                Err(err) => send(json!({ "phase": "warning", "message": format!("לא ניתן להוריד תמונה עבור {}: {}", rp_name, err) })),
            }
        }

        // צילומי מסך
        if let Some(shots) = rp.get("screenshots").and_then(|v| v.as_array()) {
            let mut screenshots = Vec::new();
            for (si, shot) in shots.iter().enumerate() {
                if let Some(shot_path) = shot.as_str() {
                    match download_to_file(&client, &format!("{}{}", BASE_URL, shot_path), &plugin_dir.join(format!("screenshot-{}", si)), None).await {
                        Ok(result) => {
                            if let Ok(rel) = result.path.strip_prefix(&paths.data_dir) {
                                screenshots.push(json!(rel.to_string_lossy()));
                            }
                        }
                        Err(err) => send(json!({ "phase": "warning", "message": format!("לא ניתן להוריד צילום מסך עבור {}: {}", rp_name, err) })),
                    }
                }
            }
            if !screenshots.is_empty() {
                local_plugin["screenshots"] = Value::Array(screenshots);
            }
        }

        // קובץ התוסף עצמו - מדלגים על הורדה חוזרת אם הגרסה לא השתנתה וכבר יש קובץ מקומי
        let rp_version = rp.get("version").and_then(|v| v.as_str()).unwrap_or("");
        let existing_version = existing.and_then(|e| e.get("version")).and_then(|v| v.as_str()).unwrap_or("");
        let existing_has_local_file = existing
            .map(|e| e.get("localFile").map(|v| !v.is_null()).unwrap_or(false))
            .unwrap_or(false);
        let version_unchanged = existing.is_some() && rp_version == existing_version && existing_has_local_file;

        if !version_unchanged {
            match download_to_file(&client, &download_url, &plugin_dir.join("plugin"), Some(".otzplugin")).await {
                Ok(result) => {
                    let rel = result.path.strip_prefix(&paths.data_dir).unwrap_or(&result.path).to_path_buf();
                    local_plugin["localFile"] = json!({
                        "path": rel.to_string_lossy(),
                        "fileName": result.original_name.clone().unwrap_or_else(|| format!("{}{}", rp_name, result.ext)),
                        "ext": result.ext,
                        "size": result.size
                    });
                    local_plugin["manifestId"] = json!(read_manifest_id_from_plugin_file(&result.path));
                }
                Err(err) => send(json!({ "phase": "warning", "message": format!("לא ניתן להוריד את קובץ התוסף {}: {}", rp_name, err) })),
            }
        } else if local_plugin.get("manifestId").map(|v| v.is_null()).unwrap_or(true) {
            if let Some(rel_path) = local_plugin.get("localFile").and_then(|lf| lf.get("path")).and_then(|v| v.as_str()) {
                let abs = paths.data_dir.join(rel_path);
                local_plugin["manifestId"] = json!(read_manifest_id_from_plugin_file(&abs));
            }
        }

        new_plugins.push(local_plugin);
    }

    let now = chrono::Utc::now().to_rfc3339();
    db["plugins"] = Value::Array(new_plugins);
    db["lastSync"] = json!(now);
    save_db(&paths, &db).map_err(|e| e.to_string())?;

    send(json!({ "phase": "done", "total": total, "message": "הסנכרון הושלם" }));
    Ok(json!({ "total": total, "lastSync": now }))
}

// ---- זיהוי תוספים המותקנים כבר באוצריא ----
// dirs::data_dir() בוינדוז = %APPDATA% בדיוק כמו app.getPath('appData') ב-Electron.

fn otzaria_installed_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("otzaria")
        .join("plugins")
        .join("installed")
}

fn read_installed_manifest(plugin_id: &str) -> Option<String> {
    let manifest_path = otzaria_installed_dir().join(plugin_id).join("current").join("manifest.json");
    let raw = fs::read_to_string(manifest_path).ok()?;
    let manifest: Value = serde_json::from_str(&raw).ok()?;
    manifest.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}

#[tauri::command]
fn get_installed_plugins() -> HashMap<String, String> {
    let mut result = HashMap::new();
    let dir = otzaria_installed_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return result, // אוצריא לא מותקנת, או שאין עדיין תוספים מותקנים
    };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                if let Some(version) = read_installed_manifest(name) {
                    result.insert(name.to_string(), version);
                }
            }
        }
    }
    result
}

// ---- עיטור תוצאה לרנדרר: מוסיפים נתיבים מוחלטים גולמיים (imagePath/screenshotPaths).
// ה-JS בצד הלקוח (tauri-bridge.js) ממיר אותם ל-asset: URL באמצעות convertFileSrc,
// כי webview של Tauri (בניגוד ל-Electron) לא טוען file:// ישירות מטעמי אבטחה.

fn decorate_for_renderer(plugin: &Value, data_dir: &Path) -> Value {
    let mut out = plugin.clone();
    let image_path = plugin
        .get("image")
        .and_then(|v| v.as_str())
        .map(|rel| data_dir.join(rel).to_string_lossy().to_string());
    out["imagePath"] = json!(image_path);
    let screenshot_paths: Vec<String> = plugin
        .get("screenshots")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str())
                .map(|rel| data_dir.join(rel).to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    out["screenshotPaths"] = json!(screenshot_paths);
    out
}

#[tauri::command]
fn get_plugins() -> Value {
    let paths = app_paths();
    let db = load_db(&paths);
    let plugins = db.get("plugins").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let decorated: Vec<Value> = plugins.iter().map(|p| decorate_for_renderer(p, &paths.data_dir)).collect();
    json!({ "lastSync": db.get("lastSync").cloned().unwrap_or(Value::Null), "plugins": decorated })
}

#[tauri::command]
fn get_plugin(id: String) -> Option<Value> {
    let paths = app_paths();
    let db = load_db(&paths);
    let plugin = db
        .get("plugins")
        .and_then(|v| v.as_array())?
        .iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))?
        .clone();
    Some(decorate_for_renderer(&plugin, &paths.data_dir))
}

// ---- הורדה לשמירה בדיסק (דיאלוג שמירה) ----

#[tauri::command]
async fn download_plugin(app: AppHandle, id: String) -> Result<Value, String> {
    let paths = app_paths();
    let db = load_db(&paths);
    let plugin = db
        .get("plugins")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str())))
        .cloned();
    let plugin = match plugin {
        Some(p) => p,
        None => return Ok(json!({ "ok": false, "error": "התוסף לא נמצא. יש לבצע סנכרון קודם." })),
    };
    let local_file = plugin.get("localFile").filter(|v| !v.is_null());
    let local_file = match local_file {
        Some(v) => v,
        None => return Ok(json!({ "ok": false, "error": "הקובץ אינו זמין באופן מקומי. יש לבצע סנכרון קודם." })),
    };

    let rel_path = local_file.get("path").and_then(|v| v.as_str()).unwrap_or_default();
    let source_path = paths.data_dir.join(rel_path);
    let ext = local_file.get("ext").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let default_name = local_file
        .get("fileName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{}{}", plugin.get("name").and_then(|v| v.as_str()).unwrap_or("plugin"), ext));

    // הערה: ה-API המדויק של tauri-plugin-dialog (סוג ה-callback / שם המתודה להמרת FilePath ל-PathBuf)
    // עשוי להשתנות מעט בין גרסאות - זה המקום הכי סביר לדרוש תיקון קטן בזמן קימפול אצלך.
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    let mut tx_opt = Some(tx);
    let mut builder = app.dialog().file().set_file_name(&default_name);
    if !ext.is_empty() {
        let ext_no_dot = ext.trim_start_matches('.').to_string();
        builder = builder.add_filter("קובץ תוסף", &[ext_no_dot.as_str()]);
    }
    builder.save_file(move |file_path| {
        if let Some(tx) = tx_opt.take() {
            let _ = tx.send(file_path);
        }
    });
    let file_path = rx.await.map_err(|e| e.to_string())?;

    let file_path = match file_path {
        Some(p) => p,
        None => return Ok(json!({ "ok": false, "canceled": true })),
    };
    let dest: PathBuf = file_path
        .into_path()
        .map_err(|e| format!("נתיב שמירה לא תקין: {}", e))?;

    fs::copy(&source_path, &dest).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "path": dest.to_string_lossy() }))
}

// ---- התקנה ישירה מקומית (otzaria://plugin/install-local?path=) ----
// מוריד את קובץ התוסף עכשיו אם הוא עדיין לא מקומי, ואז פותח את הפרוטוקול עם נתיב מוחלט -
// בלי גישה לרשת מצד אוצריא, ועובד גם למי שעדיין לא סינכרן את התוסף הספציפי הזה.

#[tauri::command]
async fn direct_install_plugin(app: AppHandle, id: String) -> Result<Value, String> {
    let paths = app_paths();
    ensure_data_dirs(&paths);
    let mut db = load_db(&paths);

    let idx = db
        .get("plugins")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().position(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str())));
    let idx = match idx {
        Some(i) => i,
        None => return Ok(json!({ "ok": false, "error": "התוסף לא נמצא. יש לבצע סנכרון קודם." })),
    };

    let has_local_file = db["plugins"][idx].get("localFile").map(|v| !v.is_null()).unwrap_or(false);
    if !has_local_file {
        let remote_url = db["plugins"][idx].get("remoteDownloadUrl").and_then(|v| v.as_str()).map(|s| s.to_string());
        let remote_url = match remote_url {
            Some(u) if !u.is_empty() => u,
            _ => return Ok(json!({ "ok": false, "error": "קובץ התוסף אינו זמין. יש לבצע סנכרון קודם." })),
        };
        let plugin_id = db["plugins"][idx].get("id").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
        let plugin_name = db["plugins"][idx].get("name").and_then(|v| v.as_str()).unwrap_or("plugin").to_string();
        let plugin_dir = paths.files_dir.join(&plugin_id);
        let _ = fs::create_dir_all(&plugin_dir);
        let client = reqwest::Client::new();
        match download_to_file(&client, &remote_url, &plugin_dir.join("plugin"), Some(".otzplugin")).await {
            Ok(result) => {
                let rel = result.path.strip_prefix(&paths.data_dir).unwrap_or(&result.path).to_path_buf();
                db["plugins"][idx]["localFile"] = json!({
                    "path": rel.to_string_lossy(),
                    "fileName": result.original_name.clone().unwrap_or_else(|| format!("{}{}", plugin_name, result.ext)),
                    "ext": result.ext,
                    "size": result.size
                });
                db["plugins"][idx]["manifestId"] = json!(read_manifest_id_from_plugin_file(&result.path));
                save_db(&paths, &db).map_err(|e| e.to_string())?;
            }
            Err(err) => return Ok(json!({ "ok": false, "error": format!("לא ניתן להוריד את קובץ התוסף: {}", err) })),
        }
    }

    // טוענים שוב מהדיסק כדי לקבל את ה-localFile העדכני (גם אם עודכן זה עתה)
    let db = load_db(&paths);
    let plugin = db
        .get("plugins")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str())));
    let plugin = match plugin {
        Some(p) => p,
        None => return Ok(json!({ "ok": false, "error": "התוסף לא נמצא." })),
    };
    let rel_path = plugin.get("localFile").and_then(|lf| lf.get("path")).and_then(|v| v.as_str());
    let rel_path = match rel_path {
        Some(p) => p,
        None => return Ok(json!({ "ok": false, "error": "קובץ התוסף המקומי חסר. יש לבצע סנכרון מחדש." })),
    };
    let abs_path = paths.data_dir.join(rel_path);
    if !abs_path.exists() {
        return Ok(json!({ "ok": false, "error": "קובץ התוסף המקומי חסר. יש לבצע סנכרון מחדש." }));
    }
    let ext_ok = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("otzplugin"))
        .unwrap_or(false);
    if !ext_ok {
        return Ok(json!({ "ok": false, "error": "קובץ התוסף אינו בסיומת otzplugin תקינה." }));
    }

    let encoded = urlencoding::encode(&abs_path.to_string_lossy()).into_owned();
    let url = format!("otzaria://plugin/install-local?path={}", encoded);
    app.shell().open(url, None).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_plugins,
            get_plugin,
            sync_now,
            get_installed_plugins,
            download_plugin,
            direct_install_plugin,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
