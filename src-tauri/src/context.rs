use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Mutex;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_x::{has_files, has_image, has_text, read_files, read_image, read_text};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipboardPayload {
    Text {
        text: String,
    },
    Image {
        path: String,
        width: u32,
        height: u32,
    },
    Files {
        paths: Vec<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSnapshot {
    pub payload: ClipboardPayload,
    pub timestamp_ms: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextPulse {
    pub timestamp_ms: f64,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub app_name: String,
    pub window_title: String,
    pub selected_text: Option<String>,
    pub browser_url: Option<String>,
    pub clipboard: Option<ClipboardSnapshot>,
}

static LAST_EXTERNAL_HWND: AtomicIsize = AtomicIsize::new(0);

/// Dữ liệu khóa ngay tại khoảnh khắc bấm Alt+K (trước khi KGAA cướp focus)
#[derive(Clone, Debug)]
pub struct TargetWindowLock {
    pub timestamp_ms: f64,
    pub hwnd_raw: isize,
    pub pid: u32,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub selected_text: Option<String>,
    pub is_self_or_desktop: bool,
}

#[cfg(target_os = "windows")]
pub fn restore_last_external_focus() {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};

    let raw = LAST_EXTERNAL_HWND.load(Ordering::SeqCst);
    if raw != 0 {
        unsafe {
            let hwnd = HWND(raw as *mut c_void);
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn lock_foreground_target() -> Option<TargetWindowLock> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Accessibility::{IUIAutomationTextPattern, UIA_TextPatternId};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId,
    };

    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);

        let hwnd = GetForegroundWindow();
        let mut pid = 0u32;
        if !hwnd.is_invalid() {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }

        let is_self_or_desktop = hwnd.is_invalid() || pid == 0 || pid == std::process::id();

        if !is_self_or_desktop {
            LAST_EXTERNAL_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
        }

        // Chỉ đọc Selected Text nếu cửa sổ đang focus là app bên ngoài
        let selected_text = if !is_self_or_desktop {
            with_thread_uia(|uia| {
                let focused = uia.GetFocusedElement().ok()?;
                let tp = focused
                    .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    .ok()?;
                let sel = tp.GetSelection().ok()?;
                if sel.Length().unwrap_or(0) <= 0 {
                    return None;
                }
                let range = sel.GetElement(0).ok()?;
                let bstr = range.GetText(4096).ok()?;
                let txt = bstr.to_string();
                let trimmed = txt.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
        } else {
            None
        };

        Some(TargetWindowLock {
            timestamp_ms: now_ms(),
            hwnd_raw: hwnd.0 as isize,
            pid,
            cursor_x: pt.x,
            cursor_y: pt.y,
            selected_text,
            is_self_or_desktop,
        })
    }
}

struct ClipboardSeqCache {
    seq_num: u32,
    snapshot: ClipboardSnapshot,
}

static CLIPBOARD_CACHE: Mutex<Option<ClipboardSeqCache>> = Mutex::new(None);

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(target_os = "windows")]
fn get_clipboard_seq() -> u32 {
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

#[cfg(target_os = "windows")]
fn with_thread_uia<F, R>(f: F) -> Option<R>
where
    F: FnOnce(&windows::Win32::UI::Accessibility::IUIAutomation) -> Option<R>,
{
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
    };
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    thread_local! {
        static THREAD_UIA: Option<IUIAutomation> = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()
        };
    }

    THREAD_UIA.with(|uia_opt| uia_opt.as_ref().and_then(f))
}

async fn read_clipboard_fast(app: &AppHandle, now: f64) -> Option<ClipboardSnapshot> {
    let seq = get_clipboard_seq();

    // Chỉ dùng cache khi trước đó đã đọc thành công (Some)
    if seq != 0
        && let Ok(guard) = CLIPBOARD_CACHE.lock()
        && let Some(cached) = guard.as_ref()
        && cached.seq_num == seq
    {
        return Some(cached.snapshot.clone());
    }

    let mut result: Option<ClipboardSnapshot> = None;

    if has_files().await.unwrap_or(false) {
        if let Ok(file_data) = read_files().await
            && !file_data.paths.is_empty()
        {
            result = Some(ClipboardSnapshot {
                payload: ClipboardPayload::Files {
                    paths: file_data.paths,
                },
                timestamp_ms: now,
            });
        }
    } else if has_image().await.unwrap_or(false) {
        // Đảm bảo thư mục cache tồn tại để read_image xuất file PNG thành công
        let save_dir = app.path().app_cache_dir().ok().inspect(|dir| {
            let _ = std::fs::create_dir_all(dir);
        });

        if let Ok(img) = read_image(app.clone(), save_dir).await {
            result = Some(ClipboardSnapshot {
                payload: ClipboardPayload::Image {
                    path: img.path.to_string_lossy().into_owned(),
                    width: img.width,
                    height: img.height,
                },
                timestamp_ms: now,
            });
        }
    } else if has_text().await.unwrap_or(false)
        && let Ok(text) = read_text().await
    {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            result = Some(ClipboardSnapshot {
                payload: ClipboardPayload::Text {
                    text: trimmed.to_string(),
                },
                timestamp_ms: now,
            });
        }
    }

    // Chỉ lưu vào cache khi đọc thành công (Some), không cache None
    if seq != 0
        && let Some(ref snap) = result
        && let Ok(mut guard) = CLIPBOARD_CACHE.lock()
    {
        *guard = Some(ClipboardSeqCache {
            seq_num: seq,
            snapshot: snap.clone(),
        });
    }

    result
}

#[cfg(target_os = "windows")]
fn extract_window_metadata_and_url(target: &TargetWindowLock) -> (String, String, Option<String>) {
    if target.is_self_or_desktop {
        return ("Desktop / Screenshot".to_string(), String::new(), None);
    }

    use std::ffi::c_void;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationValuePattern, TreeScope_Descendants, UIA_ControlTypePropertyId,
        UIA_EditControlTypeId, UIA_ValuePatternId,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    use windows::core::PWSTR;

    let hwnd = HWND(target.hwnd_raw as *mut c_void);
    let mut app_name = String::new();
    let mut window_title = String::new();

    unsafe {
        let mut title_buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut title_buf);
        if len > 0 {
            window_title = String::from_utf16_lossy(&title_buf[..len as usize]);
        }

        if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, target.pid) {
            let mut path_buf = [0u16; 512];
            let mut size = path_buf.len() as u32;
            if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(path_buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok()
            {
                let full = String::from_utf16_lossy(&path_buf[..size as usize]);
                if let Some(name) = full.rsplit('\\').next() {
                    app_name = name.to_string();
                }
            }
            let _ = CloseHandle(handle);
        }
    }

    let app_lower = app_name.to_lowercase();
    let is_browser = matches!(
        app_lower.as_str(),
        "chrome.exe"
            | "msedge.exe"
            | "brave.exe"
            | "firefox.exe"
            | "arc.exe"
            | "opera.exe"
            | "vivaldi.exe"
            | "zen.exe"
    );

    let browser_url = if is_browser {
        with_thread_uia(|uia| unsafe {
            let root = uia.ElementFromHandle(hwnd).ok()?;
            let edit_var = VARIANT::from(UIA_EditControlTypeId.0);
            let cond = uia
                .CreatePropertyCondition(UIA_ControlTypePropertyId, &edit_var)
                .ok()?;
            let addr_bar = root.FindFirst(TreeScope_Descendants, &cond).ok()?;
            let vp = addr_bar
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok()?;
            let val = vp.CurrentValue().ok()?;
            let s = val.to_string();
            let trimmed = s.trim();
            if !trimmed.is_empty()
                && !trimmed.contains(' ')
                && (trimmed.contains("://")
                    || trimmed.contains('.')
                    || trimmed.starts_with("localhost"))
            {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
    } else {
        None
    };

    (app_name, window_title, browser_url)
}

/// PHA 2 (Chạy nền): Hoàn tất App Name + URL + Clipboard
pub fn resolve_pulse_background(app: AppHandle, target: TargetWindowLock) -> ContextPulse {
    #[cfg(target_os = "windows")]
    let (app_name, window_title, browser_url) = extract_window_metadata_and_url(&target);

    #[cfg(not(target_os = "windows"))]
    let (app_name, window_title, browser_url) = (String::new(), String::new(), None);

    let clipboard = tauri::async_runtime::block_on(read_clipboard_fast(&app, target.timestamp_ms));

    ContextPulse {
        timestamp_ms: target.timestamp_ms,
        cursor_x: target.cursor_x,
        cursor_y: target.cursor_y,
        app_name,
        window_title,
        selected_text: target.selected_text,
        browser_url,
        clipboard,
    }
}
