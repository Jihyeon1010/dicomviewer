use dicom::dictionary_std::tags;
use dicom::object::OpenFileOptions;
use dicom::pixeldata::PixelDecoder;
use rayon::prelude::*;
use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};
use walkdir::WalkDir;

#[derive(Clone, Serialize)]
struct SliceInfo {
    path: PathBuf,
    series_uid: String,
    instance_number: i32,
}

#[derive(Serialize)]
struct SeriesInfo {
    uid: String,
    description: String,
    slice_count: usize,
}

#[derive(Default)]
struct AppState {
    slices: Mutex<Vec<SliceInfo>>, // currently selected series' sorted slices
    all: Mutex<Vec<SliceInfo>>,
}

fn read_header(path: PathBuf) -> Option<(SliceInfo, String)> {
    let obj = OpenFileOptions::new()
        .read_until(tags::PIXEL_DATA)
        .open_file(&path)
        .ok()?;
    let uid = obj.element(tags::SERIES_INSTANCE_UID).ok()?.to_str().ok()?.trim().to_string();
    let desc = obj
        .element(tags::SERIES_DESCRIPTION)
        .ok()
        .and_then(|e| e.to_str().ok().map(|s| s.trim().to_string()))
        .unwrap_or_default();
    let inst = obj
        .element(tags::INSTANCE_NUMBER)
        .ok()
        .and_then(|e| e.to_int::<i32>().ok())
        .unwrap_or(0);
    Some((SliceInfo { path, series_uid: uid, instance_number: inst }, desc))
}

#[tauri::command]
fn open_folder(dir: String, state: tauri::State<AppState>) -> Vec<SeriesInfo> {
    let paths: Vec<PathBuf> = WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect();

    let parsed: Vec<(SliceInfo, String)> =
        paths.into_par_iter().filter_map(read_header).collect();

    let mut series: std::collections::BTreeMap<String, (String, usize)> = Default::default();
    for (s, d) in &parsed {
        let e = series.entry(s.series_uid.clone()).or_insert((d.clone(), 0));
        e.1 += 1;
    }
    *state.all.lock().unwrap() = parsed.into_iter().map(|(s, _)| s).collect();

    series
        .into_iter()
        .map(|(uid, (description, slice_count))| SeriesInfo { uid, description, slice_count })
        .collect()
}

#[tauri::command]
fn select_series(uid: String, state: tauri::State<AppState>) -> usize {
    let mut v: Vec<SliceInfo> = state
        .all
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.series_uid == uid)
        .cloned()
        .collect();
    v.sort_by_key(|s| s.instance_number);
    let n = v.len();
    *state.slices.lock().unwrap() = v;
    n
}

// response: [rows u32 LE][cols u32 LE][bits u32 LE][signed u32 LE][pixel raw bytes]
#[tauri::command]
fn get_slice(index: usize, state: tauri::State<AppState>) -> Result<tauri::ipc::Response, String> {
    let path = state
        .slices
        .lock()
        .unwrap()
        .get(index)
        .ok_or("index out of range")?
        .path
        .clone();
    let obj = dicom::object::open_file(path).map_err(|e| e.to_string())?;
    let px = obj.decode_pixel_data().map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(16 + px.data().len());
    out.extend_from_slice(&px.rows().to_le_bytes());
    out.extend_from_slice(&px.columns().to_le_bytes());
    out.extend_from_slice(&(px.bits_allocated() as u32).to_le_bytes());
    out.extend_from_slice(&(px.pixel_representation() as u32).to_le_bytes());
    out.extend_from_slice(px.data());
    Ok(tauri::ipc::Response::new(out))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![open_folder, select_series, get_slice])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}