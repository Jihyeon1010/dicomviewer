use dicom::core::Tag;
use dicom::dictionary_std::tags;
use dicom::object::{DefaultDicomObject, OpenFileOptions};
use dicom::pixeldata::PixelDecoder;
use rayon::{prelude::*, string};
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

// Display metadata for one slice. Missing attributes are empty strings or null.
#[derive(Serialize)]
struct SliceMeta {
    patient_name: String,
    patient_id: String,
    patient_sex: String,
    patient_age: String,
    patient_birth_date: String,
    institution: String,
    study_description: String,
    study_date: String,
    study_time: String,
    series_description: String,
    series_number: String,
    modality: String,
    manufacturer_model: String,
    slice_location: Option<f64>,
    slice_thickness: Option<f64>,
    kvp: Option<f64>,
    tube_current: Option<f64>,
    pixel_spacing: Option<[f64; 2]>, // [row spacing, column spacing] in mm, as in DICOM
    image_orientation: Option<[f64; 6]>,
    patient_orientation: String, // row and column direction cosines, as in DICOM
    frame: u32,
    frame_count: u32,
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

fn opt_f64(obj: &DefaultDicomObject, tag: Tag) -> Option<f64> {
    obj.element(tag).ok().and_then(|e| e.to_float64().ok())
}

fn f64_of(obj: &DefaultDicomObject, tag: Tag, default: f64) -> f64 {
    opt_f64(obj, tag).unwrap_or(default)
}

fn multi_f64(obj: &DefaultDicomObject, tag: Tag) -> Option<Vec<f64>> {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_multi_float64().ok())
}

// WindowCenter/Width may be multi-valued; use the first value only
fn first_f64(obj: &DefaultDicomObject, tag: Tag) -> Option<f64> {
    multi_f64(obj, tag).and_then(|v| v.first().copied())
}

// Text value with DICOM padding (spaces, NUL) removed
fn text_of(obj: &DefaultDicomObject, tag: Tag) -> String {
    obj.element(tag)
        .ok()
        .and_then(|e| {
            e.to_str()
                .ok()
                .map(|s| s.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        })
        .unwrap_or_default()
}

fn open_cached(state: &AppState, path: &PathBuf) -> Result<Arc<DefaultDicomObject>, String> {
    // The lock is held while loading so that concurrent commands for the same
    // file (pixel data and metadata) trigger only one read.
    let mut cache = state.cache.lock().unwrap();
    if let Some((p, obj)) = cache.as_ref() {
        if p == path {
            return Ok(Arc::clone(obj));
        }
    }
    let obj = Arc::new(dicom::object::open_file(path).map_err(|e| e.to_string())?);
    *cache = Some((path.clone(), Arc::clone(&obj)));
    Ok(obj)
}

fn slice_ref(state: &AppState, index: usize) -> Result<(PathBuf, u32), String> {
    let slices = state.slices.lock().unwrap();
    let s = slices.get(index).ok_or("index out of range")?;
    Ok((s.path.clone(), s.frame))
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

// `async` makes Tauri run these on a worker thread instead of the main thread,
// so decoding never blocks the window.
#[tauri::command(async)]
fn open_folder(dir: String, state: tauri::State<AppState>) -> Vec<SeriesInfo> {
    load_paths(collect_paths(vec![dir]), &state)
}

#[tauri::command(async)]
fn open_files(files: Vec<String>, state: tauri::State<AppState>) -> Vec<SeriesInfo> {
    load_paths(collect_paths(files), &state)
}

#[tauri::command(async)]
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
#[tauri::command(async)]
fn get_slice(index: usize, state: tauri::State<AppState>) -> Result<tauri::ipc::Response, String> {
    let (path, frame) = slice_ref(&state, index)?;
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

#[tauri::command(async)]
fn get_slice_meta(index: usize, state: tauri::State<AppState>) -> Result<SliceMeta, String> {
    let (path, frame) = slice_ref(&state, index)?;
    let obj = open_cached(&state, &path)?;

    let spacing = multi_f64(&obj, tags::PIXEL_SPACING)
        .or_else(|| multi_f64(&obj, tags::IMAGER_PIXEL_SPACING)) // projection radiography
        .and_then(|v| if v.len() >= 2 { Some([v[0], v[1]]) } else { None });

    // Fall back to the z component of ImagePositionPatient when SliceLocation is absent
    let slice_location = opt_f64(&obj, tags::SLICE_LOCATION).or_else(|| {
        multi_f64(&obj, tags::IMAGE_POSITION_PATIENT).and_then(|v| v.get(2).copied())
    });

    let orientation = multi_f64(&obj, tags::IMAGE_ORIENTATION_PATIENT).and_then(|v| {
        if v.len() >= 6 {
            Some([v[0], v[1], v[2], v[3], v[4], v[5]])
        } else {
            None
        }
    });

    let frame_count = obj
        .element(tags::NUMBER_OF_FRAMES)
        .ok()
        .and_then(|e| e.to_int::<u32>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(1);

    Ok(SliceMeta {
        patient_name: text_of(&obj, tags::PATIENT_NAME),
        patient_id: text_of(&obj, tags::PATIENT_ID),
        patient_sex: text_of(&obj, tags::PATIENT_SEX),
        patient_age: text_of(&obj, tags::PATIENT_AGE),
        patient_birth_date: text_of(&obj, tags::PATIENT_BIRTH_DATE),
        institution: text_of(&obj, tags::INSTITUTION_NAME),
        study_description: text_of(&obj, tags::STUDY_DESCRIPTION),
        study_date: text_of(&obj, tags::STUDY_DATE),
        study_time: text_of(&obj, tags::STUDY_TIME),
        series_description: text_of(&obj, tags::SERIES_DESCRIPTION),
        series_number: text_of(&obj, tags::SERIES_NUMBER),
        modality: text_of(&obj, tags::MODALITY),
        manufacturer_model: text_of(&obj, tags::MANUFACTURER_MODEL_NAME),
        slice_location,
        slice_thickness: opt_f64(&obj, tags::SLICE_THICKNESS),
        kvp: opt_f64(&obj, tags::KVP),
        tube_current: opt_f64(&obj, tags::X_RAY_TUBE_CURRENT),
        pixel_spacing: spacing,
        image_orientation: orientation,
        patient_orientation: text_of(&obj, tags::PATIENT_ORIENTATION),
        frame,
        frame_count,
    })
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
            get_slice,
            get_slice_meta
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}