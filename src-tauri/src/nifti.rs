//! NIfTI-1 and NIfTI-2 volumes (.nii and .nii.gz): the header, the voxels and where they lie
//! in the patient. A volume is turned into the layout of an axial DICOM series: columns
//! towards the patient's left, rows towards posterior, images towards superior. Axes are
//! only swapped and reversed, so no voxel value is changed or interpolated.
//!
//! Patient coordinates here are LPS like those of DICOM (+x left, +y posterior, +z superior).
//! NIfTI stores RAS, which differs in the sign of x and y.
//!
//! One volume is read at a time. Dimensions 4 to 7 of the file (time, and for example the six
//! components of a tensor) follow each other in the file, so they are counted as one list of
//! volumes. Everything that follows from the header is plain arithmetic, so it can be tested
//! without files.

use flate2::read::GzDecoder;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

/// Largest side of a volume that is accepted, against corrupt headers
const MAX_SIDE: usize = 16_384;
/// Most volumes of a 4D file that are accepted, against corrupt headers
const MAX_VOLUMES: usize = 1_000_000;
/// Voxels are held as 32-bit floats; same limit as for DICOM volumes
const MAX_BYTES: usize = 4 * 1024 * 1024 * 1024;

/// 3 x 4 matrix: a voxel index (i, j, k, 1) to millimetres
pub type Mat34 = [[f64; 4]; 3];

#[derive(Clone, Debug)]
pub struct Header {
    pub version: u8, // 1 or 2
    pub big_endian: bool,
    /// Voxels along x, y and z, and the number of volumes (1 when there is no 4th dimension).
    /// Dimensions 4 to 7 of the file are multiplied: the volumes follow each other in the file.
    pub dims: [usize; 3],
    pub volumes: usize,
    /// The sizes of dimensions 4 and up, as the file has them (empty for a 3D file)
    pub extra_dims: Vec<usize>,
    /// What the data mean (NIfTI `intent_code`; 0 for nothing in particular) and the name
    pub intent_code: i32,
    pub intent_name: String,
    pub datatype: i16,
    pub pixdim: [f64; 8],
    pub vox_offset: u64,
    pub slope: f64,
    pub inter: f64,
    pub qform_code: i32,
    pub sform_code: i32,
    pub description: String,
    /// Voxel index to RAS millimetres, as the header says
    pub ras: Mat34,
    /// False when the header has neither a qform nor an sform: the axes are then a guess
    pub placed: bool,
}

// ---------- Reading the header ----------

struct Reader<'a> {
    b: &'a [u8],
    big: bool,
}

impl Reader<'_> {
    fn bytes<const N: usize>(&self, at: usize) -> Result<[u8; N], String> {
        self.b
            .get(at..at + N)
            .and_then(|s| s.try_into().ok())
            .ok_or_else(|| "The header is cut short".to_string())
    }
    fn i16(&self, at: usize) -> Result<i16, String> {
        let b = self.bytes::<2>(at)?;
        Ok(if self.big { i16::from_be_bytes(b) } else { i16::from_le_bytes(b) })
    }
    fn i32(&self, at: usize) -> Result<i32, String> {
        let b = self.bytes::<4>(at)?;
        Ok(if self.big { i32::from_be_bytes(b) } else { i32::from_le_bytes(b) })
    }
    fn i64(&self, at: usize) -> Result<i64, String> {
        let b = self.bytes::<8>(at)?;
        Ok(if self.big { i64::from_be_bytes(b) } else { i64::from_le_bytes(b) })
    }
    fn f32(&self, at: usize) -> Result<f64, String> {
        let b = self.bytes::<4>(at)?;
        Ok(f64::from(if self.big { f32::from_be_bytes(b) } else { f32::from_le_bytes(b) }))
    }
    fn f64(&self, at: usize) -> Result<f64, String> {
        let b = self.bytes::<8>(at)?;
        Ok(if self.big { f64::from_be_bytes(b) } else { f64::from_le_bytes(b) })
    }
    fn text(&self, at: usize, len: usize) -> String {
        let s = self.b.get(at..at + len).unwrap_or(&[]);
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        String::from_utf8_lossy(&s[..end]).trim().to_string()
    }
}

/// Size of the header that a file starts with, read from its first four bytes.
pub fn header_size(first: &[u8]) -> Option<(usize, bool)> {
    let b: [u8; 4] = first.get(..4)?.try_into().ok()?;
    for (big, v) in [(false, i32::from_le_bytes(b)), (true, i32::from_be_bytes(b))] {
        if v == 348 || v == 540 {
            return Some((v as usize, big));
        }
    }
    None
}

pub fn parse_header(bytes: &[u8]) -> Result<Header, String> {
    let (size, big) = header_size(bytes).ok_or("Not a NIfTI file (the header size is wrong)")?;
    let r = Reader { b: bytes, big };
    let v2 = size == 540;

    // Field positions of the two versions
    let (dim_at, datatype_at, pixdim_at, offset_at, slope_at, inter_at, descrip_at, qform_at, sform_at, quat_at, srow_at, units_at, intent_at, intent_name_at) =
        if v2 {
            (16, 12, 104, 168, 176, 184, 240, 344, 348, 352, 400, 500, 504, 508)
        } else {
            (40, 70, 76, 108, 112, 116, 148, 252, 254, 256, 280, 123, 68, 328)
        };

    let magic = if v2 { r.text(4, 4) } else { r.text(344, 4) };
    if !(magic == "n+1" || magic == "n+2" || magic == "ni1") {
        return Err(format!("Not a NIfTI file (the magic is {magic:?})"));
    }
    if magic == "ni1" {
        return Err("NIfTI files in two parts (.hdr and .img) are not supported".into());
    }

    let ndim = if v2 { r.i64(dim_at)? } else { i64::from(r.i16(dim_at)?) };
    if !(3..=7).contains(&ndim) {
        return Err(format!("The image has {ndim} dimensions; at least 3 are needed"));
    }
    let dim = |n: usize| -> Result<i64, String> {
        if v2 { r.i64(dim_at + 8 * n) } else { Ok(i64::from(r.i16(dim_at + 2 * n)?)) }
    };
    let size_of = |n: i64| -> Result<usize, String> {
        usize::try_from(n)
            .ok()
            .filter(|&s| (1..=MAX_SIDE).contains(&s))
            .ok_or_else(|| format!("Unreasonable image size: {n}"))
    };
    let dims = [size_of(dim(1)?)?, size_of(dim(2)?)?, size_of(dim(3)?)?];
    let mut extra_dims = Vec::new();
    for n in 4..=ndim as usize {
        extra_dims.push(size_of(dim(n)?.max(1))?);
    }
    let volumes = extra_dims
        .iter()
        .try_fold(1usize, |acc, &d| acc.checked_mul(d))
        .filter(|&v| v <= MAX_VOLUMES)
        .ok_or("The image has too many volumes")?;
    let (intent_code, intent_name) = if v2 {
        (r.i32(intent_at)?, r.text(intent_name_at, 16))
    } else {
        (i32::from(r.i16(intent_at)?), r.text(intent_name_at, 16))
    };

    let datatype = r.i16(datatype_at)?;
    let mut pixdim = [0.0; 8];
    for (n, p) in pixdim.iter_mut().enumerate() {
        *p = if v2 { r.f64(pixdim_at + 8 * n)? } else { r.f32(pixdim_at + 4 * n)? };
    }
    let vox_offset = if v2 {
        r.i64(offset_at)?.max(0) as u64
    } else {
        r.f32(offset_at)?.max(0.0) as u64
    };
    let (mut slope, inter) = if v2 {
        (r.f64(slope_at)?, r.f64(inter_at)?)
    } else {
        (r.f32(slope_at)?, r.f32(inter_at)?)
    };
    if slope == 0.0 || !slope.is_finite() {
        slope = 1.0; // 0 means "no scaling"
    }
    let inter = if inter.is_finite() { inter } else { 0.0 };

    let (qform_code, sform_code) = if v2 {
        (r.i32(qform_at)?, r.i32(sform_at)?)
    } else {
        (i32::from(r.i16(qform_at)?), i32::from(r.i16(sform_at)?))
    };
    let real = |at: usize| if v2 { r.f64(at) } else { r.f32(at) };
    let step = if v2 { 8 } else { 4 };

    // Spatial units: 1 metre, 2 millimetre, 3 micrometre. Everything below is in millimetres.
    let units = if v2 { r.i32(units_at)? } else { i32::from(r.bytes::<1>(units_at)?[0]) } & 7;
    let to_mm = match units {
        1 => 1000.0,
        3 => 0.001,
        _ => 1.0,
    };

    let mut ras = [[0.0; 4]; 3];
    let mut placed = true;
    if sform_code > 0 {
        for (row, out) in ras.iter_mut().enumerate() {
            for (col, v) in out.iter_mut().enumerate() {
                *v = real(srow_at + (row * 4 + col) * step)?;
            }
        }
    } else if qform_code > 0 {
        let (b, c, d) = (real(quat_at)?, real(quat_at + step)?, real(quat_at + 2 * step)?);
        let offset = [real(quat_at + 3 * step)?, real(quat_at + 4 * step)?, real(quat_at + 5 * step)?];
        ras = from_quaternion(b, c, d, offset, &pixdim);
    } else {
        // The oldest style: axes along the voxel axes, no position
        placed = false;
        for (n, row) in ras.iter_mut().enumerate() {
            row[n] = pixdim[n + 1];
        }
    }
    for row in &mut ras {
        for v in row.iter_mut() {
            *v *= to_mm;
        }
    }
    if ras.iter().flatten().any(|v| !v.is_finite()) {
        return Err("The position of the image is not a number".into());
    }

    Ok(Header {
        version: if v2 { 2 } else { 1 },
        big_endian: big,
        dims,
        volumes,
        extra_dims,
        intent_code,
        intent_name,
        datatype,
        pixdim,
        vox_offset,
        slope,
        inter,
        qform_code,
        sform_code,
        description: r.text(descrip_at, 80),
        ras,
        placed,
    })
}

/// The "method 2" of the NIfTI standard: a rotation as a quaternion (b, c, d), the sign of the
/// third axis in `pixdim[0]`, and the position of the first voxel.
fn from_quaternion(b: f64, c: f64, d: f64, offset: [f64; 3], pixdim: &[f64; 8]) -> Mat34 {
    let a = (1.0 - b * b - c * c - d * d).max(0.0).sqrt();
    let r = [
        [a * a + b * b - c * c - d * d, 2.0 * (b * c - a * d), 2.0 * (b * d + a * c)],
        [2.0 * (b * c + a * d), a * a + c * c - b * b - d * d, 2.0 * (c * d - a * b)],
        [2.0 * (b * d - a * c), 2.0 * (c * d + a * b), a * a + d * d - b * b - c * c],
    ];
    let qfac = if pixdim[0] < 0.0 { -1.0 } else { 1.0 };
    let scale = [pixdim[1], pixdim[2], qfac * pixdim[3]];
    let mut m = [[0.0; 4]; 3];
    for row in 0..3 {
        for col in 0..3 {
            m[row][col] = r[row][col] * scale[col];
        }
        m[row][3] = offset[row];
    }
    m
}

// ---------- Where the voxels are ----------

/// A volume as an axial series: how many voxels there are along each of the new axes and where
/// they lie. The new axes are L (columns), P (rows) and S (images), all pointing the positive way.
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    /// Columns, rows and images
    pub dims: [usize; 3],
    /// Millimetres between voxels along the columns, the rows and the images
    pub spacing: [f64; 3],
    /// Patient position (LPS) of the first voxel (column 0, row 0, image 0)
    pub origin: [f64; 3],
    /// Unit vectors: the direction in which the column, the row and the image index grow
    pub dirs: [[f64; 3]; 3],
    /// For the new axes L, P and S: the axis of the file that becomes it, and whether it is reversed
    pub axes: [(usize, bool); 3],
}

impl Placement {
    /// Patient position (LPS) of the first voxel of image `k`: the ImagePositionPatient
    pub fn ipp(&self, k: usize) -> [f64; 3] {
        let s = self.spacing[2] * k as f64;
        [
            self.origin[0] + self.dirs[2][0] * s,
            self.origin[1] + self.dirs[2][1] * s,
            self.origin[2] + self.dirs[2][2] * s,
        ]
    }

    /// Row and column direction cosines: the ImageOrientationPatient
    pub fn iop(&self) -> [f64; 6] {
        let (c, r) = (self.dirs[0], self.dirs[1]);
        [c[0], c[1], c[2], r[0], r[1], r[2]]
    }

    /// Patient position (LPS) of a voxel of the new grid
    #[cfg(test)]
    pub fn position(&self, i: usize, j: usize, k: usize) -> [f64; 3] {
        let p = self.ipp(k);
        let (a, b) = (self.spacing[0] * i as f64, self.spacing[1] * j as f64);
        [
            p[0] + self.dirs[0][0] * a + self.dirs[1][0] * b,
            p[1] + self.dirs[0][1] * a + self.dirs[1][1] * b,
            p[2] + self.dirs[0][2] * a + self.dirs[1][2] * b,
        ]
    }
}

const PERMUTATIONS: [[usize; 3]; 6] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/// Chooses which axis of the file becomes L, P and S: the assignment that follows the
/// directions of the voxel axes best, and the sign of each. `ras` is the matrix of the header.
pub fn place(dims: [usize; 3], ras: &Mat34) -> Result<Placement, String> {
    // To patient coordinates LPS: x and y change sign
    let m: Mat34 = [
        [-ras[0][0], -ras[0][1], -ras[0][2], -ras[0][3]],
        [-ras[1][0], -ras[1][1], -ras[1][2], -ras[1][3]],
        ras[2],
    ];
    let col = |a: usize| [m[0][a], m[1][a], m[2][a]];
    let norm = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if (0..3).any(|a| norm(col(a)) < 1e-9) {
        return Err("The voxels have no size in the header".into());
    }

    // perm[w] = the axis of the file that becomes world axis w (0 = L, 1 = P, 2 = S)
    let score = |p: &[usize; 3]| (0..3).map(|w| m[w][p[w]].abs() / norm(col(p[w]))).sum::<f64>();
    let perm = PERMUTATIONS
        .iter()
        .max_by(|a, b| score(a).total_cmp(&score(b)))
        .copied()
        .unwrap_or([0, 1, 2]);

    let mut axes = [(0usize, false); 3];
    let mut spacing = [0.0; 3];
    let mut dirs = [[0.0; 3]; 3];
    let mut origin = [m[0][3], m[1][3], m[2][3]];
    let mut out_dims = [0usize; 3];
    for w in 0..3 {
        let a = perm[w];
        let reversed = m[w][a] < 0.0;
        let c = col(a);
        let len = norm(c);
        let sign = if reversed { -1.0 } else { 1.0 };
        axes[w] = (a, reversed);
        spacing[w] = len;
        dirs[w] = [sign * c[0] / len, sign * c[1] / len, sign * c[2] / len];
        out_dims[w] = dims[a];
        if reversed {
            // The new first voxel is the old last one
            let n = (dims[a] - 1) as f64;
            for (o, v) in origin.iter_mut().zip(c) {
                *o += n * v;
            }
        }
    }
    Ok(Placement { dims: out_dims, spacing, origin, dirs, axes })
}

/// The letters that describe how the axes of the file grow, as in "RAS" or "LPI": the side of
/// the patient that each axis points to.
pub fn orientation_code(ras: &Mat34) -> String {
    (0..3)
        .map(|a| {
            let col = [ras[0][a], ras[1][a], ras[2][a]];
            let w = (0..3).max_by(|&x, &y| col[x].abs().total_cmp(&col[y].abs())).unwrap_or(0);
            match (w, col[w] >= 0.0) {
                (0, true) => 'R',
                (0, false) => 'L',
                (1, true) => 'A',
                (1, false) => 'P',
                (2, true) => 'S',
                _ => 'I',
            }
        })
        .collect()
}

/// Turns the voxels (x fastest, then y, then z) into images of the new layout.
pub fn reorient(data: &[f32], dims: [usize; 3], p: &Placement) -> Vec<Vec<f32>> {
    let stride = [1usize, dims[0], dims[0] * dims[1]];
    // For each new axis: where the first voxel is in the old array and the step
    let walk = |w: usize| -> (isize, isize) {
        let (a, reversed) = p.axes[w];
        let s = stride[a] as isize;
        if reversed { ((dims[a] as isize - 1) * s, -s) } else { (0, s) }
    };
    let (x0, dx) = walk(0);
    let (y0, dy) = walk(1);
    let (z0, dz) = walk(2);
    (0..p.dims[2])
        .map(|k| {
            let mut slice = Vec::with_capacity(p.dims[0] * p.dims[1]);
            for j in 0..p.dims[1] {
                let row = z0 + k as isize * dz + y0 + j as isize * dy;
                for i in 0..p.dims[0] {
                    slice.push(data[(row + x0 + i as isize * dx) as usize]);
                }
            }
            slice
        })
        .collect()
}

// ---------- Reading the voxels ----------

fn bytes_per_voxel(datatype: i16) -> Result<usize, String> {
    Ok(match datatype {
        2 | 256 => 1,           // uint8, int8
        4 | 512 => 2,           // int16, uint16
        8 | 768 | 16 => 4,      // int32, uint32, float32
        64 | 1024 | 1280 => 8,  // float64, int64, uint64
        128 | 2304 => return Err("Colour (RGB) NIfTI images are not supported".into()),
        32 | 1792 => return Err("Complex NIfTI images are not supported".into()),
        other => return Err(format!("Unsupported NIfTI data type: {other}")),
    })
}

/// Whether the voxels of this data type can be read
pub fn supported(datatype: i16) -> bool {
    bytes_per_voxel(datatype).is_ok()
}

pub fn datatype_name(datatype: i16) -> &'static str {
    match datatype {
        2 => "uint8",
        4 => "int16",
        8 => "int32",
        16 => "float32",
        64 => "float64",
        256 => "int8",
        512 => "uint16",
        768 => "uint32",
        1024 => "int64",
        1280 => "uint64",
        128 => "rgb24",
        32 | 1792 => "complex",
        _ => "unknown",
    }
}

fn decode(bytes: &[u8], h: &Header) -> Vec<f32> {
    macro_rules! each {
        ($t:ty, $n:expr) => {
            bytes
                .chunks_exact($n)
                .map(|c| {
                    let a: [u8; $n] = c.try_into().unwrap_or([0; $n]);
                    (if h.big_endian { <$t>::from_be_bytes(a) } else { <$t>::from_le_bytes(a) }) as f64
                })
                .collect::<Vec<f64>>()
        };
    }
    let raw: Vec<f64> = match h.datatype {
        2 => bytes.iter().map(|&b| f64::from(b)).collect(),
        256 => bytes.iter().map(|&b| f64::from(b as i8)).collect(),
        4 => each!(i16, 2),
        512 => each!(u16, 2),
        8 => each!(i32, 4),
        768 => each!(u32, 4),
        16 => each!(f32, 4),
        64 => each!(f64, 8),
        1024 => each!(i64, 8),
        _ => each!(u64, 8),
    };
    raw.into_iter()
        .map(|v| {
            let s = v * h.slope + h.inter;
            if s.is_finite() { s as f32 } else { 0.0 } // NaN and infinity are shown as 0
        })
        .collect()
}

/// Opens a file, unzipping it when it is gzip-compressed (found by its first two bytes).
fn open(path: &Path) -> Result<Box<dyn Read>, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut magic = [0u8; 2];
    let n = f.read(&mut magic).map_err(|e| e.to_string())?;
    drop(f);
    let f = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    Ok(if n == 2 && magic == [0x1f, 0x8b] { Box::new(GzDecoder::new(f)) } else { Box::new(f) })
}

/// Reads only the header of a file.
pub fn read_header(path: &Path) -> Result<Header, String> {
    let mut r = open(path)?;
    let mut buf = vec![0u8; 540];
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) => return Err(e.to_string()),
        }
    }
    buf.truncate(got);
    parse_header(&buf)
}

/// The voxel bytes of all volumes of a file, unzipped. Switching between the volumes of a 4D
/// file is then quick. None when they would not fit in `max_bytes`.
pub fn read_raw(path: &Path, h: &Header, max_bytes: usize) -> Result<Option<Vec<u8>>, String> {
    let per = bytes_per_voxel(h.datatype)?;
    let total = h.dims[0] * h.dims[1] * h.dims[2] * per * h.volumes;
    if total > max_bytes {
        return Ok(None);
    }
    let mut r = open(path)?;
    std::io::copy(&mut (&mut r).take(h.vox_offset), &mut std::io::sink()).map_err(|e| e.to_string())?;
    let mut bytes = vec![0u8; total];
    r.read_exact(&mut bytes)
        .map_err(|e| format!("The file is shorter than its header says: {e}"))?;
    Ok(Some(bytes))
}

/// One volume out of the bytes that `read_raw` returned.
pub fn load_from_raw(h: &Header, raw: &[u8], volume: usize) -> Result<Loaded, String> {
    if volume >= h.volumes {
        return Err(format!("The file has {} volume(s), not {}", h.volumes, volume + 1));
    }
    let per = bytes_per_voxel(h.datatype)?;
    let n = h.dims[0] * h.dims[1] * h.dims[2] * per;
    let bytes = raw.get(volume * n..(volume + 1) * n).ok_or("The file is shorter than its header says")?;
    finish(h.clone(), volume, decode(bytes, h))
}

/// Reads one volume of a file (0 is the first): x fastest, then y, then z, with the scaling
/// applied. The volumes of a 4D file follow each other, so the ones before it are skipped.
/// A gzip file cannot be entered in the middle: they are read through and thrown away.
pub fn read_voxels(path: &Path, h: &Header, volume: usize) -> Result<Vec<f32>, String> {
    if volume >= h.volumes {
        return Err(format!("The file has {} volume(s), not {}", h.volumes, volume + 1));
    }
    let per = bytes_per_voxel(h.datatype)?;
    let n = h.dims[0] * h.dims[1] * h.dims[2];
    if n * 4 > MAX_BYTES {
        return Err(format!("The volume would need {} MB, the limit is {} MB", (n * 4) >> 20, MAX_BYTES >> 20));
    }
    let mut r = open(path)?;
    // Skip the header (and any extension) and the volumes before this one
    let skip = h.vox_offset + (volume * n * per) as u64;
    std::io::copy(&mut (&mut r).take(skip), &mut std::io::sink()).map_err(|e| e.to_string())?;
    let mut bytes = vec![0u8; n * per];
    r.read_exact(&mut bytes)
        .map_err(|e| format!("The file is shorter than its header says: {e}"))?;
    Ok(decode(&bytes, h))
}

// ---------- One voxel through all volumes ----------

/// Index of the voxel in a volume of the file (x fastest) that shows at column `col`, row `row`
/// of image `image` of the layout `p`
pub fn file_voxel(dims: [usize; 3], p: &Placement, col: usize, row: usize, image: usize) -> Option<usize> {
    let shown = [col, row, image];
    if (0..3).any(|w| shown[w] >= p.dims[w]) {
        return None;
    }
    let mut at = [0usize; 3];
    for w in 0..3 {
        let (axis, reversed) = p.axes[w];
        at[axis] = if reversed { dims[axis] - 1 - shown[w] } else { shown[w] };
    }
    Some(at[0] + dims[0] * (at[1] + dims[1] * at[2]))
}

/// The value of one voxel in every volume, from the bytes that `read_raw` returned
pub fn series_from_raw(h: &Header, raw: &[u8], voxel: usize) -> Result<Vec<f32>, String> {
    let per = bytes_per_voxel(h.datatype)?;
    let n = h.dims[0] * h.dims[1] * h.dims[2];
    if voxel >= n {
        return Err("The voxel is outside the volume".into());
    }
    let mut out = Vec::with_capacity(h.volumes);
    for t in 0..h.volumes {
        let at = (t * n + voxel) * per;
        let bytes = raw.get(at..at + per).ok_or("The file is shorter than its header says")?;
        out.extend(decode(bytes, h));
    }
    Ok(out)
}

/// The value of one voxel in every volume, read through the file once. Nothing is kept in
/// memory but the values, so it also works for files that are too big for `read_raw`.
pub fn read_series(path: &Path, h: &Header, voxel: usize) -> Result<Vec<f32>, String> {
    let per = bytes_per_voxel(h.datatype)?;
    let n = h.dims[0] * h.dims[1] * h.dims[2];
    if voxel >= n {
        return Err("The voxel is outside the volume".into());
    }
    let mut r = open(path)?;
    // Skip the header, then for each volume the voxels before it and (afterwards) the rest
    let mut skip = h.vox_offset + (voxel * per) as u64;
    let mut out = Vec::with_capacity(h.volumes);
    let mut buf = vec![0u8; per];
    for _ in 0..h.volumes {
        std::io::copy(&mut (&mut r).take(skip), &mut std::io::sink()).map_err(|e| e.to_string())?;
        r.read_exact(&mut buf)
            .map_err(|e| format!("The file is shorter than its header says: {e}"))?;
        out.extend(decode(&buf, h));
        skip = ((n - voxel - 1) * per + voxel * per) as u64;
    }
    Ok(out)
}

// ---------- Diffusion: b-values and gradient directions ----------

/// What the `.bval` and `.bvec` files next to a diffusion image say, one entry per volume
#[derive(Clone, Debug, PartialEq)]
pub struct Diffusion {
    pub bvals: Vec<f64>,
    /// Gradient directions as unit vectors in patient coordinates (LPS); zero for volumes
    /// without a gradient
    pub dirs: Vec<[f64; 3]>,
}

/// The name of a file next to the image with another ending: `sub-01_dwi.nii.gz` has
/// `sub-01_dwi.bval`
pub fn sidecar(path: &Path, ext: &str) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let lower = name.to_lowercase();
    let cut = if lower.ends_with(".nii.gz") {
        name.len() - 7
    } else if lower.ends_with(".nii") {
        name.len() - 4
    } else {
        name.len()
    };
    path.with_file_name(format!("{}.{ext}", &name[..cut]))
}

fn numbers(text: &str) -> Result<Vec<Vec<f64>>, String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            l.split(|c: char| c.is_whitespace() || c == ',')
                .filter(|w| !w.is_empty())
                .map(|w| w.parse::<f64>().ok().filter(|v| v.is_finite()).ok_or_else(|| format!("{w:?} is not a number")))
                .collect()
        })
        .collect()
}

/// A `.bval` file: the b-values on one line (or one per line)
pub fn parse_bvals(text: &str) -> Result<Vec<f64>, String> {
    Ok(numbers(text)?.into_iter().flatten().collect())
}

/// A `.bvec` file: three lines (x, y and z) with one number per volume, as FSL writes them.
/// A file with one line of three numbers per volume is accepted too.
pub fn parse_bvecs(text: &str) -> Result<Vec<[f64; 3]>, String> {
    let rows = numbers(text)?;
    if rows.len() == 3 && rows[0].len() == rows[1].len() && rows[0].len() == rows[2].len() {
        return Ok((0..rows[0].len()).map(|i| [rows[0][i], rows[1][i], rows[2][i]]).collect());
    }
    rows.into_iter()
        .map(|r| <[f64; 3]>::try_from(r).map_err(|_| "A .bvec file has three lines of numbers".to_string()))
        .collect()
}

/// Turns the directions of a `.bvec` file into patient coordinates (LPS). FSL gives them along
/// the voxel axes of the file, with the first one reversed when the file is stored the way
/// that a left-handed (positive determinant) matrix says.
pub fn bvecs_to_patient(bvecs: &[[f64; 3]], ras: &Mat34) -> Vec<[f64; 3]> {
    let col = |a: usize| [ras[0][a], ras[1][a], ras[2][a]];
    let (c0, c1, c2) = (col(0), col(1), col(2));
    let det = c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1])
        + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
    let flip = if det > 0.0 { -1.0 } else { 1.0 };
    let unit = |v: [f64; 3]| {
        let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        if n > 1e-9 { [v[0] / n, v[1] / n, v[2] / n] } else { [0.0; 3] }
    };
    let axes = [unit(c0), unit(c1), unit(c2)];
    bvecs
        .iter()
        .map(|b| {
            let b = [b[0] * flip, b[1], b[2]];
            let mut ras_dir = [0.0; 3];
            for (k, axis) in axes.iter().enumerate() {
                for (o, a) in ras_dir.iter_mut().zip(axis) {
                    *o += b[k] * a;
                }
            }
            // RAS to LPS
            unit([-ras_dir[0], -ras_dir[1], ras_dir[2]])
        })
        .collect()
}

/// The diffusion data of an image: None when there are no `.bval` and `.bvec` files next to it.
/// An Err says why files that exist cannot be used (for example another number of volumes).
pub fn read_diffusion(path: &Path, h: &Header) -> Option<Result<Diffusion, String>> {
    let (bval_path, bvec_path) = (sidecar(path, "bval"), sidecar(path, "bvec"));
    if !bval_path.is_file() || !bvec_path.is_file() {
        return None;
    }
    Some((|| {
        let bvals = parse_bvals(&std::fs::read_to_string(&bval_path).map_err(|e| e.to_string())?)?;
        let bvecs = parse_bvecs(&std::fs::read_to_string(&bvec_path).map_err(|e| e.to_string())?)?;
        if bvals.len() != h.volumes || bvecs.len() != h.volumes {
            return Err(format!(
                "The image has {} volumes, the .bval file {} values and the .bvec file {} directions",
                h.volumes,
                bvals.len(),
                bvecs.len()
            ));
        }
        Ok(Diffusion { bvals, dirs: bvecs_to_patient(&bvecs, &h.ras) })
    })())
}

// ---------- A volume ready for the viewer ----------

pub struct Loaded {
    pub header: Header,
    /// Which volume of the file this is (0 for the first)
    pub volume: usize,
    pub placement: Placement,
    /// Images in the new layout, image 0 first
    pub slices: Vec<Vec<f32>>,
    pub min: f32,
    pub max: f32,
    /// 2nd and 98th percentile of the values
    pub low: f32,
    pub high: f32,
}

pub fn load(path: &Path, volume: usize) -> Result<Loaded, String> {
    let header = read_header(path)?;
    let data = read_voxels(path, &header, volume)?;
    finish(header, volume, data)
}

// From the voxels of a volume to what the viewer needs
fn finish(header: Header, volume: usize, data: Vec<f32>) -> Result<Loaded, String> {
    let placement = place(header.dims, &header.ras)?;
    let slices = reorient(&data, header.dims, &placement);
    drop(data);
    let (min, max) = slices
        .iter()
        .flatten()
        .fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let (low, high) = crate::mpr::percentiles(&slices, min, max, 0.02, 0.98);
    Ok(Loaded { header, volume, placement, slices, min, max, low, high })
}

/// Whether a path names a NIfTI file
pub fn is_nifti(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
    name.ends_with(".nii") || name.ends_with(".nii.gz")
}

/// The file name without .nii or .nii.gz
pub fn stem(path: &Path) -> String {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let lower = name.to_ascii_lowercase();
    for ext in [".nii.gz", ".nii"] {
        if lower.ends_with(ext) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name
}

/// The modality of a BIDS file: from the `Modality` of the JSON file next to it, or from the
/// suffix of its name ("sub-01_T1w" is an MR image). Empty when neither says.
pub fn modality(path: &Path) -> String {
    let json = path.with_file_name(format!("{}.json", stem(path)));
    if let Some(m) = std::fs::read_to_string(json)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("Modality").and_then(|m| m.as_str().map(str::to_string)))
        .filter(|m| m.len() <= 8 && m.chars().all(|c| c.is_ascii_alphabetic()))
    {
        return m.to_ascii_uppercase();
    }
    let suffix = stem(path).rsplit('_').next().unwrap_or("").to_string();
    match suffix.as_str() {
        "T1w" | "T2w" | "T1rho" | "T2star" | "FLAIR" | "PDw" | "PDT2" | "inplaneT1" | "inplaneT2"
        | "angio" | "bold" | "cbv" | "dwi" | "asl" | "MP2RAGE" | "MPRAGE" | "SWI" | "MEGRE" | "MESE" => {
            "MR".into()
        }
        "CT" => "CT".into(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    // ----- building files -----

    struct Spec {
        dims: [usize; 4],
        datatype: i16,
        pixdim: [f64; 3],
        sform: Option<Mat34>,
        big: bool,
        slope: f64,
        inter: f64,
        v2: bool,
    }

    fn spec(dims: [usize; 4]) -> Spec {
        Spec {
            dims,
            datatype: 4,
            pixdim: [1.0, 1.0, 1.0],
            sform: Some([[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]),
            big: false,
            slope: 1.0,
            inter: 0.0,
            v2: false,
        }
    }

    fn put(buf: &mut [u8], at: usize, bytes: &[u8]) {
        buf[at..at + bytes.len()].copy_from_slice(bytes);
    }

    fn header_bytes(s: &Spec) -> Vec<u8> {
        let n = if s.v2 { 540 } else { 348 };
        let mut b = vec![0u8; n];
        let i16b = |v: i16| if s.big { v.to_be_bytes() } else { v.to_le_bytes() };
        let i32b = |v: i32| if s.big { v.to_be_bytes() } else { v.to_le_bytes() };
        let i64b = |v: i64| if s.big { v.to_be_bytes() } else { v.to_le_bytes() };
        let f32b = |v: f64| if s.big { (v as f32).to_be_bytes() } else { (v as f32).to_le_bytes() };
        let f64b = |v: f64| if s.big { v.to_be_bytes() } else { v.to_le_bytes() };
        let ndim = if s.dims[3] > 1 { 4 } else { 3 };
        if s.v2 {
            put(&mut b, 0, &i32b(540));
            put(&mut b, 4, b"n+2\0\r\n\x1a\n");
            put(&mut b, 12, &i16b(s.datatype));
            put(&mut b, 16, &i64b(ndim));
            for (k, d) in s.dims.iter().enumerate() {
                put(&mut b, 24 + 8 * k, &i64b(*d as i64));
            }
            put(&mut b, 104, &f64b(1.0));
            for (k, p) in s.pixdim.iter().enumerate() {
                put(&mut b, 112 + 8 * k, &f64b(*p));
            }
            put(&mut b, 168, &i64b(544));
            put(&mut b, 176, &f64b(s.slope));
            put(&mut b, 184, &f64b(s.inter));
            put(&mut b, 240, b"a test image");
            if let Some(m) = &s.sform {
                put(&mut b, 348, &i32b(1));
                for (r, row) in m.iter().enumerate() {
                    for (c, v) in row.iter().enumerate() {
                        put(&mut b, 400 + (r * 4 + c) * 8, &f64b(*v));
                    }
                }
            }
            put(&mut b, 500, &i32b(2));
        } else {
            put(&mut b, 0, &i32b(348));
            put(&mut b, 40, &i16b(ndim as i16));
            for (k, d) in s.dims.iter().enumerate() {
                put(&mut b, 42 + 2 * k, &i16b(*d as i16));
            }
            put(&mut b, 70, &i16b(s.datatype));
            put(&mut b, 76, &f32b(1.0));
            for (k, p) in s.pixdim.iter().enumerate() {
                put(&mut b, 80 + 4 * k, &f32b(*p));
            }
            put(&mut b, 108, &f32b(352.0));
            put(&mut b, 112, &f32b(s.slope));
            put(&mut b, 116, &f32b(s.inter));
            b[123] = 2;
            put(&mut b, 148, b"a test image");
            if let Some(m) = &s.sform {
                put(&mut b, 254, &i16b(1));
                for (r, row) in m.iter().enumerate() {
                    for (c, v) in row.iter().enumerate() {
                        put(&mut b, 280 + (r * 4 + c) * 4, &f32b(*v));
                    }
                }
            }
            put(&mut b, 344, b"n+1\0");
        }
        b
    }

    fn file_bytes(s: &Spec, voxels: &[i64]) -> Vec<u8> {
        let mut b = header_bytes(s);
        b.resize(if s.v2 { 544 } else { 352 }, 0); // vox_offset
        for v in voxels {
            match s.datatype {
                2 => b.push(*v as u8),
                4 => b.extend_from_slice(&if s.big { (*v as i16).to_be_bytes() } else { (*v as i16).to_le_bytes() }),
                16 => b.extend_from_slice(&if s.big { (*v as f32).to_be_bytes() } else { (*v as f32).to_le_bytes() }),
                _ => panic!("datatype of the test"),
            }
        }
        b
    }

    fn write_file(name: &str, bytes: &[u8], gz: bool) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nifti_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        if gz {
            let mut e = GzEncoder::new(Vec::new(), Compression::fast());
            e.write_all(bytes).unwrap();
            std::fs::write(&path, e.finish().unwrap()).unwrap();
        } else {
            std::fs::write(&path, bytes).unwrap();
        }
        path
    }

    // ----- header -----

    #[test]
    fn a_nifti1_header_is_read_in_both_byte_orders() {
        for big in [false, true] {
            let mut s = spec([4, 3, 2, 1]);
            s.big = big;
            s.pixdim = [2.0, 2.5, 3.0];
            s.slope = 2.0;
            s.inter = -10.0;
            let h = parse_header(&header_bytes(&s)).unwrap();
            assert_eq!((h.version, h.big_endian), (1, big));
            assert_eq!(h.dims, [4, 3, 2]);
            assert_eq!(h.volumes, 1);
            assert_eq!((h.datatype, h.vox_offset), (4, 352));
            assert_eq!(h.pixdim[1..4], [2.0, 2.5, 3.0]);
            assert_eq!((h.slope, h.inter), (2.0, -10.0));
            assert_eq!(h.description, "a test image");
            assert!(h.placed);
        }
    }

    #[test]
    fn a_nifti2_header_is_read() {
        let mut s = spec([5, 6, 7, 1]);
        s.v2 = true;
        s.pixdim = [0.5, 0.5, 2.0];
        let h = parse_header(&header_bytes(&s)).unwrap();
        assert_eq!((h.version, h.dims, h.vox_offset), (2, [5, 6, 7], 544));
        assert_eq!(h.pixdim[1..4], [0.5, 0.5, 2.0]);
        assert_eq!(h.description, "a test image");
    }

    #[test]
    fn four_dimensions_and_bad_headers() {
        assert_eq!(parse_header(&header_bytes(&spec([4, 4, 4, 30]))).unwrap().volumes, 30);
        assert!(parse_header(&[]).is_err());
        assert!(parse_header(&[0; 400]).is_err());
        let mut b = header_bytes(&spec([4, 4, 4, 1]));
        b[344] = b'x'; // wrong magic
        assert!(parse_header(&b).is_err());
        let mut b = header_bytes(&spec([4, 4, 4, 1]));
        b[40] = 2; // two dimensions
        assert!(parse_header(&b).is_err());
        assert!(parse_header(&header_bytes(&spec([0, 4, 4, 1]))).is_err());
        assert!(parse_header(&header_bytes(&spec([4, 4, 4, 1]))[..200]).is_err()); // cut short
    }

    #[test]
    fn units_are_turned_into_millimetres() {
        let mut s = spec([2, 2, 2, 1]);
        s.sform = Some([[0.002, 0.0, 0.0, 0.1], [0.0, 0.002, 0.0, 0.0], [0.0, 0.0, 0.002, 0.0]]);
        let mut b = header_bytes(&s);
        b[123] = 1; // metres
        let h = parse_header(&b).unwrap();
        assert!((h.ras[0][0] - 2.0).abs() < 1e-6 && (h.ras[0][3] - 100.0).abs() < 1e-4);
    }

    #[test]
    fn a_qform_gives_the_same_matrix_as_an_equal_sform() {
        // A quarter turn about z: b = 0, c = 0, d = sin(45 degrees)
        let d = (0.5f64).sqrt();
        let m = from_quaternion(0.0, 0.0, d, [10.0, 20.0, 30.0], &[1.0, 2.0, 3.0, 4.0, 0.0, 0.0, 0.0, 0.0]);
        // Voxel x goes along +y, voxel y along -x, scaled by 2 and 3
        assert!((m[1][0] - 2.0).abs() < 1e-9 && (m[0][1] + 3.0).abs() < 1e-9);
        assert!((m[2][2] - 4.0).abs() < 1e-9);
        assert_eq!([m[0][3], m[1][3], m[2][3]], [10.0, 20.0, 30.0]);
        // qfac -1 reverses the third axis
        let r = from_quaternion(0.0, 0.0, 0.0, [0.0; 3], &[-1.0, 1.0, 1.0, 2.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(r[2][2], -2.0);
    }

    // ----- placement -----

    // The matrix of a file whose axes point to the given sides ("RAS", "LPI", "PIR", ...)
    fn matrix_of(code: &str, spacing: [f64; 3], origin: [f64; 3]) -> Mat34 {
        let mut m = [[0.0; 4]; 3];
        for (a, ch) in code.chars().enumerate() {
            let (w, sign) = match ch {
                'R' => (0, 1.0),
                'L' => (0, -1.0),
                'A' => (1, 1.0),
                'P' => (1, -1.0),
                'S' => (2, 1.0),
                _ => (2, -1.0),
            };
            m[w][a] = sign * spacing[a];
        }
        for w in 0..3 {
            m[w][3] = origin[w];
        }
        m
    }

    #[test]
    fn every_orientation_of_a_file_is_turned_into_the_same_patient() {
        let dims = [4usize, 5, 6];
        let spacing = [1.0, 2.0, 3.0];
        let origin = [-30.0, 12.0, 7.0];
        let codes: Vec<String> = {
            let sides = [["R", "L"], ["A", "P"], ["S", "I"]];
            let mut out = Vec::new();
            for perm in PERMUTATIONS {
                for signs in 0..8 {
                    out.push(
                        (0..3).map(|a| sides[perm[a]][(signs >> a) & 1]).collect::<Vec<_>>().concat(),
                    );
                }
            }
            out
        };
        assert_eq!(codes.len(), 48);

        for code in &codes {
            let ras = matrix_of(code, spacing, origin);
            assert_eq!(&orientation_code(&ras), code);
            let p = place(dims, &ras).unwrap();

            // The new axes point to the left, posterior and superior
            for (w, dir) in p.dirs.iter().enumerate() {
                assert!(dir[w] > 0.99, "{code}: axis {w} points {dir:?}");
            }
            assert_eq!(p.dims.iter().product::<usize>(), dims.iter().product::<usize>());

            // Each voxel keeps its value and its place in the patient
            let value = |i: usize, j: usize, k: usize| (i + 10 * j + 100 * k) as f32;
            let data: Vec<f32> = (0..dims[2])
                .flat_map(|k| (0..dims[1]).flat_map(move |j| (0..dims[0]).map(move |i| value(i, j, k))))
                .collect();
            let slices = reorient(&data, dims, &p);
            assert_eq!((slices.len(), slices[0].len()), (p.dims[2], p.dims[0] * p.dims[1]));
            for k in 0..p.dims[2] {
                for j in 0..p.dims[1] {
                    for i in 0..p.dims[0] {
                        let v = slices[k][j * p.dims[0] + i];
                        let (si, sj, sk) = ((v as usize) % 10, ((v as usize) / 10) % 10, (v as usize) / 100);
                        // Where the file puts that voxel (LPS)
                        let src = [
                            -(ras[0][0] * si as f64 + ras[0][1] * sj as f64 + ras[0][2] * sk as f64 + ras[0][3]),
                            -(ras[1][0] * si as f64 + ras[1][1] * sj as f64 + ras[1][2] * sk as f64 + ras[1][3]),
                            ras[2][0] * si as f64 + ras[2][1] * sj as f64 + ras[2][2] * sk as f64 + ras[2][3],
                        ];
                        let here = p.position(i, j, k);
                        for c in 0..3 {
                            assert!((src[c] - here[c]).abs() < 1e-9, "{code} voxel ({i},{j},{k}): {src:?} vs {here:?}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_tilted_file_keeps_its_directions() {
        // Voxel axes turned 20 degrees about z from RAS
        let t = 20f64.to_radians();
        let ras: Mat34 = [
            [t.cos(), -t.sin(), 0.0, 0.0],
            [t.sin(), t.cos(), 0.0, 0.0],
            [0.0, 0.0, 2.0, 0.0],
        ];
        let p = place([10, 10, 10], &ras).unwrap();
        let iop = p.iop();
        // Columns go mostly to the left, with a part towards posterior
        assert!(iop[0] > 0.9 && iop[0] < 1.0 && iop[1].abs() > 0.2);
        // The normal of the images is still the cross product of the two directions
        assert!((p.spacing[2] - 2.0).abs() < 1e-9);
    }

    #[test]
    fn a_file_without_voxel_size_is_refused() {
        let zero = [[0.0; 4]; 3];
        assert!(place([2, 2, 2], &zero).is_err());
    }

    // ----- voxels -----

    #[test]
    fn voxels_are_read_scaled_and_first_volume_only() {
        // 2 x 2 x 2 voxels, 3 volumes
        let mut s = spec([2, 2, 2, 3]);
        s.slope = 2.0;
        s.inter = 1.0;
        let voxels: Vec<i64> = (0..24).collect();
        for (name, gz) in [("a.nii", false), ("a.nii.gz", true)] {
            let path = write_file(name, &file_bytes(&s, &voxels), gz);
            let h = read_header(&path).unwrap();
            assert_eq!(h.volumes, 3);
            let v = read_voxels(&path, &h, 0).unwrap();
            assert_eq!(v.len(), 8);
            assert_eq!(v, (0..8).map(|n| n as f32 * 2.0 + 1.0).collect::<Vec<_>>());
        }
    }

    #[test]
    fn a_later_volume_of_a_4d_file_is_read() {
        // 2 x 2 x 1 voxels, 4 volumes: volume t holds 10 t + voxel number
        let mut s = spec([2, 2, 1, 4]);
        s.datatype = 4;
        let voxels: Vec<i64> = (0..4).flat_map(|t| (0..4).map(move |v| 10 * t + v)).collect();
        for (name, gz) in [("t.nii", false), ("t.nii.gz", true)] {
            let path = write_file(name, &file_bytes(&s, &voxels), gz);
            let h = read_header(&path).unwrap();
            assert_eq!(h.volumes, 4);
            for t in 0..4 {
                let v = read_voxels(&path, &h, t).unwrap();
                assert_eq!(v, (0..4).map(|n| (10 * t + n) as f32).collect::<Vec<_>>(), "volume {t} of {name}");
            }
            assert!(read_voxels(&path, &h, 4).unwrap_err().contains("4 volume"));
            assert_eq!(load(&path, 3).unwrap().volume, 3);
        }
        // A file that stops inside a later volume is refused, not shown half
        let path = write_file("cut.nii", &file_bytes(&s, &voxels[..10]), false);
        let h = read_header(&path).unwrap();
        assert!(read_voxels(&path, &h, 0).is_ok());
        assert!(read_voxels(&path, &h, 3).unwrap_err().contains("shorter"));
    }

    #[test]
    fn dimensions_beyond_the_fourth_count_as_volumes() {
        // A tensor-like file: 2 x 2 x 1 voxels, 4 x 3 volumes, and an intent
        let mut b = header_bytes(&spec([2, 2, 1, 4]));
        b[40..42].copy_from_slice(&5i16.to_le_bytes());
        b[50..52].copy_from_slice(&3i16.to_le_bytes());
        b[68..70].copy_from_slice(&1005i16.to_le_bytes());
        b[328..334].copy_from_slice(b"tensor");
        let h = parse_header(&b).unwrap();
        assert_eq!((h.volumes, h.extra_dims.clone()), (12, vec![4, 3]));
        assert_eq!((h.intent_code, h.intent_name.as_str()), (1005, "tensor"));
        // The plain cases keep their meaning
        let h = parse_header(&header_bytes(&spec([2, 2, 1, 1]))).unwrap();
        assert_eq!((h.volumes, h.extra_dims.len(), h.intent_code), (1, 0, 0));
        // 5D with a single time point: the 6 components are the volumes
        let mut b = header_bytes(&spec([2, 2, 1, 1]));
        b[40..42].copy_from_slice(&5i16.to_le_bytes());
        b[50..52].copy_from_slice(&6i16.to_le_bytes());
        assert_eq!(parse_header(&b).unwrap().volumes, 6);
        // NIfTI-2 keeps the intent at its own place
        let mut s = spec([2, 2, 1, 1]);
        s.v2 = true;
        let mut b = header_bytes(&s);
        b[504..508].copy_from_slice(&2003i32.to_le_bytes());
        assert_eq!(parse_header(&b).unwrap().intent_code, 2003);
    }

    #[test]
    fn one_voxel_through_all_volumes() {
        // 3 x 2 x 2 voxels, 4 volumes: volume t holds 100 t + voxel number
        let mut s = spec([3, 2, 2, 4]);
        s.datatype = 4;
        let voxels: Vec<i64> = (0..4).flat_map(|t| (0..12).map(move |v| 100 * t + v)).collect();
        for (name, gz) in [("s.nii", false), ("s.nii.gz", true)] {
            let path = write_file(name, &file_bytes(&s, &voxels), gz);
            let h = read_header(&path).unwrap();
            let raw = read_raw(&path, &h, 1 << 20).unwrap().unwrap();
            for voxel in [0, 5, 11] {
                let want: Vec<f32> = (0..4).map(|t| (100 * t + voxel) as f32).collect();
                assert_eq!(read_series(&path, &h, voxel).unwrap(), want, "{name} voxel {voxel}");
                assert_eq!(series_from_raw(&h, &raw, voxel).unwrap(), want);
            }
            assert!(read_series(&path, &h, 12).is_err());
            assert!(series_from_raw(&h, &raw, 12).is_err());
        }
    }

    #[test]
    fn a_position_on_screen_is_found_in_the_file() {
        // A file stored as LPS has its first and second axis reversed on the way to the screen
        for code in ["RAS", "LPS", "ASR", "RPI"] {
            let dims = [4usize, 3, 5];
            let m = matrix_of(code, [1.0, 1.0, 1.0], [0.0, 0.0, 0.0]);
            let p = place(dims, &m).unwrap();
            let data: Vec<f32> = (0..60).map(|v| v as f32).collect();
            let slices = reorient(&data, dims, &p);
            for image in 0..p.dims[2] {
                for row in 0..p.dims[1] {
                    for col in 0..p.dims[0] {
                        let v = file_voxel(dims, &p, col, row, image).unwrap();
                        assert_eq!(data[v], slices[image][row * p.dims[0] + col], "{code} {col},{row},{image}");
                    }
                }
            }
            assert!(file_voxel(dims, &p, p.dims[0], 0, 0).is_none());
        }
    }

    #[test]
    fn b_values_and_directions_are_read() {
        assert_eq!(parse_bvals("0 1000 1000\n").unwrap(), vec![0.0, 1000.0, 1000.0]);
        assert_eq!(parse_bvals("0\n1000\n").unwrap(), vec![0.0, 1000.0]);
        assert!(parse_bvals("0 x").is_err());
        // FSL: three lines with a column per volume
        let v = parse_bvecs("0 1 0\n0 0 1\n0 0 0\n").unwrap();
        assert_eq!(v, vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
        // One line per volume
        let v = parse_bvecs("1 0 0\n0 1 0\n0 0 1\n0 0 0\n").unwrap();
        assert_eq!(v.len(), 4);
        assert!(parse_bvecs("1 0\n0 1\n").is_err());
        assert_eq!(sidecar(Path::new("/a/sub-01_dwi.nii.gz"), "bval"), PathBuf::from("/a/sub-01_dwi.bval"));
        assert_eq!(sidecar(Path::new("/a/dwi.NII"), "bvec"), PathBuf::from("/a/dwi.bvec"));
    }

    #[test]
    fn directions_are_given_in_patient_coordinates_whatever_the_storage() {
        // FSL's first axis points to the patient's left for a file stored RAS or LAS alike
        let b = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]];
        for code in ["RAS", "LAS"] {
            let m = matrix_of(code, [2.0, 2.0, 2.0], [0.0; 3]);
            let d = bvecs_to_patient(&b, &m);
            assert_eq!(d[0], [1.0, 0.0, 0.0], "{code}: left is +x in LPS");
            assert_eq!(d[3], [0.0; 3]);
        }
        // For LAS (nothing flipped) the second voxel axis is anterior: -y in LPS
        let las = matrix_of("LAS", [2.0, 2.0, 2.0], [0.0; 3]);
        assert_eq!(bvecs_to_patient(&b, &las)[1], [0.0, -1.0, 0.0]);
        assert_eq!(bvecs_to_patient(&b, &las)[2], [0.0, 0.0, 1.0]);
        // Directions come out as unit vectors
        let d = bvecs_to_patient(&[[3.0, 4.0, 0.0]], &las)[0];
        assert!((d.iter().map(|v| v * v).sum::<f64>() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn diffusion_files_next_to_the_image_are_used_when_they_fit() {
        let mut s = spec([2, 2, 1, 3]);
        s.datatype = 4;
        let path = write_file("dwi.nii.gz", &file_bytes(&s, &[0; 12]), true);
        let h = read_header(&path).unwrap();
        let dir = path.parent().unwrap();
        assert!(read_diffusion(&path, &h).is_none());
        std::fs::write(dir.join("dwi.bval"), "0 1000 1000\n").unwrap();
        std::fs::write(dir.join("dwi.bvec"), "0 1 0\n0 0 1\n0 0 0\n").unwrap();
        let d = read_diffusion(&path, &h).unwrap().unwrap();
        assert_eq!(d.bvals, vec![0.0, 1000.0, 1000.0]);
        assert_eq!(d.dirs.len(), 3);
        // Another number of volumes is reported, not guessed at
        std::fs::write(dir.join("dwi.bval"), "0 1000\n").unwrap();
        assert!(read_diffusion(&path, &h).unwrap().unwrap_err().contains("3 volumes"));
    }

    #[test]
    fn unzipped_bytes_give_the_same_volumes() {
        let mut s = spec([3, 2, 2, 5]);
        s.datatype = 16;
        let voxels: Vec<i64> = (0..60).map(|v| v * 3 - 40).collect();
        for (name, gz) in [("raw.nii", false), ("raw.nii.gz", true)] {
            let path = write_file(name, &file_bytes(&s, &voxels), gz);
            let h = read_header(&path).unwrap();
            let raw = read_raw(&path, &h, 1 << 20).unwrap().expect("fits");
            assert_eq!(raw.len(), 60 * 4);
            for t in 0..5 {
                let a = load(&path, t).unwrap();
                let b = load_from_raw(&h, &raw, t).unwrap();
                assert_eq!(a.slices, b.slices, "volume {t} of {name}");
                assert_eq!((a.min, a.max, a.volume), (b.min, b.max, b.volume));
            }
            assert!(load_from_raw(&h, &raw, 5).is_err());
            // Too big to keep: no bytes, and no error
            assert!(read_raw(&path, &h, 100).unwrap().is_none());
        }
    }

    #[test]
    fn other_data_types_and_byte_orders() {
        let mut s = spec([2, 2, 1, 1]);
        s.datatype = 16;
        s.big = true;
        let p = write_file("f.nii", &file_bytes(&s, &[-5, 0, 7, 100]), false);
        let h = read_header(&p).unwrap();
        assert_eq!(read_voxels(&p, &h, 0).unwrap(), vec![-5.0, 0.0, 7.0, 100.0]);
        s.datatype = 2;
        s.big = false;
        let p = write_file("u.nii", &file_bytes(&s, &[0, 200, 255, 1]), false);
        let h = read_header(&p).unwrap();
        assert_eq!(read_voxels(&p, &h, 0).unwrap(), vec![0.0, 200.0, 255.0, 1.0]);
        // NIfTI-2
        s.v2 = true;
        s.datatype = 4;
        let p = write_file("v2.nii", &file_bytes(&s, &[-1, 2, -3, 4]), false);
        let h = read_header(&p).unwrap();
        assert_eq!(read_voxels(&p, &h, 0).unwrap(), vec![-1.0, 2.0, -3.0, 4.0]);
    }

    #[test]
    fn a_file_that_is_too_short_or_of_an_unsupported_type_is_refused() {
        let s = spec([4, 4, 4, 1]);
        let p = write_file("short.nii", &file_bytes(&s, &[1, 2, 3]), false);
        let h = read_header(&p).unwrap();
        assert!(read_voxels(&p, &h, 0).unwrap_err().contains("shorter"));
        let mut rgb = spec([2, 2, 2, 1]);
        rgb.datatype = 128;
        let p = write_file("rgb.nii", &file_bytes(&rgb, &[]), false);
        let h = read_header(&p).unwrap();
        assert!(read_voxels(&p, &h, 0).unwrap_err().contains("RGB"));
    }

    #[test]
    fn a_whole_file_is_loaded_with_its_statistics() {
        let mut s = spec([3, 2, 2, 1]);
        s.sform = Some(matrix_of("LAS", [1.0, 1.0, 1.0], [0.0; 3]));
        let voxels: Vec<i64> = (0..12).collect();
        let p = write_file("whole.nii.gz", &file_bytes(&s, &voxels), true);
        let l = load(&p, 0).unwrap();
        assert_eq!(l.slices.len(), l.placement.dims[2]);
        assert_eq!((l.min, l.max), (0.0, 11.0));
        assert!(l.low >= 0.0 && l.high <= 11.0 && l.low < l.high);
    }

    // ----- names -----

    #[test]
    fn names_and_modality() {
        assert!(is_nifti(Path::new("/a/b/sub-01_T1w.nii.gz")));
        assert!(is_nifti(Path::new("x.NII")));
        assert!(!is_nifti(Path::new("x.dcm")));
        assert!(!is_nifti(Path::new("x.nii.json")));
        assert_eq!(stem(Path::new("/a/sub-01_T1w.nii.gz")), "sub-01_T1w");
        assert_eq!(stem(Path::new("brain.nii")), "brain");
        assert_eq!(modality(Path::new("/nonexistent/sub-01_T1w.nii.gz")), "MR");
        assert_eq!(modality(Path::new("/nonexistent/sub-01_task-x_bold.nii.gz")), "MR");
        assert_eq!(modality(Path::new("/nonexistent/scan.nii.gz")), "");
        // The sidecar wins over the name
        let p = write_file("sidecar_CT.nii.gz", b"", false);
        std::fs::write(p.with_file_name("sidecar_CT.json"), r#"{"Modality": "MR"}"#).unwrap();
        assert_eq!(modality(&p), "MR");
    }

    // Runs on real files, so only on request:
    //   NIFTI_SAMPLE=/path/file.nii.gz cargo test --release --lib real_nifti -- --ignored --nocapture
    // A folder works as well; every NIfTI file in it is tried.
    #[test]
    #[ignore]
    fn real_nifti() {
        let Ok(target) = std::env::var("NIFTI_SAMPLE") else {
            println!("Set NIFTI_SAMPLE to a NIfTI file or a folder");
            return;
        };
        let target = std::path::PathBuf::from(target);
        let mut files: Vec<std::path::PathBuf> = if target.is_dir() {
            std::fs::read_dir(&target).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| is_nifti(p)).collect()
        } else {
            vec![target]
        };
        files.sort();
        files.truncate(8);
        for path in files {
            let t = std::time::Instant::now();
            let h = read_header(&path).unwrap();
            let l = load(&path, 0).unwrap();
            let col = |m: &Mat34, a: usize| (m[0][a].powi(2) + m[1][a].powi(2) + m[2][a].powi(2)).sqrt();
            println!(
                "{}\n  NIfTI-{} {}, dims {:?} x {} volume(s), {}, qform {} sform {}, orientation {}",
                path.file_name().unwrap().to_string_lossy(), h.version, if h.big_endian { "big-endian" } else { "little-endian" },
                h.dims, h.volumes, datatype_name(h.datatype), h.qform_code, h.sform_code, orientation_code(&h.ras),
            );
            println!(
                "  pixdim {:?}, size of the voxel axes in the matrix {:.4} {:.4} {:.4}",
                &h.pixdim[1..4], col(&h.ras, 0), col(&h.ras, 1), col(&h.ras, 2),
            );
            println!(
                "  after turning: {:?} voxels, spacing {:.3} {:.3} {:.3}, first voxel {:.1} {:.1} {:.1}, values {:.1} .. {:.1} (2%..98%: {:.1} .. {:.1}), {:?}",
                l.placement.dims, l.placement.spacing[0], l.placement.spacing[1], l.placement.spacing[2],
                l.placement.origin[0], l.placement.origin[1], l.placement.origin[2], l.min, l.max, l.low, l.high, t.elapsed(),
            );
            println!("  modality {:?}, description {:?}", modality(&path), h.description);
            // The matrix and pixdim must agree when the file is positioned by an sform or a qform
            if h.placed {
                for a in 0..3 {
                    let (m, p) = (col(&h.ras, a), h.pixdim[a + 1].abs());
                    assert!((m - p).abs() / p.max(1e-9) < 0.02, "axis {a}: matrix {m} vs pixdim {p}");
                }
            }
            if h.volumes > 1 {
                // Later volumes need the ones before them to be read through (gzip)
                let mut means = Vec::new();
                for t in [0, h.volumes / 2, h.volumes - 1] {
                    let t0 = std::time::Instant::now();
                    let v = read_voxels(&path, &h, t).unwrap();
                    means.push(v.iter().map(|x| f64::from(*x)).sum::<f64>() / v.len() as f64);
                    println!("  volume {} of {}: mean {:.1}, read in {:?}", t + 1, h.volumes, means.last().unwrap(), t0.elapsed());
                }
                assert!(means[0] != means[1] || means[1] != means[2], "all volumes are the same");
                // Kept unzipped, switching is quick
                let t0 = std::time::Instant::now();
                if let Some(raw) = read_raw(&path, &h, 768 << 20).unwrap() {
                    println!("  all volumes unzipped once: {:.0} MB in {:?}", raw.len() as f64 / 1048576.0, t0.elapsed());
                    for t in [h.volumes - 1, 0, h.volumes / 2] {
                        let t1 = std::time::Instant::now();
                        let l = load_from_raw(&h, &raw, t).unwrap();
                        println!("  volume {} from the kept bytes: {:?} (max {})", t + 1, t1.elapsed(), l.max);
                    }
                }
            }
            assert!(l.max > l.min, "the volume is flat");
            assert!(l.slices.iter().flatten().all(|v| v.is_finite()));
        }
    }
}
