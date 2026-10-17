//! Multiplanar reformatting of a stack of slices: the three orthogonal planes, slabs
//! (maximum, minimum and mean intensity projections) and resampling to square pixels.
//! Everything here works on plain slices of floats, so it can be tested without DICOM
//! files or Tauri.

use rayon::prelude::*;

/// Tallest reformatted image, in pixels
pub const MAX_HEIGHT: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plane {
    Axial,
    Coronal,
    Sagittal,
}

impl Plane {
    pub fn parse(s: &str) -> Result<Plane, String> {
        match s {
            "axial" => Ok(Plane::Axial),
            "coronal" => Ok(Plane::Coronal),
            "sagittal" => Ok(Plane::Sagittal),
            other => Err(format!("Unknown plane: {other}")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slab {
    Max,
    Min,
    Mean,
}

impl Slab {
    /// "none" means a single plane without any projection
    pub fn parse(s: &str) -> Result<Option<Slab>, String> {
        match s {
            "none" => Ok(None),
            "max" => Ok(Some(Slab::Max)),
            "min" => Ok(Some(Slab::Min)),
            "mean" => Ok(Some(Slab::Mean)),
            other => Err(format!("Unknown slab mode: {other}")),
        }
    }
}

/// Size and spacing of a volume. `z` holds the position of every image along the stack
/// direction in millimetres, ascending.
pub struct Geometry<'a> {
    pub cols: usize,
    pub rows: usize,
    pub sx: f64, // mm between columns
    pub sy: f64, // mm between rows
    pub z: &'a [f64],
}

impl Geometry<'_> {
    pub fn depth(&self) -> usize {
        self.z.len()
    }

    /// Number of positions a plane can scroll through
    pub fn count(&self, plane: Plane) -> usize {
        match plane {
            Plane::Axial => self.depth(),
            Plane::Coronal => self.rows,
            Plane::Sagittal => self.cols,
        }
    }
}

pub struct Reformatted {
    pub width: usize,
    pub height: usize,
    pub spacing_x: f64, // mm per output pixel, horizontally
    pub spacing_y: f64, // mm per output pixel, vertically
    pub data: Vec<f32>, // row-major
}

fn positive(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        v
    } else {
        1.0
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Position of every image along the stack direction in millimetres, ascending, starting
/// at 0. The flag is false when the numbers are only an assumed regular spacing, which is
/// the case when the direction or any position is missing or the images do not spread out.
pub fn stack_positions(
    ipps: &[Option<[f64; 3]>],
    normal: Option<[f64; 3]>,
    fallback_step: f64,
) -> (Vec<f64>, bool) {
    let step = positive(fallback_step);
    let regular = || (0..ipps.len()).map(|k| k as f64 * step).collect::<Vec<f64>>();

    let Some(n) = normal else {
        return (regular(), false);
    };
    let Some(pts) = ipps.iter().copied().collect::<Option<Vec<[f64; 3]>>>() else {
        return (regular(), false);
    };
    let Some(first) = pts.first() else {
        return (regular(), false);
    };

    let base = dot(*first, n);
    let z: Vec<f64> = pts.iter().map(|p| dot(*p, n) - base).collect();
    let ascending = z.windows(2).all(|w| w[1] >= w[0] - 1e-6);
    let extent = z[z.len() - 1] - z[0];
    if ascending && extent > 1e-3 {
        (z, true)
    } else {
        (regular(), false)
    }
}

// ---------- Slabs ----------

// Images inside a slab of `half` millimetres on each side of image `k0`
fn axial_range(z: &[f64], k0: usize, half: f64) -> (usize, usize) {
    let eps = 1e-6;
    let mut lo = k0;
    while lo > 0 && z[k0] - z[lo - 1] <= half + eps {
        lo -= 1;
    }
    let mut hi = k0;
    while hi + 1 < z.len() && z[hi + 1] - z[k0] <= half + eps {
        hi += 1;
    }
    (lo, hi)
}

// Whole voxels on each side of the centre that fit into `half` millimetres
fn half_voxels(half: f64, spacing: f64) -> usize {
    (half / spacing + 1e-9).floor() as usize
}

fn fold_into(acc: &mut [f32], src: &[f32], op: Slab) {
    match op {
        Slab::Max => acc.iter_mut().zip(src).for_each(|(a, &v)| *a = a.max(v)),
        Slab::Min => acc.iter_mut().zip(src).for_each(|(a, &v)| *a = a.min(v)),
        Slab::Mean => acc.iter_mut().zip(src).for_each(|(a, &v)| *a += v),
    }
}

fn divide(values: &mut [f32], n: usize) {
    let n = n as f32;
    values.iter_mut().for_each(|a| *a /= n);
}

// The images lo..=hi combined pixel by pixel
fn reduce_axial(slices: &[Vec<f32>], lo: usize, hi: usize, op: Slab) -> Vec<f32> {
    let mut out = slices[lo].clone();
    if hi > lo {
        const CHUNK: usize = 16384;
        out.par_chunks_mut(CHUNK).enumerate().for_each(|(ci, chunk)| {
            let start = ci * CHUNK;
            for s in &slices[lo + 1..=hi] {
                fold_into(chunk, &s[start..start + chunk.len()], op);
            }
        });
        if op == Slab::Mean {
            out.par_chunks_mut(CHUNK).for_each(|c| divide(c, hi - lo + 1));
        }
    }
    out
}

// Rows lo..=hi of every image combined: one output row per image, `cols` values wide
fn reduce_coronal(slices: &[Vec<f32>], cols: usize, lo: usize, hi: usize, op: Slab) -> Vec<f32> {
    let mut out = vec![0f32; slices.len() * cols];
    out.par_chunks_mut(cols).zip(slices.par_iter()).for_each(|(row, s)| {
        row.copy_from_slice(&s[lo * cols..(lo + 1) * cols]);
        for r in lo + 1..=hi {
            fold_into(row, &s[r * cols..(r + 1) * cols], op);
        }
        if op == Slab::Mean && hi > lo {
            divide(row, hi - lo + 1);
        }
    });
    out
}

// Columns lo..=hi of every image combined: one output row per image, `rows` values wide
fn reduce_sagittal(
    slices: &[Vec<f32>],
    cols: usize,
    rows: usize,
    lo: usize,
    hi: usize,
    op: Slab,
) -> Vec<f32> {
    let mut out = vec![0f32; slices.len() * rows];
    out.par_chunks_mut(rows).zip(slices.par_iter()).for_each(|(row, s)| {
        for (r, o) in row.iter_mut().enumerate() {
            let seg = &s[r * cols + lo..=r * cols + hi];
            *o = match op {
                Slab::Max => seg.iter().copied().fold(f32::MIN, f32::max),
                Slab::Min => seg.iter().copied().fold(f32::MAX, f32::min),
                Slab::Mean => seg.iter().sum::<f32>() / seg.len() as f32,
            };
        }
    });
    out
}

// ---------- Resampling along the stack ----------

// value = row[k] * (1 - t) + row[k + 1] * t
#[derive(Clone, Copy, Debug, PartialEq)]
struct ZSample {
    k: usize,
    t: f32,
}

// Where the rows of an image with square pixels of `p` millimetres fall between the
// stored images. Row j sits at z[0] + j * p, so the first and last row are image centres.
fn z_table(z: &[f64], p: f64) -> Result<Vec<ZSample>, String> {
    let depth = z.len();
    if depth < 2 {
        return Ok(vec![ZSample { k: 0, t: 0.0 }]);
    }
    let height = ((z[depth - 1] - z[0]) / p + 1e-9).floor() as usize + 1;
    if height > MAX_HEIGHT {
        return Err(format!(
            "The reformatted image would be {height} pixels tall (the limit is {MAX_HEIGHT})"
        ));
    }

    let mut out = Vec::with_capacity(height);
    let mut k = 0usize;
    for j in 0..height {
        let pos = z[0] + j as f64 * p;
        // Keep z[k] <= pos <= z[k + 1], stepping over empty intervals
        while k + 2 < depth && z[k + 1] <= pos {
            k += 1;
        }
        let span = z[k + 1] - z[k];
        let t = if span > 1e-9 {
            ((pos - z[k]) / span).clamp(0.0, 1.0)
        } else {
            0.0
        };
        out.push(ZSample { k, t: t as f32 });
    }
    Ok(out)
}

// `native` has one row of `width` values per stored image; the result has square pixels
fn resample_z(native: &[f32], width: usize, z: &[f64], p: f64) -> Result<(usize, Vec<f32>), String> {
    let table = z_table(z, p)?;
    let depth = z.len();
    let mut data = vec![0f32; table.len() * width];
    data.par_chunks_mut(width).zip(table.par_iter()).for_each(|(row, s)| {
        let k1 = (s.k + 1).min(depth - 1);
        let a = &native[s.k * width..(s.k + 1) * width];
        let b = &native[k1 * width..(k1 + 1) * width];
        for ((o, &x), &y) in row.iter_mut().zip(a).zip(b) {
            *o = x + (y - x) * s.t;
        }
    });
    Ok((table.len(), data))
}

// ---------- Reformatting ----------

/// One plane through the volume. `index` is the image number for the axial plane, the row
/// for the coronal plane and the column for the sagittal plane. With a slab mode the
/// plane becomes a projection through `thickness_mm`, centred on `index`.
///
/// The coronal and sagittal images show the images top to bottom in stack order and have
/// square pixels of `sx` (coronal) or `sy` (sagittal) millimetres.
pub fn reformat(
    slices: &[Vec<f32>],
    g: &Geometry,
    plane: Plane,
    index: usize,
    slab: Option<Slab>,
    thickness_mm: f64,
) -> Result<Reformatted, String> {
    let depth = g.depth();
    if depth == 0 || g.cols == 0 || g.rows == 0 || slices.len() != depth {
        return Err("Inconsistent volume".into());
    }
    let len = g.cols * g.rows;
    if slices.iter().any(|s| s.len() != len) {
        return Err("Inconsistent volume".into());
    }
    if index >= g.count(plane) {
        return Err(format!("Position {index} is outside the volume"));
    }

    let (sx, sy) = (positive(g.sx), positive(g.sy));
    let op = slab.unwrap_or(Slab::Max);
    let half = if slab.is_some() {
        thickness_mm.max(0.0) / 2.0
    } else {
        0.0
    };

    match plane {
        Plane::Axial => {
            let (lo, hi) = axial_range(g.z, index, half);
            Ok(Reformatted {
                width: g.cols,
                height: g.rows,
                spacing_x: sx,
                spacing_y: sy,
                data: reduce_axial(slices, lo, hi, op),
            })
        }
        Plane::Coronal => {
            let n = half_voxels(half, sy);
            let lo = index.saturating_sub(n);
            let hi = index.saturating_add(n).min(g.rows - 1);
            let native = reduce_coronal(slices, g.cols, lo, hi, op);
            let (height, data) = resample_z(&native, g.cols, g.z, sx)?;
            Ok(Reformatted {
                width: g.cols,
                height,
                spacing_x: sx,
                spacing_y: sx,
                data,
            })
        }
        Plane::Sagittal => {
            let n = half_voxels(half, sx);
            let lo = index.saturating_sub(n);
            let hi = index.saturating_add(n).min(g.cols - 1);
            let native = reduce_sagittal(slices, g.cols, g.rows, lo, hi, op);
            let (height, data) = resample_z(&native, g.rows, g.z, sy)?;
            Ok(Reformatted {
                width: g.rows,
                height,
                spacing_x: sy,
                spacing_y: sy,
                data,
            })
        }
    }
}

// ---------- 16-bit transport ----------

/// Float values are sent as unsigned 16-bit samples: value = raw * slope + intercept.
pub struct Encoding {
    pub slope: f64,
    pub intercept: f64,
}

/// Ranges of 1000 to 65535 keep a step of 1, so CT numbers stay exact; other ranges are
/// scaled to use all 65536 levels.
pub fn encoding_for(vmin: f64, vmax: f64) -> Encoding {
    let range = vmax - vmin;
    let slope = if (1000.0..=65535.0).contains(&range) {
        1.0
    } else {
        (range / 65535.0).max(1e-9)
    };
    Encoding {
        slope,
        intercept: vmin,
    }
}

pub fn encode(data: &[f32], e: &Encoding) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 2);
    for &v in data {
        let raw = ((f64::from(v) - e.intercept) / e.slope)
            .round()
            .clamp(0.0, 65535.0) as u16;
        out.extend_from_slice(&raw.to_le_bytes());
    }
    out
}

// ---------- Oblique planes and rays ----------

/// Largest side of an oblique image in pixels, and largest number of pixels
pub const MAX_OBLIQUE_SIDE: usize = 2048;
pub const MAX_OBLIQUE_PIXELS: usize = 4_194_304;

/// An image that samples the volume on a plane through `origin`, spanned by the unit
/// vectors `u` (image x) and `v` (image y), in the local millimetre coordinates of the
/// volume: x = column * sx, y = row * sy, z = position of the image. With a slab mode
/// each pixel combines samples along the normal u x v, through `thickness_mm`.
pub struct Oblique {
    pub origin: [f64; 3], // the point in the middle of the image
    pub u: [f64; 3],
    pub v: [f64; 3],
    pub width: usize,
    pub height: usize,
    pub pixel_mm: f64,
    pub slab: Option<Slab>,
    pub thickness_mm: f64,
    pub ray_step_mm: f64,
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

// Index pair and weight for linear interpolation along an axis of `n` samples
fn axis(f: f64, n: usize) -> (usize, usize, f32) {
    if n < 2 {
        return (0, 0, 0.0);
    }
    let i0 = (f.floor().max(0.0) as usize).min(n - 2);
    let t = (f - i0 as f64).clamp(0.0, 1.0) as f32;
    (i0, i0 + 1, t)
}

struct Sampler<'a> {
    slices: &'a [Vec<f32>],
    cols: usize,
    rows: usize,
    sx: f64,
    sy: f64,
    z: &'a [f64],
    dz: Option<f64>, // spacing when the images are evenly spaced
}

impl<'a> Sampler<'a> {
    fn new(slices: &'a [Vec<f32>], g: &'a Geometry) -> Self {
        let depth = g.z.len();
        let dz = if depth >= 2 {
            let step = (g.z[depth - 1] - g.z[0]) / (depth as f64 - 1.0);
            let even = step > 1e-9
                && g.z
                    .iter()
                    .enumerate()
                    .all(|(k, &z)| (z - g.z[0] - k as f64 * step).abs() <= 1e-3 * step);
            if even {
                Some(step)
            } else {
                None
            }
        } else {
            None
        };
        Sampler {
            slices,
            cols: g.cols,
            rows: g.rows,
            sx: positive(g.sx),
            sy: positive(g.sy),
            z: g.z,
            dz,
        }
    }

    fn locate(&self, zv: f64) -> (usize, usize, f32) {
        let depth = self.z.len();
        if depth < 2 {
            return (0, 0, 0.0);
        }
        if let Some(dz) = self.dz {
            return axis((zv - self.z[0]) / dz, depth);
        }
        let k = self
            .z
            .partition_point(|&q| q <= zv)
            .saturating_sub(1)
            .min(depth - 2);
        let span = self.z[k + 1] - self.z[k];
        let t = if span > 1e-12 {
            ((zv - self.z[k]) / span).clamp(0.0, 1.0) as f32
        } else {
            0.0
        };
        (k, k + 1, t)
    }

    // Trilinear interpolation; the point is expected to lie inside the volume
    fn at(&self, x: f64, y: f64, zv: f64) -> f32 {
        let (x0, x1, tx) = axis(x / self.sx, self.cols);
        let (y0, y1, ty) = axis(y / self.sy, self.rows);
        let (k0, k1, tz) = self.locate(zv);
        let plane = |k: usize| -> f32 {
            let s = &self.slices[k];
            let a = s[y0 * self.cols + x0];
            let b = s[y0 * self.cols + x1];
            let c = s[y1 * self.cols + x0];
            let d = s[y1 * self.cols + x1];
            let top = a + (b - a) * tx;
            let bottom = c + (d - c) * tx;
            top + (bottom - top) * ty
        };
        let p0 = plane(k0);
        if k1 == k0 || tz == 0.0 {
            p0
        } else {
            p0 + (plane(k1) - p0) * tz
        }
    }
}

// Part of the ray pt + t * n, t in [-half, half], that lies inside the box
fn clip(
    pt: [f64; 3],
    n: [f64; 3],
    lo: [f64; 3],
    hi: [f64; 3],
    half: f64,
) -> Option<(f64, f64)> {
    let (mut t0, mut t1) = (-half, half);
    for a in 0..3 {
        if n[a].abs() < 1e-12 {
            if pt[a] < lo[a] - 1e-9 || pt[a] > hi[a] + 1e-9 {
                return None;
            }
        } else {
            let mut ta = (lo[a] - pt[a]) / n[a];
            let mut tb = (hi[a] - pt[a]) / n[a];
            if ta > tb {
                std::mem::swap(&mut ta, &mut tb);
            }
            t0 = t0.max(ta);
            t1 = t1.min(tb);
        }
    }
    if t0 <= t1 + 1e-9 {
        Some((t0, t1.max(t0)))
    } else {
        None
    }
}

/// Samples the volume on an oblique plane, or projects along its normal. Pixels whose
/// ray misses the volume get `background`.
pub fn reformat_oblique(
    slices: &[Vec<f32>],
    g: &Geometry,
    o: &Oblique,
    background: f32,
) -> Result<Reformatted, String> {
    let depth = g.depth();
    if depth == 0 || g.cols == 0 || g.rows == 0 || slices.len() != depth {
        return Err("Inconsistent volume".into());
    }
    if slices.iter().any(|s| s.len() != g.cols * g.rows) {
        return Err("Inconsistent volume".into());
    }
    let (w, h) = (o.width, o.height);
    if w == 0 || h == 0 || w > MAX_OBLIQUE_SIDE || h > MAX_OBLIQUE_SIDE || w * h > MAX_OBLIQUE_PIXELS
    {
        return Err("Unsupported image size".into());
    }
    if !(o.pixel_mm.is_finite() && o.pixel_mm > 0.0) {
        return Err("Invalid pixel size".into());
    }
    let finite = o.origin.iter().chain(&o.u).chain(&o.v).all(|x| x.is_finite());
    let nv = cross3(o.u, o.v);
    let nl = dot(nv, nv).sqrt();
    if !finite || nl < 1e-6 {
        return Err("Invalid plane".into());
    }
    let n = [nv[0] / nl, nv[1] / nl, nv[2] / nl];

    let sampler = Sampler::new(slices, g);
    let lo = [0.0, 0.0, g.z[0]];
    let hi = [
        (g.cols - 1) as f64 * positive(g.sx),
        (g.rows - 1) as f64 * positive(g.sy),
        g.z[depth - 1],
    ];
    let half = if o.slab.is_some() {
        o.thickness_mm.max(0.0) / 2.0
    } else {
        0.0
    };
    let op = o.slab.unwrap_or(Slab::Max);
    let (hw, hh) = (w as f64 / 2.0, h as f64 / 2.0);
    let p = o.pixel_mm;

    let mut data = vec![0f32; w * h];
    data.par_chunks_mut(w).enumerate().for_each(|(j, row)| {
        let b = (j as f64 + 0.5 - hh) * p;
        for (i, out) in row.iter_mut().enumerate() {
            let a = (i as f64 + 0.5 - hw) * p;
            let pt = [
                o.origin[0] + a * o.u[0] + b * o.v[0],
                o.origin[1] + a * o.u[1] + b * o.v[1],
                o.origin[2] + a * o.u[2] + b * o.v[2],
            ];
            *out = match clip(pt, n, lo, hi, half) {
                None => background,
                Some((t0, t1)) => {
                    let at = |t: f64| {
                        sampler.at(pt[0] + t * n[0], pt[1] + t * n[1], pt[2] + t * n[2])
                    };
                    if o.slab.is_none() {
                        at(t0)
                    } else {
                        let step = o.ray_step_mm.max((t1 - t0) / 4096.0).max(1e-3);
                        let count = ((t1 - t0) / step + 1e-9).floor() as usize + 1;
                        let mut acc = match op {
                            Slab::Max => f32::MIN,
                            Slab::Min => f32::MAX,
                            Slab::Mean => 0.0,
                        };
                        for m in 0..count {
                            let v = at(t0 + m as f64 * step);
                            acc = match op {
                                Slab::Max => acc.max(v),
                                Slab::Min => acc.min(v),
                                Slab::Mean => acc + v,
                            };
                        }
                        if op == Slab::Mean {
                            acc / count as f32
                        } else {
                            acc
                        }
                    }
                }
            };
        }
    });

    Ok(Reformatted {
        width: w,
        height: h,
        spacing_x: p,
        spacing_y: p,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLS: usize = 4;
    const ROWS: usize = 3;
    const DEPTH: usize = 5;

    // Every voxel holds a number that tells where it came from: 100 * image + 10 * row + column
    fn volume() -> Vec<Vec<f32>> {
        (0..DEPTH)
            .map(|k| {
                (0..ROWS * COLS)
                    .map(|n| (100 * k + 10 * (n / COLS) + n % COLS) as f32)
                    .collect()
            })
            .collect()
    }

    fn geo(z: &[f64]) -> Geometry<'_> {
        Geometry {
            cols: COLS,
            rows: ROWS,
            sx: 1.0,
            sy: 1.0,
            z,
        }
    }

    const Z: [f64; DEPTH] = [0.0, 1.0, 2.0, 3.0, 4.0];

    #[test]
    fn axial_plane_is_the_stored_image() {
        let v = volume();
        let out = reformat(&v, &geo(&Z), Plane::Axial, 2, None, 0.0).unwrap();
        assert_eq!((out.width, out.height), (COLS, ROWS));
        for n in 0..ROWS * COLS {
            assert_eq!(out.data[n], (200 + 10 * (n / COLS) + n % COLS) as f32);
        }
    }

    #[test]
    fn coronal_plane_collects_one_row_of_every_image() {
        let v = volume();
        let out = reformat(&v, &geo(&Z), Plane::Coronal, 1, None, 0.0).unwrap();
        assert_eq!((out.width, out.height), (COLS, DEPTH));
        for j in 0..DEPTH {
            for i in 0..COLS {
                assert_eq!(out.data[j * COLS + i], (100 * j + 10 + i) as f32);
            }
        }
    }

    #[test]
    fn sagittal_plane_collects_one_column_of_every_image() {
        let v = volume();
        let out = reformat(&v, &geo(&Z), Plane::Sagittal, 2, None, 0.0).unwrap();
        assert_eq!((out.width, out.height), (ROWS, DEPTH));
        for j in 0..DEPTH {
            for r in 0..ROWS {
                assert_eq!(out.data[j * ROWS + r], (100 * j + 10 * r + 2) as f32);
            }
        }
    }

    #[test]
    fn coarse_slices_are_interpolated_to_square_pixels() {
        // Images 2 mm apart, pixels 1 mm wide: the image gets twice as many rows
        let z = [0.0, 2.0, 4.0, 6.0, 8.0];
        let v = volume();
        let out = reformat(&v, &geo(&z), Plane::Coronal, 0, None, 0.0).unwrap();
        assert_eq!((out.width, out.height), (COLS, 9));
        assert_eq!((out.spacing_x, out.spacing_y), (1.0, 1.0));
        for j in 0..9 {
            for i in 0..COLS {
                assert_eq!(out.data[j * COLS + i], 50.0 * j as f32 + i as f32);
            }
        }
    }

    #[test]
    fn max_projection_covers_all_rows() {
        let v = volume();
        let out = reformat(&v, &geo(&Z), Plane::Coronal, 1, Some(Slab::Max), 1.0e6).unwrap();
        for j in 0..DEPTH {
            for i in 0..COLS {
                assert_eq!(out.data[j * COLS + i], (100 * j + 20 + i) as f32);
            }
        }
    }

    #[test]
    fn min_projection_covers_all_rows() {
        let v = volume();
        let out = reformat(&v, &geo(&Z), Plane::Coronal, 1, Some(Slab::Min), 1.0e6).unwrap();
        for j in 0..DEPTH {
            for i in 0..COLS {
                assert_eq!(out.data[j * COLS + i], (100 * j + i) as f32);
            }
        }
    }

    #[test]
    fn mean_projection_averages_rows() {
        let v = volume();
        let out = reformat(&v, &geo(&Z), Plane::Coronal, 1, Some(Slab::Mean), 1.0e6).unwrap();
        for j in 0..DEPTH {
            for i in 0..COLS {
                assert_eq!(out.data[j * COLS + i], (100 * j + 10 + i) as f32);
            }
        }
    }

    #[test]
    fn slab_thickness_selects_neighbouring_rows() {
        let v = volume();
        // 2 mm = one row on each side of row 0: rows 0 and 1 are combined
        let slab = reformat(&v, &geo(&Z), Plane::Coronal, 0, Some(Slab::Max), 2.0).unwrap();
        assert_eq!(slab.data[0], 10.0);
        // Without a slab mode the thickness is ignored
        let thin = reformat(&v, &geo(&Z), Plane::Coronal, 0, None, 2.0).unwrap();
        assert_eq!(thin.data[0], 0.0);
    }

    #[test]
    fn axial_slab_follows_positions_not_counts() {
        let z = [0.0, 1.0, 2.0, 10.0, 11.0];
        let v = volume();
        // Images 0..=2 lie within 1 mm of image 1; the maximum is image 2
        let out = reformat(&v, &geo(&z), Plane::Axial, 1, Some(Slab::Max), 2.0).unwrap();
        assert_eq!(out.data[0], 200.0);
        // Too thin to reach a neighbour
        let thin = reformat(&v, &geo(&z), Plane::Axial, 1, Some(Slab::Max), 0.5).unwrap();
        assert_eq!(thin.data[0], 100.0);
    }

    #[test]
    fn axial_projection_through_everything() {
        let v = volume();
        let max = reformat(&v, &geo(&Z), Plane::Axial, 0, Some(Slab::Max), 1.0e6).unwrap();
        assert_eq!(max.data[0], 400.0);
        let min = reformat(&v, &geo(&Z), Plane::Axial, 4, Some(Slab::Min), 1.0e6).unwrap();
        assert_eq!(min.data[0], 0.0);
        let mean = reformat(&v, &geo(&Z), Plane::Axial, 2, Some(Slab::Mean), 1.0e6).unwrap();
        assert_eq!(mean.data[0], 200.0);
    }

    #[test]
    fn positions_outside_the_volume_are_rejected() {
        let v = volume();
        assert!(reformat(&v, &geo(&Z), Plane::Coronal, ROWS, None, 0.0).is_err());
        assert!(reformat(&v, &geo(&Z), Plane::Sagittal, COLS, None, 0.0).is_err());
        assert!(reformat(&v, &geo(&Z), Plane::Axial, DEPTH, None, 0.0).is_err());
    }

    #[test]
    fn inconsistent_volume_is_rejected() {
        let mut v = volume();
        v.pop();
        assert!(reformat(&v, &geo(&Z), Plane::Axial, 0, None, 0.0).is_err());
    }

    #[test]
    fn uneven_spacing_is_resampled_by_position() {
        let t = z_table(&[0.0, 1.0, 3.0], 1.0).unwrap();
        assert_eq!(t.len(), 4);
        assert_eq!(t[0], ZSample { k: 0, t: 0.0 });
        assert_eq!(t[1], ZSample { k: 1, t: 0.0 });
        assert_eq!(t[2], ZSample { k: 1, t: 0.5 });
        assert_eq!(t[3], ZSample { k: 1, t: 1.0 });
    }

    #[test]
    fn too_tall_images_are_refused() {
        assert!(z_table(&[0.0, 10_000.0], 1.0).is_err());
    }

    #[test]
    fn stack_positions_follow_the_normal() {
        // Axial stack stored from the head down: the normal points to the feet
        let ipps = [
            Some([0.0, 0.0, 10.0]),
            Some([0.0, 0.0, 5.0]),
            Some([0.0, 0.0, 0.0]),
        ];
        let (z, real) = stack_positions(&ipps, Some([0.0, 0.0, -1.0]), 1.0);
        assert!(real);
        assert_eq!(z, vec![0.0, 5.0, 10.0]);
    }

    #[test]
    fn stack_positions_fall_back_when_data_is_missing() {
        let n = Some([0.0, 0.0, -1.0]);
        let a = Some([0.0, 0.0, 0.0]);
        let b = Some([0.0, 0.0, -5.0]);
        // No direction
        assert_eq!(stack_positions(&[a, b], None, 2.0), (vec![0.0, 2.0], false));
        // A missing position
        assert_eq!(stack_positions(&[a, None], n, 2.0), (vec![0.0, 2.0], false));
        // Images at the same place
        assert_eq!(stack_positions(&[a, a], n, 3.0), (vec![0.0, 3.0], false));
        // Positions in descending order
        assert_eq!(stack_positions(&[b, a], n, 2.0), (vec![0.0, 2.0], false));
        // The assumed spacing itself must be sensible
        assert_eq!(stack_positions(&[a, a], n, 0.0), (vec![0.0, 1.0], false));
    }

    #[test]
    fn ct_values_are_encoded_exactly() {
        let e = encoding_for(-1024.0, 3071.0);
        assert_eq!((e.slope, e.intercept), (1.0, -1024.0));
        let bytes = encode(&[-1024.0, 0.0, 3071.0], &e);
        let raw: Vec<u16> = bytes
            .chunks(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        assert_eq!(raw, vec![0, 1024, 4095]);
    }

    #[test]
    fn other_ranges_are_scaled_to_fit() {
        let raw = |v: f32, e: &Encoding| {
            let bytes = encode(&[v], e);
            u16::from_le_bytes([bytes[0], bytes[1]])
        };
        let small = encoding_for(0.0, 1.0);
        assert!((small.slope - 1.0 / 65535.0).abs() < 1e-12);
        assert_eq!(raw(1.0, &small), 65535);
        let big = encoding_for(0.0, 131_070.0);
        assert!((big.slope - 2.0).abs() < 1e-12);
        assert_eq!(raw(131_070.0, &big), 65535);
        // A flat volume must not divide by zero
        let flat = encoding_for(5.0, 5.0);
        assert_eq!(raw(5.0, &flat), 0);
    }

    #[test]
    fn names_are_parsed() {
        assert_eq!(Plane::parse("coronal"), Ok(Plane::Coronal));
        assert!(Plane::parse("oblique").is_err());
        assert_eq!(Slab::parse("none"), Ok(None));
        assert_eq!(Slab::parse("mean"), Ok(Some(Slab::Mean)));
        assert!(Slab::parse("sum").is_err());
    }
}

#[cfg(test)]
mod oblique_tests {
    use super::*;

    const COLS: usize = 4;
    const ROWS: usize = 3;
    const DEPTH: usize = 5;
    const Z: [f64; DEPTH] = [0.0, 1.0, 2.0, 3.0, 4.0];

    // value = x + 10 y + 100 z, so trilinear interpolation reproduces it exactly
    fn linear() -> Vec<Vec<f32>> {
        (0..DEPTH)
            .map(|k| {
                (0..ROWS * COLS)
                    .map(|n| (n % COLS) as f32 + 10.0 * (n / COLS) as f32 + 100.0 * k as f32)
                    .collect()
            })
            .collect()
    }

    fn geo() -> Geometry<'static> {
        Geometry { cols: COLS, rows: ROWS, sx: 1.0, sy: 1.0, z: &Z }
    }

    #[allow(clippy::too_many_arguments)]
    fn plane(
        origin: [f64; 3],
        u: [f64; 3],
        v: [f64; 3],
        width: usize,
        height: usize,
        slab: Option<Slab>,
        thickness_mm: f64,
    ) -> Oblique {
        Oblique {
            origin,
            u,
            v,
            width,
            height,
            pixel_mm: 1.0,
            slab,
            thickness_mm,
            ray_step_mm: 1.0,
        }
    }

    const X: [f64; 3] = [1.0, 0.0, 0.0];
    const Y: [f64; 3] = [0.0, 1.0, 0.0];
    const ZAX: [f64; 3] = [0.0, 0.0, 1.0];

    #[test]
    fn axis_aligned_plane_matches_the_stored_values() {
        let v = linear();
        let o = plane([1.5, 1.0, 2.0], X, Y, 4, 3, None, 0.0);
        let r = reformat_oblique(&v, &geo(), &o, -999.0).unwrap();
        for j in 0..3 {
            for i in 0..4 {
                assert!((r.data[j * 4 + i] - (i as f32 + 10.0 * j as f32 + 200.0)).abs() < 1e-3);
            }
        }
    }

    #[test]
    fn pixels_outside_the_volume_get_the_background() {
        let v = linear();
        let o = plane([1.5, 1.0, 2.0], X, Y, 8, 3, None, 0.0);
        let r = reformat_oblique(&v, &geo(), &o, -999.0).unwrap();
        // Pixel 0 lies at x = -2, pixel 2 at x = 0
        assert_eq!(r.data[0], -999.0);
        assert!((r.data[2] - 200.0).abs() < 1e-3);
    }

    #[test]
    fn rotated_plane_interpolates_linearly() {
        let v = linear();
        let (c, s) = (30f64.to_radians().cos(), 30f64.to_radians().sin());
        let o = plane([1.5, 1.0, 2.0], [c, s, 0.0], [-s, c, 0.0], 4, 3, None, 0.0);
        let r = reformat_oblique(&v, &geo(), &o, -999.0).unwrap();
        // Pixel (2, 1) lies half a pixel along u from the origin
        let (x, y) = (1.5 + 0.5 * c, 1.0 + 0.5 * s);
        let expected = (x + 10.0 * y + 200.0) as f32;
        assert!((r.data[4 + 2] - expected).abs() < 1e-3, "got {}", r.data[4 + 2]);
    }

    #[test]
    fn slab_projections_along_the_normal() {
        let v = linear();
        // Normal along z; the ray at x = y = 0 passes the values 0, 100, ... 400
        let at = |slab| {
            let o = plane([1.5, 1.0, 2.0], X, Y, 4, 3, Some(slab), 4.0);
            reformat_oblique(&v, &geo(), &o, -999.0).unwrap().data[0]
        };
        assert!((at(Slab::Max) - 400.0).abs() < 1e-3);
        assert!(at(Slab::Min).abs() < 1e-3);
        assert!((at(Slab::Mean) - 200.0).abs() < 1e-3);
    }

    #[test]
    fn projection_through_the_side_of_the_volume() {
        let v = linear();
        // u = y, v = z, so the normal is x; rays are clipped to the box
        let o = plane([1.5, 1.0, 2.0], Y, ZAX, 3, 5, Some(Slab::Max), 10.0);
        let r = reformat_oblique(&v, &geo(), &o, -999.0).unwrap();
        for j in 0..5 {
            for i in 0..3 {
                let expected = 3.0 + 10.0 * i as f32 + 100.0 * j as f32;
                assert!((r.data[j * 3 + i] - expected).abs() < 1e-3);
            }
        }
    }

    #[test]
    fn invalid_requests_are_rejected() {
        let v = linear();
        let ok = || plane([1.5, 1.0, 2.0], X, Y, 4, 3, None, 0.0);
        assert!(reformat_oblique(&v, &geo(), &Oblique { width: 0, ..ok() }, 0.0).is_err());
        assert!(reformat_oblique(&v, &geo(), &Oblique { pixel_mm: 0.0, ..ok() }, 0.0).is_err());
        assert!(reformat_oblique(&v, &geo(), &Oblique { v: X, ..ok() }, 0.0).is_err());
    }
}