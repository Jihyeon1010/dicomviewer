use dicom::core::Tag;
use dicom::dictionary_std::tags;
use dicom::object::{DefaultDicomObject, OpenFileOptions};
use dicom::pixeldata::PixelDecoder;
use rayon::prelude::*;
use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};
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
    slices: Mutex<Vec<SliceInfo>>, // 현재 선택된 시리즈의 정렬된 슬라이스
    all: Mutex<Vec<SliceInfo>>,
}

fn read_header(path: PathBuf) -> Option<(SliceInfo, String)> {
    let obj = OpenFileOptions::new()
        .read_until(tags::PIXEL_DATA)
        .open_file(&path)
        .ok()?;
    let uid = obj
        .element(tags::SERIES_INSTANCE_UID)
        .ok()?
        .to_str()
        .ok()?
        .trim()
        .to_string();
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
    Some((
        SliceInfo {
            path,
            series_uid: uid,
            instance_number: inst,
        },
        desc,
    ))
}

fn f64_of(obj: &DefaultDicomObject, tag: Tag, default: f64) -> f64 {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_float64().ok())
        .unwrap_or(default)
}

// WindowCenter/Width는 다중 값일 수 있어 첫 값만 사용
fn first_f64(obj: &DefaultDicomObject, tag: Tag) -> Option<f64> {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_multi_float64().ok())
        .and_then(|v| v.first().copied())
}

fn load_paths(paths: Vec<PathBuf>, state: &AppState) -> Vec<SeriesInfo> {
    let parsed: Vec<(SliceInfo, String)> =
        paths.into_par_iter().filter_map(read_header).collect();

    let mut series: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for (s, d) in &parsed {
        let e = series
            .entry(s.series_uid.clone())
            .or_insert((d.clone(), 0));
        e.1 += 1;
    }
    *state.all.lock().unwrap() = parsed.into_iter().map(|(s, _)| s).collect();

    series
        .into_iter()
        .map(|(uid, (description, slice_count))| SeriesInfo {
            uid,
            description,
            slice_count,
        })
        .collect()
}

// 파일과 폴더가 섞여 있어도 전부 풀어서 파일 경로로 만듭니다
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
    v.sort_by_key(|s| s.instance_number);
    let n = v.len();
    *state.slices.lock().unwrap() = v;
    n
}

// 헤더 40바이트:
// [rows u32][cols u32][bits u32][signed u32]
// [slope f32][intercept f32][wc f32][ww f32][mono1 u32][pad u32]
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