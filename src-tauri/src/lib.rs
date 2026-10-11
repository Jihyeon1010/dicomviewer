use dicom::core::Tag;
use dicom::dictionary_std::tags;
use dicom::object::{DefaultDicomObject, OpenFileOptions};
use dicom::pixeldata::PixelDecoder;
use rayon::prelude::*;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use walkdir::WalkDir;

#[derive(Clone, Serialize)]
struct SliceInfo {
    path: PathBuf,
    series_uid: String,
    instance_number: i32,
    frame: u32, // zero-based frame index inside the file
}

#[derive(Serialize)]
struct SeriesInfo {
    uid: String,
    description: String,
    slice_count: usize,
}

#[derive(Default)]
struct AppState {
    slices: Mutex<Vec<SliceInfo>>, // sorted frames of the selected series
    all: Mutex<Vec<SliceInfo>>,
    // Last opened file. Scrolling through the frames of one multiframe file
    // would otherwise re-read and re-parse the whole file for every frame.
    cache: Mutex<Option<(PathBuf, Arc<DefaultDicomObject>)>>,
}

// Returns one entry per frame; an empty Vec means "not a displayable image".
fn read_header(path: PathBuf) -> Vec<(SliceInfo, String)> {
    let Ok(obj) = OpenFileOptions::new()
        .read_until(tags::PIXEL_DATA)
        .open_file(&path)
    else {
        return Vec::new();
    };

    // Skip objects without image attributes (SR, DICOMDIR, ...)
    if obj.element(tags::ROWS).is_err() {
        return Vec::new();
    }
    let Some(uid) = obj
        .element(tags::SERIES_INSTANCE_UID)
        .ok()
        .and_then(|e| e.to_str().ok().map(|s| s.trim().to_string()))
    else {
        return Vec::new();
    };

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
    let frames = obj
        .element(tags::NUMBER_OF_FRAMES)
        .ok()
        .and_then(|e| e.to_int::<u32>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(1);

    (0..frames)
        .map(|frame| {
            (
                SliceInfo {
                    path: path.clone(),
                    series_uid: uid.clone(),
                    instance_number: inst,
                    frame,
                },
                desc.clone(),
            )
        })
        .collect()
}

fn f64_of(obj: &DefaultDicomObject, tag: Tag, default: f64) -> f64 {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_float64().ok())
        .unwrap_or(default)
}

// WindowCenter/Width may be multi-valued; use the first value only
fn first_f64(obj: &DefaultDicomObject, tag: Tag) -> Option<f64> {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_multi_float64().ok())
        .and_then(|v| v.first().copied())
}

fn open_cached(state: &AppState, path: &PathBuf) -> Result<Arc<DefaultDicomObject>, String> {
    {
        let cache = state.cache.lock().unwrap();
        if let Some((p, obj)) = cache.as_ref() {
            if p == path {
                return Ok(Arc::clone(obj));
            }
        }
    }
    let obj = Arc::new(dicom::object::open_file(path).map_err(|e| e.to_string())?);
    *state.cache.lock().unwrap() = Some((path.clone(), Arc::clone(&obj)));
    Ok(obj)
}

fn load_paths(paths: Vec<PathBuf>, state: &AppState) -> Vec<SeriesInfo> {
    let parsed: Vec<(SliceInfo, String)> =
        paths.into_par_iter().flat_map_iter(read_header).collect();

    let mut series: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for (s, d) in &parsed {
        let e = series
            .entry(s.series_uid.clone())
            .or_insert((d.clone(), 0));
        e.1 += 1;
    }
    *state.all.lock().unwrap() = parsed.into_iter().map(|(s, _)| s).collect();
    *state.cache.lock().unwrap() = None;

    series
        .into_iter()
        .map(|(uid, (description, slice_count))| SeriesInfo {
            uid,
            description,
            slice_count,
        })
        .collect()
}

// Expands files and folders (possibly mixed) into a flat list of file paths
fn collect_paths(inputs: Vec<String>) -> Vec<PathBuf> {
    inputs
        .into_iter()
        .flat_map(|p| WalkDir::new(p).into_iter().filter_map(|e| e.ok()))
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect()
}

#[tauri::command]
fn open_folder(dir: String, state: tauri::State<AppState>) -> Vec<SeriesInfo> {
    load_paths(collect_paths(vec![dir]), &state)
}

#[tauri::command]
fn open_files(files: Vec<String>, state: tauri::State<AppState>) -> Vec<SeriesInfo> {
    load_paths(collect_paths(files), &state)
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
    // Instance number first, then file, then frame (keeps multiframe order stable)
    v.sort_by(|a, b| {
        (a.instance_number, &a.path, a.frame).cmp(&(b.instance_number, &b.path, b.frame))
    });
    let n = v.len();
    *state.slices.lock().unwrap() = v;
    n
}

// 40-byte header (little-endian):
// [rows u32][cols u32][bits u32][signed u32]
// [slope f32][intercept f32][wc f32][ww f32][mono1 u32][pad u32]
#[tauri::command]
fn get_slice(index: usize, state: tauri::State<AppState>) -> Result<tauri::ipc::Response, String> {
    let (path, frame) = {
        let slices = state.slices.lock().unwrap();
        let s = slices.get(index).ok_or("index out of range")?;
        (s.path.clone(), s.frame)
    };

    let obj = open_cached(&state, &path)?;
    let px = obj
        .decode_pixel_data_frame(frame)
        .map_err(|e| e.to_string())?;

    if px.samples_per_pixel() != 1 {
        return Err("Color (multi-sample) images are not supported yet".into());
    }

    // Note: only top-level rescale and window attributes are read. Enhanced
    // multiframe objects keep them in functional group sequences instead.
    let slope = f64_of(&obj, tags::RESCALE_SLOPE, 1.0) as f32;
    let intercept = f64_of(&obj, tags::RESCALE_INTERCEPT, 0.0) as f32;
    let wc = first_f64(&obj, tags::WINDOW_CENTER).unwrap_or(f64::NAN) as f32;
    let ww = first_f64(&obj, tags::WINDOW_WIDTH).unwrap_or(f64::NAN) as f32;
    let mono1 = obj
        .element(tags::PHOTOMETRIC_INTERPRETATION)
        .ok()
        .and_then(|e| e.to_str().ok().map(|s| s.trim() == "MONOCHROME1"))
        .unwrap_or(false);

    let data = px.data();
    let mut out = Vec::with_capacity(40 + data.len());
    out.extend_from_slice(&px.rows().to_le_bytes());
    out.extend_from_slice(&px.columns().to_le_bytes());
    out.extend_from_slice(&(px.bits_allocated() as u32).to_le_bytes());
    out.extend_from_slice(&(px.pixel_representation() as u32).to_le_bytes());
    out.extend_from_slice(&slope.to_le_bytes());
    out.extend_from_slice(&intercept.to_le_bytes());
    out.extend_from_slice(&wc.to_le_bytes());
    out.extend_from_slice(&ww.to_le_bytes());
    out.extend_from_slice(&(mono1 as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(data);
    Ok(tauri::ipc::Response::new(out))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_folder,
            open_files,
            select_series,
            get_slice
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}