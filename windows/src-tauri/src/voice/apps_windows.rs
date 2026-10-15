// Activate the Windows Shell's registered app item, rather than asking Explorer
// to interpret a shortcut path. AppsFolder includes desktop and packaged apps.
// All COM interfaces/pointers stay on the calling voice thread.
use std::time::{Duration, Instant};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
use windows::Win32::System::SystemInformation::GetWindowsDirectoryW;
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, KF_FLAG_DEFAULT,
    SHGetIDListFromObject, SHGetKnownFolderItem, ShellExecuteExW, SHELLEXECUTEINFOW,
    SEE_MASK_FLAG_NO_UI, SEE_MASK_INVOKEIDLIST, SEE_MASK_NOASYNC,
    SIGDN, SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_NORMALDISPLAY,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use super::commands::{matches, system_target, AppName};

struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) { if self.0 { unsafe { CoUninitialize() } } }
}
struct ShellString(PWSTR);
impl Drop for ShellString {
    fn drop(&mut self) { unsafe { CoTaskMemFree(Some(self.0.0.cast())) } }
}

fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    let text = ShellString(unsafe { item.GetDisplayName(kind).ok()? });
    if text.0.is_null() { return None; }
    unsafe { text.0.to_string().ok() }
}

struct App {
    name: AppName,
    item: IShellItem,
}

fn catalog() -> windows::core::Result<Vec<App>> {
    let folder: IShellItem = unsafe { SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)? };
    let items: IEnumShellItems = unsafe { folder.BindToHandler(None, &BHID_EnumItems)? };
    let mut apps = Vec::new();
    let started = Instant::now();
    for _ in 0..8192 {
        if started.elapsed() > Duration::from_secs(3) { return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x800705B4u32 as i32))); }
        let mut fetched = 0;
        let mut next = [None];
        unsafe { items.Next(&mut next, Some(&mut fetched))?; }
        if fetched == 0 { return Ok(apps); }
        let Some(item) = next[0].take() else { continue };
        let (Some(label), Some(identity)) = (display_name(&item, SIGDN_NORMALDISPLAY), display_name(&item, SIGDN_DESKTOPABSOLUTEPARSING)) else { continue };
        if !label.trim().is_empty() && !identity.is_empty() {
            apps.push(App { name: AppName { label, identity }, item });
        }
    }
    // Never launch from an incomplete catalog: it may hide an ambiguous match.
    Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x800700EAu32 as i32)))
}

fn activate_item(item: &IShellItem) -> windows::core::Result<()> {
    let pidl = unsafe { SHGetIDListFromObject(item)? };
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpIDList: pidl.cast(),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    let result = unsafe { ShellExecuteExW(&mut info) };
    unsafe { CoTaskMemFree(Some(pidl.cast())); }
    result
}

/// Fixed Windows targets cover common system apps even without a Start menu
/// entry or with a localized display name. A missing optional app falls back to
/// the registered catalog rather than installing/downloading anything.
fn activate_system(wanted: &str, may_launch: &impl Fn() -> bool) -> Option<String> {
    let target = system_target(wanted)?;
    let target = if target == "ms-settings:" {
        target.to_string()
    } else {
        let mut dir = [0u16; 260];
        let length = unsafe { GetWindowsDirectoryW(Some(&mut dir)) } as usize;
        if length == 0 || length >= dir.len() { return None; }
        let path = std::path::PathBuf::from(String::from_utf16_lossy(&dir[..length])).join(target);
        if !path.is_file() { return None; }
        path.to_string_lossy().into_owned()
    };
    if !may_launch() { return Some("App command cancelled.".into()); }
    let wide: Vec<_> = target.encode_utf16().chain(Some(0)).collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpFile: PCWSTR(wide.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    Some(match unsafe { ShellExecuteExW(&mut info) } {
        Ok(()) => format!("Launch requested: {wanted}."),
        Err(_) => format!("Could not launch {wanted}. Open it manually."),
    })
}

pub(super) fn launch(wanted: &str, may_launch: impl Fn() -> bool) -> String {
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
        return "Windows app discovery is unavailable. Try again.".into();
    }
    let _apartment = Apartment(initialized.is_ok());
    if !may_launch() { return "App command cancelled.".into(); }
    if let Some(result) = activate_system(wanted, &may_launch) { return result; }
    let apps = match catalog() {
        Ok(apps) => apps,
        Err(_) => return "Windows app discovery is not ready. No app was opened; try again.".into(),
    };
    let names: Vec<_> = apps.iter().map(|app| app.name.clone()).collect();
    let found = matches(wanted, &names);
    match found.as_slice() {
        [] => "No matching installed Windows app found. Try its full name.".into(),
        [index] => {
            if !may_launch() { return "App command cancelled.".into(); }
            let app = &apps[*index];
            match activate_item(&app.item) {
                Ok(()) => format!("Launch requested: {}.", app.name.label),
                Err(_) => format!("Could not launch {}. Open it manually.", app.name.label),
            }
        }
        _ => format!("Different apps match: {}. No app was opened; use a more specific name.",
            found.iter().take(4).map(|i| names[*i].label.as_str()).collect::<Vec<_>>().join(", ")),
    }
}
