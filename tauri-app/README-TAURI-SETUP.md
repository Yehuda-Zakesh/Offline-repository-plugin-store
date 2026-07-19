# חנות תוספים לאוצריא - גרסת Tauri (Rust) קלת-משקל

זו גרסה מחדש של האפליקציה (שהייתה ב-Electron) בטכנולוגיית **Tauri** - אותה תוכנה
בדיוק, אותו UI (`src/index.html`, `src/app.js`, `src/styles.css` **לא שונו כלל**),
אבל במקום לארוז Chromium+Node שלמים בפנים (מה שתפס כ-60MB), האפליקציה משתמשת
ב-WebView2 שכבר מותקן בוינדוז. התוצאה הצפויה: קובץ exe בגודל **5-15MB** בערך.

**חדשות טובות:** תיקיית `plugins-store-data` (db.json + קבצי התוספים שכבר הורדת)
נשארת באותו מבנה בדיוק - אפשר להעתיק אותה ליד ה-exe החדש והכול ימשיך לעבוד בלי
סנכרון מחדש.

## מה נכתב מחדש

רק שכבת ה-"main process" (מה שהיה ב-`main.js`/`preload.js`) נכתבה מחדש ב-Rust,
בקובץ אחד: `src-tauri/src/main.rs`. הוא מממש בדיוק את אותה לוגיקה: סנכרון מהאתר,
הורדת קבצים, קריאת manifest.json מתוך קובץ ה-.otzplugin, זיהוי תוספים מותקנים
דרך `%APPDATA%\otzaria\...`, התקנה ישירה מקומית (`install-local`), ודיאלוג שמירה
להורדה.

בצד ה-JS נוסף קובץ קטן אחד, `src/tauri-bridge.js`, שבונה בדיוק את אותו `window.api`
שהיה ב-preload.js הישן - כך ש-`app.js` לא צריך שום שינוי.

## ⚠️ הערה חשובה על הבדיקה שביצעתי

עבדתי במכונת Linux בלי אפשרות להתקין Rust עדכני מספיק כדי לקמפל את הפרויקט עד הסוף
כאן (ה-toolchain הזמין מקומית ישן מדי לתלויות של Tauri 2). כלומר: כתבתי את הקוד
בזהירות לפי הידע שלי על ה-API של Tauri v2, אבל **לא הרצתי עליו קימפול מלא**.
סביר להניח שהוא יעבוד, אבל יכולות להיות טעויות קטנות בממשקי API (בעיקר סביב
`tauri-plugin-dialog` ו-`tauri::Window` מול `tauri::WebviewWindow`) שתצטרך לתקן
לפי הודעות השגיאה שה-compiler ייתן אצלך. אלה בדרך כלל תיקונים של שורה אחת (שינוי
שם טיפוס/מתודה), לא בעיה בלוגיקה עצמה.

## התקנות מקדימות (פעם אחת בלבד, בוינדוז)

1. **Rust**: התקן דרך https://rustup.rs (הרצת קובץ ה-exe שמורידים משם)
2. **Visual Studio Build Tools** (נדרש ל-Rust בוינדוז): אם `rustup` לא מתקין
   אוטומטית, הורד מ-https://visualstudio.microsoft.com/visual-cpp-build-tools
   ובחר "Desktop development with C++"
3. **WebView2**: כבר מותקן כברירת מחדל בוינדוז 10/11 העדכניים; אם לא -
   https://developer.microsoft.com/microsoft-edge/webview2
4. **Tauri CLI**:
   ```
   cargo install tauri-cli --version "^2"
   ```

## בנייה

```
cd otzaria-plugins-tauri

# שלב חד-פעמי: יוצר אוטומטית את כל קבצי האייקונים (icon.ico וכו') מתוך הלוגו הקיים
cargo tauri icon assets/logo.svg

# הרצה מקומית לבדיקה (עם hot-reload):
cargo tauri dev

# בנייה סופית:
cargo tauri build
```

**התוצר הוא קובץ יחיד**: `src-tauri/target/release/otzaria-plugins-store.exe`.
אין installer בכלל (הפקתו כובתה בכוונה ב-`tauri.conf.json` דרך `"bundle": {"active": false}`) -
זו תוכנה ניידת (portable) לגמרי: אפשר להעביר את קובץ ה-exe הזה לכל מקום (כולל
דיסק-און-קי), ובכל הרצה הוא יוצר/מחפש את תיקיית `plugins-store-data` (עם ה-DB וקבצי
התוספים שהורדו) **תמיד ליד עצמו** - לא בתיקיית משתמש כלשהי במערכת, ולא באיזשהו נתיב
זמני. זה עובד כך גם ב-Electron הישן וגם כאן, כי `main.rs` מחשב את הנתיב לפי מיקום
ה-exe הרץ (`std::env::current_exe()`), לא לפי OS-specific user-data folder.

## אם יש שגיאות קימפול

השגיאות הכי סבירות ואיך לתקן:

- **`tauri::Window` לא קיים** → נסה להחליף ל-`tauri::WebviewWindow` בהגדרת
  `sync_now` ב-`main.rs`.
- **משהו סביב `save_file` / `FilePath` / `into_path()`** ב-`download_plugin` →
  זה חלק ה-API שהכי סביר להשתנות בין גרסאות `tauri-plugin-dialog`; תסתכל על
  ההודעה של ה-compiler, בדרך כלל זה רק שינוי שם מתודה.
- כל שגיאה אחרת - תרגיש חופשי להעתיק את הודעת השגיאה חזרה אליי ואני אתקן.

## מבנה הפרויקט

```
otzaria-plugins-tauri/
├── assets/logo.svg              (זהה למקור)
├── src/                         (frontend - זהה למקור פרט לתוספת אחת)
│   ├── index.html               (זהה, רק נוסף script tag ל-tauri-bridge.js + עודכן CSP)
│   ├── app.js                   (זהה ב-100% למקור)
│   ├── styles.css               (זהה ב-100% למקור)
│   └── tauri-bridge.js          (חדש - מחליף את preload.js הישן)
└── src-tauri/
    ├── Cargo.toml                (תלויות Rust)
    ├── build.rs
    ├── tauri.conf.json           (הגדרות אפליקציה/חלון/bundle)
    ├── capabilities/default.json (הרשאות)
    └── src/main.rs                (כל לוגיקת ה-main.js הישן, ב-Rust)
```
