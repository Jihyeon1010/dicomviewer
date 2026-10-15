use dicom::core::Tag;
use dicom::core::dictionary::{DataDictionary, DataDictionaryEntry};
use dicom::core::VR;
use dicom::dictionary_std::{tags, StandardDataDictionary};
use dicom::object::{DefaultDicomObject, InMemDicomObject, OpenFileOptions};
use dicom::pixeldata::{DecodedPixelData, PixelDecoder};
use rayon::prelude::*;
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use walkdir::WalkDir;

mod mpr;

type Vec3 = [f64; 3];

// Hard limit on the in-memory volume (f32 per voxel)
const MAX_VOLUME_BYTES: usize = 4 * 1024 * 1024 * 1024;

// Opened files kept in memory. Several viewports read different files at once,
// and pixel data and metadata of one slice are requested separately.
// Opened files kept in memory. Several viewports read different files at once,
// and pixel data and metadata of one slice are requested separately.
// Bounded by count and by total file size on disk (multiframe files can be huge).
const FILE_CACHE_MAX_FILES: usize = 16;
const FILE_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Serialize)]
struct SliceInfo {
    path: PathBuf,
    series_uid: String,
    instance_number: i32,
    frame: u32,                // zero-based frame index inside the file
    ipp: Option<[f64; 3]>,     // ImagePositionPatient
    iop: Option<[f64; 6]>,     // ImageOrientationPatient
    frame_of_reference: String,
}

#[derive(Serialize)]
struct SeriesInfo {
    uid: String,
    description: String,
    slice_count: usize,
}

// Where the images of a series sit in patient space; used to link viewports
#[derive(Serialize)]
struct SeriesGeometry {
    frame_of_reference: String,
    normal: Option<Vec3>,
    // Millimetres along `normal`, one per image in display order (ascending).
    // None when positions are missing or all images share one position.
    positions: Option<Vec<f64>>,
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
    spacing_is_imager: bool, // true when the spacing comes from ImagerPixelSpacing (approximate)
    cine_fps: Option<f64>,   // playback rate from CineRate, FrameTime or the recommended rate
    image_orientation: Option<[f64; 6]>, // row cosines, then column cosines (patient LPS)
    patient_orientation: String, // raw "row\column" codes, used by projection images
    frame: u32,
    frame_count: u32,
}

#[derive(Clone, Serialize)]
struct VolumeInfo {
    cols: u32,
    rows: u32,
    depth: u32,
    pixel_spacing: Option<[f64; 2]>, // [row, column] in mm
    slice_spacing: Option<f64>,      // mean distance between slices in mm
    uniform: bool,                   // false when slice spacing varies by more than 1%
    tilt_deg: f64,                   // angle between the stack axis and the slice normal
    value_min: f64,
    value_max: f64,
    megabytes: f64,
    z_positions: Vec<f64>,           // mm along the stack direction, one per image, ascending
    orientation: Option<[f64; 6]>,   // row and column direction cosines of the images
    z_dir: Option<Vec3>,             // direction in which the image index increases
}

struct Volume {
    uid: String,
    info: VolumeInfo,
    // One buffer per slice in display order, each rows * cols rescaled values.
    // Separate buffers let the parallel decode move results in without copying.
    slices: Vec<Vec<f32>>,
    z: Vec<f64>,                // image positions in mm, same as info.z_positions
    window: Option<(f32, f32)>, // default window centre and width of the first image
    mono1: bool,                // MONOCHROME1 series
}

#[derive(Default)]
struct AppState {
    all: Mutex<Vec<SliceInfo>>,
    // Sorted images per series. Lock order when both are needed: `sorted`, then `all`.
    sorted: Mutex<HashMap<String, Arc<Vec<SliceInfo>>>>,
    // Recently opened files with their size on disk, most recently used first
    files: Mutex<Vec<(PathBuf, Arc<DefaultDicomObject>, u64)>>,
    volume: Mutex<Option<Arc<Volume>>>,
    // Bumped whenever a volume build starts or the loaded files change, so a
    // build that finished too late can recognise that it is stale.
    volume_gen: AtomicU64,
}

// ---------- Small DICOM helpers ----------

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

// First N values of a multi-valued numeric attribute
fn array_of<const N: usize>(obj: &DefaultDicomObject, tag: Tag) -> Option<[f64; N]> {
    let v = multi_f64(obj, tag)?;
    v.get(..N)?.try_into().ok()
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

// Raw sample at index `i`. Decoded pixel data is little-endian and tightly packed;
// the caller checks the buffer length first.
fn sample_at(data: &[u8], bits: u32, signed: bool, i: usize) -> f64 {
    match (bits, signed) {
        (8, false) => data[i] as f64,
        (8, true) => data[i] as i8 as f64,
        (16, false) => u16::from_le_bytes([data[2 * i], data[2 * i + 1]]) as f64,
        (16, true) => i16::from_le_bytes([data[2 * i], data[2 * i + 1]]) as f64,
        _ => 0.0,
    }
}

// ---------- Color images ----------

// Colour images (RGB, YBR) have three samples per pixel. PALETTE COLOR has one sample
// per pixel that indexes a colour table. Both are shown through the RGB path.
fn is_color(obj: &DefaultDicomObject, px: &DecodedPixelData<'_>) -> bool {
    px.samples_per_pixel() == 3
        || text_of(obj, tags::PHOTOMETRIC_INTERPRETATION) == "PALETTE COLOR"
}

// Raw bytes of an element (palette tables are stored as 16-bit little-endian words)
fn bytes_of(obj: &DefaultDicomObject, tag: Tag) -> Option<Vec<u8>> {
    obj.element(tag)
        .ok()
        .and_then(|e| e.to_bytes().ok().map(|b| b.into_owned()))
}

// PALETTE COLOR: the decoded samples are indices into three lookup tables.
// Returns interleaved 8-bit RGB.
fn palette_to_rgb(
    obj: &DefaultDicomObject,
    px: &DecodedPixelData<'_>,
) -> Result<(usize, usize, Vec<u8>), String> {
    let rows = px.rows() as usize;
    let cols = px.columns() as usize;
    let bits = px.bits_allocated() as u32;
    let signed = px.pixel_representation() as u32 == 1;
    let data = px.data();
    if (bits != 8 && bits != 16) || data.len() < rows * cols * (bits as usize / 8) {
        return Err("Unsupported or truncated palette image".into());
    }

    // Descriptor: [number of entries (0 means 65536), first mapped value, bits per entry]
    let descriptor = multi_f64(obj, tags::RED_PALETTE_COLOR_LOOKUP_TABLE_DESCRIPTOR)
        .filter(|d| d.len() >= 3)
        .ok_or("Missing palette descriptor")?;
    let entries = if descriptor[0] as usize == 0 { 65536 } else { descriptor[0] as usize };
    let first = descriptor[1] as i64;
    let entry_bits = descriptor[2] as u32;

    let table = |tag: Tag| -> Result<Vec<u8>, String> {
        let raw = bytes_of(obj, tag).ok_or("Missing palette lookup table data")?;
        // 16-bit entries: keep the high byte. 8-bit entries are stored one per word
        // in some files (values 0-255 in the low byte); keep the low byte then.
        let out: Vec<u8> = raw
            .chunks_exact(2)
            .take(entries)
            .map(|w| {
                let v = u16::from_le_bytes([w[0], w[1]]);
                if entry_bits <= 8 { v as u8 } else { (v >> 8) as u8 }
            })
            .collect();
        if out.is_empty() {
            return Err("Empty palette lookup table".into());
        }
        Ok(out)
    };
    let red = table(tags::RED_PALETTE_COLOR_LOOKUP_TABLE_DATA)?;
    let green = table(tags::GREEN_PALETTE_COLOR_LOOKUP_TABLE_DATA)?;
    let blue = table(tags::BLUE_PALETTE_COLOR_LOOKUP_TABLE_DATA)?;

    let mut out = Vec::with_capacity(rows * cols * 3);

    for i in 0..rows * cols {
        let v = sample_at(data, bits, signed, i) as i64;
        // Values below the first mapped one use the first entry, values above the last use the last
        let idx = (v - first).clamp(0, red.len() as i64 - 1) as usize;
        out.push(red[idx]);
        out.push(green.get(idx).copied().unwrap_or(0));
        out.push(blue.get(idx).copied().unwrap_or(0));
    }
    Ok((cols, rows, out))
}

// 8-bit interleaved RGB of a decoded colour image: (width, height, bytes).
// Palette images go through their lookup tables. For true colour the pixeldata
// crate handles planar layouts, YBR conversion and 16-bit samples.
fn rgb8_of(
    obj: &DefaultDicomObject,
    px: &DecodedPixelData<'_>,
) -> Result<(usize, usize, Vec<u8>), String> {
    if text_of(obj, tags::PHOTOMETRIC_INTERPRETATION) == "PALETTE COLOR" {
        return palette_to_rgb(obj, px);
    }
    let img = px.to_dynamic_image(0).map_err(|e| e.to_string())?.to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    Ok((w, h, img.into_raw()))
}

// 40-byte header of a slice response (little-endian):
// [rows u32][cols u32][bits u32][signed u32]
// [slope f32][intercept f32][wc f32][ww f32][mono1 u32][samples u32]
struct SliceHeader {
    rows: u32,
    cols: u32,
    bits: u32,
    signed: bool,
    slope: f32,
    intercept: f32,
    wc: f32,
    ww: f32,
    mono1: bool,
    samples: u32, // 1 = grayscale, 3 = RGB
}

impl SliceHeader {
    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.rows.to_le_bytes());
        out.extend_from_slice(&self.cols.to_le_bytes());
        out.extend_from_slice(&self.bits.to_le_bytes());
        out.extend_from_slice(&(self.signed as u32).to_le_bytes());
        out.extend_from_slice(&self.slope.to_le_bytes());
        out.extend_from_slice(&self.intercept.to_le_bytes());
        out.extend_from_slice(&self.wc.to_le_bytes());
        out.extend_from_slice(&self.ww.to_le_bytes());
        out.extend_from_slice(&(self.mono1 as u32).to_le_bytes());
        out.extend_from_slice(&self.samples.to_le_bytes());
    }
}

// Output size that keeps the aspect ratio and never upscales
fn fit_size(cols: usize, rows: usize, max_px: usize) -> (usize, usize) {
    let longest = rows.max(cols);
    if longest <= max_px {
        (cols, rows)
    } else {
        (
            (cols * max_px / longest).max(1),
            (rows * max_px / longest).max(1),
        )
    }
}

// Box-average downscale of interleaved RGB
fn downscale_rgb(src: &[u8], cols: usize, rows: usize, ow: usize, oh: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(ow * oh * 3);
    for oy in 0..oh {
        let y0 = oy * rows / oh;
        let y1 = ((oy + 1) * rows / oh).max(y0 + 1).min(rows);
        for ox in 0..ow {
            let x0 = ox * cols / ow;
            let x1 = ((ox + 1) * cols / ow).max(x0 + 1).min(cols);
            let mut sum = [0u32; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * cols + x) * 3;
                    sum[0] += src[i] as u32;
                    sum[1] += src[i + 1] as u32;
                    sum[2] += src[i + 2] as u32;
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u32;
            out.extend(sum.iter().map(|&s| (s / n) as u8));
        }
    }
    out
}

// Response (little-endian): [width u32][height u32][channels u32][width*height*channels bytes]
fn thumb_response(w: usize, h: usize, channels: u32, bytes: Vec<u8>) -> tauri::ipc::Response {
    let mut out = Vec::with_capacity(12 + bytes.len());
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&bytes);
    tauri::ipc::Response::new(out)
}

// ---------- Geometry and ordering ----------

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Unit slice normal, signed so that increasing position follows the usual
/// scrolling convention: axial heads toward the feet (superior first), coronal
/// toward the back (anterior first), sagittal toward the left (right first).
/// Patient axes are LPS: +x = left, +y = posterior, +z = superior.
fn scroll_normal(iop: &[f64; 6]) -> Option<Vec3> {
    let n = cross([iop[0], iop[1], iop[2]], [iop[3], iop[4], iop[5]]);
    let len = dot(n, n).sqrt();
    if !len.is_finite() || len < 1e-6 {
        return None;
    }
    let n = [n[0] / len, n[1] / len, n[2] / len];
    let axis = (0..3).max_by(|&a, &b| n[a].abs().total_cmp(&n[b].abs()))?;
    let want = if axis == 2 { -1.0 } else { 1.0 };
    Some(if n[axis] * want < 0.0 {
        [-n[0], -n[1], -n[2]]
    } else {
        n
    })
}

/// Sorts by position along the slice normal when every slice has position and
/// orientation, and by instance number otherwise.
fn sort_slices(v: &mut [SliceInfo]) {
    let normal = v.iter().find_map(|s| s.iop).and_then(|o| scroll_normal(&o));
    let positioned = v.iter().all(|s| s.ipp.is_some());

    match normal {
        Some(n) if positioned => {
            // Micrometre resolution: float noise must not reorder slices at the same position
            let key = |s: &SliceInfo| s.ipp.map_or(0, |p| (dot(p, n) * 1000.0).round() as i64);
            v.sort_by(|a, b| {
                key(a)
                    .cmp(&key(b))
                    .then(a.instance_number.cmp(&b.instance_number))
                    .then_with(|| a.path.cmp(&b.path))
                    .then(a.frame.cmp(&b.frame))
            });
        }
        _ => v.sort_by(|a, b| {
            (a.instance_number, &a.path, a.frame).cmp(&(b.instance_number, &b.path, b.frame))
        }),
    }
}

// Frames of one series in display order, sorted once and shared by all viewports
fn series_slices(state: &AppState, uid: &str) -> Arc<Vec<SliceInfo>> {
    let mut sorted = state.sorted.lock().unwrap();
    if let Some(v) = sorted.get(uid) {
        return Arc::clone(v);
    }
    let mut v: Vec<SliceInfo> = state
        .all
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.series_uid == uid)
        .cloned()
        .collect();
    sort_slices(&mut v);
    let v = Arc::new(v);
    if !v.is_empty() {
        sorted.insert(uid.to_string(), Arc::clone(&v));
    }
    v
}

/// (mean slice spacing in mm, spacing is regular, tilt in degrees) for sorted slices.
/// The spacing is None when positions are missing or all identical.
fn slice_geometry(v: &[SliceInfo]) -> (Option<f64>, bool, f64) {
    let normal = v.iter().find_map(|s| s.iop).and_then(|o| scroll_normal(&o));
    let pts: Vec<Vec3> = v.iter().filter_map(|s| s.ipp).collect();
    let Some(n) = normal else {
        return (None, true, 0.0);
    };
    if v.len() < 2 || pts.len() != v.len() {
        return (None, true, 0.0);
    }

    let pos: Vec<f64> = pts.iter().map(|p| dot(*p, n)).collect();
    let steps = pos.len() - 1;
    let mean = (pos[steps] - pos[0]) / steps as f64;
    if mean <= 0.0 {
        return (None, true, 0.0);
    }

    let tol = (mean * 0.01).max(0.01);
    let uniform = pos.windows(2).all(|w| ((w[1] - w[0]) - mean).abs() <= tol);

    // A stack axis that is not parallel to the normal means gantry tilt
    let d = [
        pts[steps][0] - pts[0][0],
        pts[steps][1] - pts[0][1],
        pts[steps][2] - pts[0][2],
    ];
    let len = dot(d, d).sqrt();
    let tilt = if len > 0.0 {
        (dot(d, n).abs() / len).clamp(0.0, 1.0).acos().to_degrees()
    } else {
        0.0
    };
    (Some(mean), uniform, tilt)
}

// ---------- Loading ----------

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
    let ipp = array_of::<3>(&obj, tags::IMAGE_POSITION_PATIENT);
    let iop = array_of::<6>(&obj, tags::IMAGE_ORIENTATION_PATIENT);
    let frame_of_reference = text_of(&obj, tags::FRAME_OF_REFERENCE_UID);

    (0..frames)
        .map(|frame| {
            (
                SliceInfo {
                    path: path.clone(),
                    series_uid: uid.clone(),
                    instance_number: inst,
                    frame,
                    ipp,
                    iop,
                    frame_of_reference: frame_of_reference.clone(),
                },
                desc.clone(),
            )
        })
        .collect()
}

fn open_cached(state: &AppState, path: &PathBuf) -> Result<Arc<DefaultDicomObject>, String> {
    // The lock is held while loading so that concurrent commands for the same
    // file (pixel data and metadata) trigger only one read.
    let mut files = state.files.lock().unwrap();
    if let Some(pos) = files.iter().position(|(p, _, _)| p == path) {
        let entry = files.remove(pos);
        let obj = Arc::clone(&entry.1);
        files.insert(0, entry);
        return Ok(obj);
    }

    let obj = Arc::new(dicom::object::open_file(path).map_err(|e| e.to_string())?);
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    files.insert(0, (path.clone(), Arc::clone(&obj), size));

    // Evict the least recently used files, but always keep the one just opened
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    while files.len() > 1 && (files.len() > FILE_CACHE_MAX_FILES || total > FILE_CACHE_MAX_BYTES) {
        if let Some(last) = files.pop() {
            total -= last.2;
        }
    }
    Ok(obj)
}

fn slice_ref(state: &AppState, uid: &str, index: usize) -> Result<(PathBuf, u32), String> {
    let slices = series_slices(state, uid);
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

    {
        // Same lock order as series_slices, so the two can never deadlock
        let mut sorted = state.sorted.lock().unwrap();
        let mut all = state.all.lock().unwrap();
        *all = parsed.into_iter().map(|(s, _)| s).collect();
        sorted.clear();
    }
    state.files.lock().unwrap().clear();
    // The old volume belongs to files that are no longer loaded
    *state.volume.lock().unwrap() = None;
    state.volume_gen.fetch_add(1, Ordering::SeqCst);

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

// ---------- Commands ----------
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
fn get_series_geometry(uid: String, state: tauri::State<AppState>) -> SeriesGeometry {
    let v = series_slices(&state, &uid);
    let frame_of_reference = v
        .first()
        .map(|s| s.frame_of_reference.clone())
        .unwrap_or_default();
    let normal = v.iter().find_map(|s| s.iop).and_then(|o| scroll_normal(&o));
    let positions = normal.and_then(|n| {
        let pos: Option<Vec<f64>> = v.iter().map(|s| s.ipp.map(|p| dot(p, n))).collect();
        pos.filter(|p| {
            let (lo, hi) = p
                .iter()
                .fold((f64::MAX, f64::MIN), |(lo, hi), &x| (lo.min(x), hi.max(x)));
            hi - lo > 1e-3
        })
    });
    SeriesGeometry {
        frame_of_reference,
        normal,
        positions,
    }
}

// Response: a 40-byte SliceHeader followed by the pixel bytes
// (16- or 8-bit samples for grayscale, 8-bit interleaved RGB for colour).
#[tauri::command(async)]
fn get_slice(
    uid: String,
    index: usize,
    state: tauri::State<AppState>,
) -> Result<tauri::ipc::Response, String> {
    let (path, frame) = slice_ref(&state, &uid, index)?;
    let obj = open_cached(&state, &path)?;
    let px = obj
        .decode_pixel_data_frame(frame)
        .map_err(|e| e.to_string())?;

    if is_color(&obj, &px) {

        // Rescale and windowing do not apply to colour images, so those fields stay neutral
        let (w, h, rgb) = rgb8_of(&obj, &px)?;
        let header = SliceHeader {
            rows: h as u32,
            cols: w as u32,
            bits: 8,
            signed: false,
            slope: 1.0,
            intercept: 0.0,
            wc: f32::NAN,
            ww: f32::NAN,
            mono1: false,
            samples: 3,
        };
        let mut out = Vec::with_capacity(40 + rgb.len());
        header.write(&mut out);
        out.extend_from_slice(&rgb);
        return Ok(tauri::ipc::Response::new(out));
    }

    if px.samples_per_pixel() != 1 {
        return Err(format!(
            "Unsupported number of samples per pixel: {}",
            px.samples_per_pixel()
        ));
    }

    // Note: only top-level rescale and window attributes are read. Enhanced
    // multiframe objects keep them in functional group sequences instead.
    let header = SliceHeader {
        rows: px.rows(),
        cols: px.columns(),
        bits: px.bits_allocated() as u32,
        signed: px.pixel_representation() as u32 == 1,
        slope: f64_of(&obj, tags::RESCALE_SLOPE, 1.0) as f32,
        intercept: f64_of(&obj, tags::RESCALE_INTERCEPT, 0.0) as f32,
        wc: first_f64(&obj, tags::WINDOW_CENTER).unwrap_or(f64::NAN) as f32,
        ww: first_f64(&obj, tags::WINDOW_WIDTH).unwrap_or(f64::NAN) as f32,
        mono1: text_of(&obj, tags::PHOTOMETRIC_INTERPRETATION) == "MONOCHROME1",
        samples: 1,
    };

    let data = px.data();
    let mut out = Vec::with_capacity(40 + data.len());
    header.write(&mut out);
    out.extend_from_slice(data);
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command(async)]
fn get_slice_meta(
    uid: String,
    index: usize,
    state: tauri::State<AppState>,
) -> Result<SliceMeta, String> {
    let (path, frame) = slice_ref(&state, &uid, index)?;
    let obj = open_cached(&state, &path)?;

    // PixelSpacing is calibrated to the patient; ImagerPixelSpacing is measured at the
    // detector, so lengths based on it are only approximate (projection radiography)
    let patient_spacing = multi_f64(&obj, tags::PIXEL_SPACING).filter(|v| v.len() >= 2);
    let used_imager = patient_spacing.is_none();
    let spacing = patient_spacing
        .or_else(|| multi_f64(&obj, tags::IMAGER_PIXEL_SPACING))
        .and_then(|v| if v.len() >= 2 { Some([v[0], v[1]]) } else { None });
    let spacing_is_imager = used_imager && spacing.is_some();

    let cine_fps = opt_f64(&obj, tags::CINE_RATE)
        .or_else(|| opt_f64(&obj, tags::FRAME_TIME).filter(|t| *t > 0.0).map(|t| 1000.0 / t))
        .or_else(|| opt_f64(&obj, tags::RECOMMENDED_DISPLAY_FRAME_RATE))
        .filter(|f| f.is_finite() && *f > 0.0);

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
        spacing_is_imager,
        cine_fps,
        image_orientation: orientation,
        patient_orientation: text_of(&obj, tags::PATIENT_ORIENTATION),
        frame,
        frame_count,
    })
}

// Shows the middle image of the series. Grayscale is windowed with the file's own
// window when present and with the 1st-99th percentile of the image otherwise;
// colour images are only scaled down. See thumb_response for the format.
#[tauri::command(async)]
fn get_thumbnail(
    uid: String,
    max_px: u32,
    state: tauri::State<AppState>,
) -> Result<tauri::ipc::Response, String> {
    let max_px = max_px.clamp(16, 512) as usize;
    let slices = series_slices(&state, &uid);
    let s = slices.get(slices.len() / 2).ok_or("Series not found")?;

    // Opened directly instead of through open_cached: the shared cache holds the
    // files shown in the viewports and must not be evicted by background thumbnails.
    let obj = dicom::object::open_file(&s.path).map_err(|e| e.to_string())?;
    let px = obj
        .decode_pixel_data_frame(s.frame)
        .map_err(|e| e.to_string())?;

    if is_color(&obj, &px) {
        let (w, h, rgb) = rgb8_of(&obj, &px)?;
        let (ow, oh) = fit_size(w, h, max_px);
        return Ok(thumb_response(ow, oh, 3, downscale_rgb(&rgb, w, h, ow, oh)));
    }
    if px.samples_per_pixel() != 1 {
        return Err(format!(
            "Unsupported number of samples per pixel: {}",
            px.samples_per_pixel()
        ));
    }

    let rows = px.rows() as usize;
    let cols = px.columns() as usize;
    let bits = px.bits_allocated() as u32;
    let signed = px.pixel_representation() as u32 == 1;
    let data = px.data();
    if rows == 0
        || cols == 0
        || (bits != 8 && bits != 16)
        || data.len() < rows * cols * (bits as usize / 8)
    {
        return Err("Unsupported or truncated pixel data".into());
    }

    let (ow, oh) = fit_size(cols, rows, max_px);

    // Box-average each output pixel over its block of source pixels
    let mut values: Vec<f32> = Vec::with_capacity(ow * oh);
    for oy in 0..oh {
        let y0 = oy * rows / oh;
        let y1 = ((oy + 1) * rows / oh).max(y0 + 1).min(rows);
        for ox in 0..ow {
            let x0 = ox * cols / ow;
            let x1 = ((ox + 1) * cols / ow).max(x0 + 1).min(cols);
            let mut sum = 0.0f64;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += sample_at(data, bits, signed, y * cols + x);
                }
            }
            values.push((sum / ((y1 - y0) * (x1 - x0)) as f64) as f32);
        }
    }

    // Rescale is linear, so applying it after averaging gives the same result
    let mut slope = f64_of(&obj, tags::RESCALE_SLOPE, 1.0);
    if slope == 0.0 {
        slope = 1.0;
    }
    let intercept = f64_of(&obj, tags::RESCALE_INTERCEPT, 0.0);
    for v in values.iter_mut() {
        *v = (*v as f64 * slope + intercept) as f32;
    }

    let window = match (
        first_f64(&obj, tags::WINDOW_CENTER),
        first_f64(&obj, tags::WINDOW_WIDTH),
    ) {
        (Some(c), Some(w)) if w > 0.0 => Some((c - w / 2.0, c + w / 2.0)),
        _ => None,
    };
    let (lo, hi) = window.unwrap_or_else(|| {
        let mut sorted = values.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let at = |q: f32| sorted[((sorted.len() - 1) as f32 * q) as usize] as f64;
        (at(0.01), at(0.99))
    });
    let width = (hi - lo).max(1e-6);

    let mono1 = text_of(&obj, tags::PHOTOMETRIC_INTERPRETATION) == "MONOCHROME1";
    let bytes: Vec<u8> = values
        .iter()
        .map(|&v| {
            let g = (((v as f64 - lo) / width) * 255.0).clamp(0.0, 255.0) as u8;
            if mono1 {
                255 - g
            } else {
                g
            }
        })
        .collect();
    Ok(thumb_response(ow, oh, 1, bytes))
}

// ---------- Volume ----------

// Decodes every requested frame of one file; the file is opened once
fn decode_group(
    path: &PathBuf,
    items: &[(usize, u32)],
    rows: usize,
    cols: usize,
) -> Result<Vec<(usize, Vec<f32>)>, String> {
    let obj = dicom::object::open_file(path).map_err(|e| e.to_string())?;
    let mut slope = f64_of(&obj, tags::RESCALE_SLOPE, 1.0);
    if slope == 0.0 {
        slope = 1.0;
    }
    let intercept = f64_of(&obj, tags::RESCALE_INTERCEPT, 0.0);

    let mut out = Vec::with_capacity(items.len());
    for &(index, frame) in items {
        let px = obj
            .decode_pixel_data_frame(frame)
            .map_err(|e| e.to_string())?;
        if px.samples_per_pixel() != 1 {
            return Err("Color images are not supported yet".into());
        }
        if px.rows() as usize != rows || px.columns() as usize != cols {
            return Err("The series contains images of different sizes".into());
        }
        let bits = px.bits_allocated() as u32;
        let signed = px.pixel_representation() as u32 == 1;
        let data = px.data();
        if (bits != 8 && bits != 16) || data.len() < rows * cols * (bits as usize / 8) {
            return Err("Unsupported or truncated pixel data".into());
        }

        let mut buf = vec![0f32; rows * cols];
        for (i, o) in buf.iter_mut().enumerate() {
            *o = (sample_at(data, bits, signed, i) * slope + intercept) as f32;
        }
        out.push((index, buf));
    }
    Ok(out)
}

// Builds the in-memory volume of a series (images in display order).
// The error text "superseded" means a newer build or file load replaced this one.
#[tauri::command(async)]
fn build_volume(uid: String, state: tauri::State<AppState>) -> Result<VolumeInfo, String> {
    if let Some(v) = state.volume.lock().unwrap().as_ref() {
        if v.uid == uid {
            return Ok(v.info.clone());
        }
    }

    let slices = series_slices(&state, &uid);
    if slices.len() < 2 {
        return Err("A volume needs at least 2 images".into());
    }
    let gen = state.volume_gen.fetch_add(1, Ordering::SeqCst) + 1;

    // Image size and pixel spacing come from the first image's header
    let head = OpenFileOptions::new()
        .read_until(tags::PIXEL_DATA)
        .open_file(&slices[0].path)
        .map_err(|e| e.to_string())?;
    let rows = head
        .element(tags::ROWS)
        .ok()
        .and_then(|e| e.to_int::<u32>().ok())
        .ok_or("Missing Rows")? as usize;
    let cols = head
        .element(tags::COLUMNS)
        .ok()
        .and_then(|e| e.to_int::<u32>().ok())
        .ok_or("Missing Columns")? as usize;
    let pixel_spacing = array_of::<2>(&head, tags::PIXEL_SPACING)
        .or_else(|| array_of::<2>(&head, tags::IMAGER_PIXEL_SPACING));

    let bytes = rows * cols * slices.len() * 4;
    if bytes > MAX_VOLUME_BYTES {
        return Err(format!(
            "The volume would need {} MB, the limit is {} MB",
            bytes >> 20,
            MAX_VOLUME_BYTES >> 20
        ));
    }

    // Group frames by file so each file is opened once
    let mut by_file: BTreeMap<PathBuf, Vec<(usize, u32)>> = BTreeMap::new();
    for (i, s) in slices.iter().enumerate() {
        by_file.entry(s.path.clone()).or_default().push((i, s.frame));
    }
    let groups: Vec<(PathBuf, Vec<(usize, u32)>)> = by_file.into_iter().collect();

    let decoded = groups
        .par_iter()
        .map(|(path, items)| decode_group(path, items, rows, cols))
        .collect::<Result<Vec<Vec<(usize, Vec<f32>)>>, String>>()?;

    let mut data: Vec<Vec<f32>> = vec![Vec::new(); slices.len()];
    for group in decoded {
        for (i, buf) in group {
            data[i] = buf;
        }
    }

    let (vmin, vmax) = data
        .par_iter()
        .map(|s| {
            s.iter()
                .fold((f32::MAX, f32::MIN), |(lo, hi), &x| (lo.min(x), hi.max(x)))
        })
        .reduce(
            || (f32::MAX, f32::MIN),
            |a, b| (a.0.min(b.0), a.1.max(b.1)),
        );

    let (slice_spacing, uniform, tilt_deg) = slice_geometry(&slices);

    // Position of every image along the stack direction. It is only trusted when every
    // image has a position; otherwise the views assume a regular spacing.
    let normal = slices.iter().find_map(|s| s.iop).and_then(|o| scroll_normal(&o));
    let fallback_step = slice_spacing
        .or(pixel_spacing.map(|p| p[1]))
        .unwrap_or(1.0);
    let ipps: Vec<Option<Vec3>> = slices.iter().map(|s| s.ipp).collect();
    let (z, z_real) = mpr::stack_positions(&ipps, normal, fallback_step);

    let window = match (
        first_f64(&head, tags::WINDOW_CENTER),
        first_f64(&head, tags::WINDOW_WIDTH),
    ) {
        (Some(c), Some(w)) if w > 0.0 => Some((c as f32, w as f32)),
        _ => None,
    };
    let mono1 = text_of(&head, tags::PHOTOMETRIC_INTERPRETATION) == "MONOCHROME1";

    let info = VolumeInfo {
        cols: cols as u32,
        rows: rows as u32,
        depth: slices.len() as u32,
        pixel_spacing,
        slice_spacing,
        uniform,
        tilt_deg,
        value_min: vmin as f64,
        value_max: vmax as f64,
        megabytes: bytes as f64 / (1024.0 * 1024.0),
        z_positions: z.clone(),
        orientation: slices.iter().find_map(|s| s.iop),
        z_dir: if z_real { normal } else { None },
    };

    if state.volume_gen.load(Ordering::SeqCst) != gen {
        return Err("Volume build superseded".into());
    }
    *state.volume.lock().unwrap() = Some(Arc::new(Volume {
        uid,
        info: info.clone(),
        slices: data,
        z,
        window,
        mono1,
    }));
    Ok(info)
}

// One reformatted image of the built volume. Response (little-endian):
// the 40-byte slice header (16-bit unsigned samples, slope and intercept restore the real
// values), then [spacing_x f32][spacing_y f32] in mm per pixel, then the samples.
#[tauri::command(async)]
fn get_mpr_slice(
    uid: String,
    plane: String,
    index: usize,
    slab: String,
    thickness_mm: f64,
    state: tauri::State<AppState>,
) -> Result<tauri::ipc::Response, String> {
    let vol = state
        .volume
        .lock()
        .unwrap()
        .as_ref()
        .filter(|v| v.uid == uid)
        .cloned()
        .ok_or("The volume of this series has not been built")?;

    let plane = mpr::Plane::parse(&plane)?;
    let slab = mpr::Slab::parse(&slab)?;
    let ps = vol.info.pixel_spacing;
    let geometry = mpr::Geometry {
        cols: vol.info.cols as usize,
        rows: vol.info.rows as usize,
        sx: ps.map_or(1.0, |p| p[1]),
        sy: ps.map_or(1.0, |p| p[0]),
        z: &vol.z,
    };
    let img = mpr::reformat(
        &vol.slices,
        &geometry,
        plane,
        index,
        slab,
        thickness_mm.clamp(0.0, 1.0e6),
    )?;

    let enc = mpr::encoding_for(vol.info.value_min, vol.info.value_max);
    let (wc, ww) = vol.window.unwrap_or((f32::NAN, f32::NAN));
    let samples = mpr::encode(&img.data, &enc);

    let mut out = Vec::with_capacity(48 + samples.len());
    out.extend_from_slice(&(img.height as u32).to_le_bytes()); // rows
    out.extend_from_slice(&(img.width as u32).to_le_bytes()); // cols
    out.extend_from_slice(&16u32.to_le_bytes()); // bits
    out.extend_from_slice(&0u32.to_le_bytes()); // unsigned
    out.extend_from_slice(&(enc.slope as f32).to_le_bytes());
    out.extend_from_slice(&(enc.intercept as f32).to_le_bytes());
    out.extend_from_slice(&wc.to_le_bytes());
    out.extend_from_slice(&ww.to_le_bytes());
    out.extend_from_slice(&(vol.mono1 as u32).to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes()); // samples per pixel
    out.extend_from_slice(&(img.spacing_x as f32).to_le_bytes());
    out.extend_from_slice(&(img.spacing_y as f32).to_le_bytes());
    out.extend_from_slice(&samples);
    Ok(tauri::ipc::Response::new(out))
}

// ---------- DICOM tag dump ----------

const MAX_TAG_ENTRIES: usize = 5000;
const MAX_VALUE_CHARS: usize = 300;

#[derive(Serialize)]
struct TagEntry {
    depth: u32,
    tag: String,   // "(0008,0060)"
    name: String,  // dictionary alias, e.g. "Modality"
    vr: String,
    value: String,
}

fn clip(s: &str) -> String {
    if s.chars().count() > MAX_VALUE_CHARS {
        let head: String = s.chars().take(MAX_VALUE_CHARS).collect();
        format!("{head}…")
    } else {
        s.to_string()
    }
}

// Flattens a dataset (and the items of its sequences) into display rows
fn dump_tags(obj: &InMemDicomObject, depth: u32, out: &mut Vec<TagEntry>) {
    for e in obj.iter() {
        if out.len() >= MAX_TAG_ENTRIES {
            return;
        }
        let tag = e.header().tag;
        let vr = e.header().vr();
        let name = StandardDataDictionary
            .by_tag(tag)
            .map(|d| d.alias().to_string())
            .unwrap_or_else(|| "(private or unknown)".to_string());

        let items = e.value().items();
        let value = if tag == tags::PIXEL_DATA {
            "(pixel data)".to_string()
        } else if let Some(items) = items {
            format!("Sequence, {} item(s)", items.len())
        } else if matches!(vr, VR::OB | VR::OW | VR::OD | VR::OF | VR::OL | VR::UN) {
            let len = e.to_bytes().map(|b| b.len()).unwrap_or(0);
            format!("(binary, {len} bytes)")
        } else {
            let text = e
                .to_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|_| format!("{:?}", e.value()));
            clip(text.trim_matches(|c: char| c.is_whitespace() || c == '\0'))
        };

        out.push(TagEntry {
            depth,
            tag: format!("({:04X},{:04X})", tag.group(), tag.element()),
            name,
            vr: String::from(vr.to_string()),
            value,
        });

        if let Some(items) = items {
            for item in items {
                dump_tags(item, depth + 1, out);
            }
        }
    }
}

#[tauri::command(async)]
fn get_tags(
    uid: String,
    index: usize,
    state: tauri::State<AppState>,
) -> Result<Vec<TagEntry>, String> {
    let (path, _frame) = slice_ref(&state, &uid, index)?;
    let obj = open_cached(&state, &path)?;

    let mut out = vec![TagEntry {
        depth: 0,
        tag: "(0002,0010)".into(),
        name: "TransferSyntaxUID".into(),
        vr: "UI".into(),
        value: obj.meta().transfer_syntax().to_string(),
    }];
    dump_tags(&obj, 0, &mut out);
    Ok(out)
}

// ---------- PNG saving ----------

// Raw request body: [path length u32 LE][path, UTF-8][PNG bytes]
#[tauri::command(async)]
fn save_png(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    if data.len() < 4 {
        return Err("Payload too short".into());
    }
    let n = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let end = 4usize
        .checked_add(n)
        .filter(|&e| e <= data.len())
        .ok_or("Invalid path length")?;
    let path = std::str::from_utf8(&data[4..end]).map_err(|e| e.to_string())?;
    if !path.to_ascii_lowercase().ends_with(".png") {
        return Err("Only .png files can be written".into());
    }
    std::fs::write(path, &data[end..]).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_folder,
            open_files,
            get_series_geometry,
            get_slice,
            get_slice_meta,
            get_thumbnail,
            build_volume,
            get_tags,
            save_png,
            get_mpr_slice
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}