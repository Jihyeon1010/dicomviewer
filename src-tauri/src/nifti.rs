//! NIfTI-1 and NIfTI-2 volumes (.nii and .nii.gz): the header, the voxels and where they lie
//! in the patient. A volume is turned into the layout of an axial DICOM series: columns
//! towards the patient's left, rows towards posterior, images towards superior. Axes are
//! only swapped and reversed, so no voxel value is changed or interpolated.
//!
//! Patient coordinates here are LPS like those of DICOM (+x left, +y posterior, +z superior).
//! NIfTI stores RAS, which differs in the sign of x and y.
//!
//! Only the first volume of a 4D file is read. Everything that follows from the header is
//! plain arithmetic, so it can be tested without files.

use flate2::read::GzDecoder;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// Largest side of a volume that is accepted, against corrupt headers
const MAX_SIDE: usize = 16_384;
/// Voxels are held as 32-bit floats; same limit as for DICOM volumes
const MAX_BYTES: usize = 4 * 1024 * 1024 * 1024;

/// 3 x 4 matrix: a voxel index (i, j, k, 1) to millimetres
pub type Mat34 = [[f64; 4]; 3];

#[derive(Clone, Debug)]
pub struct Header {
    pub version: u8, // 1 or 2
    pub big_endian: bool,
    /// Voxels along x, y and z, and the number of volumes (1 when there is no 4th dimension)
    pub dims: [usize; 3],
    pub volumes: usize,
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
    let (dim_at, datatype_at, pixdim_at, offset_at, slope_at, inter_at, descrip_at, qform_at, sform_at, quat_at, srow_at, units_at) =
        if v2 {
            (16, 12, 104, 168, 176, 184, 240, 344, 348, 352, 400, 500)
        } else {
            (40, 70, 76, 108, 112, 116, 148, 252, 254, 256, 280, 123)
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
    let volumes = if ndim >= 4 { size_of(dim(4)?.max(1))? } else { 1 };

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
