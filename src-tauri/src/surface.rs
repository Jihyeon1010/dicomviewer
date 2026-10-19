//! Triangle meshes of the surface where a volume crosses a threshold (naive surface nets).
//! Each cell of the grid that the surface passes through gets one vertex, and every grid edge
//! that crosses the surface becomes a quad between the four cells around it. The meshes are
//! closed (the volume is padded with empty space) and wound counter-clockwise seen from
//! outside. Like `mpr`, everything here works on plain slices, so it can be tested without
//! DICOM files or Tauri.

use crate::mpr::Geometry;
use rayon::prelude::*;

/// Most voxels of the grid that is processed; larger volumes are sampled more coarsely.
pub const MAX_VOXELS: usize = 96_000_000;

/// Triangle mesh in the local millimetre coordinates of the volume.
pub struct Mesh {
    pub positions: Vec<f32>, // x, y, z per vertex
    pub normals: Vec<f32>,   // unit vectors, one per vertex
    pub indices: Vec<u32>,   // three per triangle
}

impl Mesh {
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }
}

/// Which parts of the thresholded volume become a surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    All,
    /// The connected part with the most voxels
    Largest,
    /// The connected part at a voxel (column, row, image), or the nearest one
    At { i: usize, j: usize, k: usize },
}

pub struct Params {
    pub threshold: f32,
    /// Voxels above this value are left out as well (bone next to contrast-filled vessels)
    pub max: Option<f32>,
    /// Voxels this close to the ones above `max` are left out too, which cuts the shell of
    /// in-between values that surrounds a bright structure
    pub margin: usize,
    /// Rounds of smoothing of the mesh (0 for none)
    pub smooth: usize,
    pub part: Part,
    /// Take every n-th voxel along each axis (1 for all of them)
    pub step: usize,
    pub max_triangles: usize,
}

fn grid_dims(g: &Geometry, step: usize) -> (usize, usize, usize) {
    (
        (g.cols - 1) / step + 1,
        (g.rows - 1) / step + 1,
        (g.depth() - 1) / step + 1,
    )
}

/// Smallest step for which the grid has at most `max_voxels` voxels.
pub fn auto_step(g: &Geometry, max_voxels: usize) -> usize {
    let mut step = 1;
    loop {
        let (x, y, z) = grid_dims(g, step);
        if x * y * z <= max_voxels || step >= g.cols.max(g.rows).max(g.depth()) {
            return step;
        }
        step += 1;
    }
}

// Visits the 6-connected foreground voxels reachable from `start` and returns how many
fn flood(fg: &[u8], seen: &mut [u8], start: usize, dims: (usize, usize, usize)) -> usize {
    let (nx, ny, nz) = dims;
    let plane = nx * ny;
    let mut stack = vec![start as u32];
    seen[start] = 1;
    let mut count = 0;
    while let Some(c) = stack.pop() {
        count += 1;
        let c = c as usize;
        let (i, j, k) = (c % nx, (c / nx) % ny, c / plane);
        let mut visit = |d: usize| {
            if fg[d] != 0 && seen[d] == 0 {
                seen[d] = 1;
                stack.push(d as u32);
            }
        };
        if i > 0 {
            visit(c - 1);
        }
        if i + 1 < nx {
            visit(c + 1);
        }
        if j > 0 {
            visit(c - nx);
        }
        if j + 1 < ny {
            visit(c + nx);
        }
        if k > 0 {
            visit(c - plane);
        }
        if k + 1 < nz {
            visit(c + plane);
        }
    }
    count
}

// The foreground voxel nearest to (i, j, k) within a few voxels
fn nearest_foreground(
    fg: &[u8],
    dims: (usize, usize, usize),
    at: (usize, usize, usize),
) -> Option<usize> {
    const REACH: isize = 6;
    let (nx, ny, nz) = dims;
    let mut best: Option<(isize, usize)> = None;
    for dk in -REACH..=REACH {
        for dj in -REACH..=REACH {
            for di in -REACH..=REACH {
                let (i, j, k) = (at.0 as isize + di, at.1 as isize + dj, at.2 as isize + dk);
                if i < 0 || j < 0 || k < 0 || i >= nx as isize || j >= ny as isize || k >= nz as isize
                {
                    continue;
                }
                let idx = (k as usize * ny + j as usize) * nx + i as usize;
                let dist = di * di + dj * dj + dk * dk;
                if fg[idx] != 0 && best.is_none_or(|(d, _)| dist < d) {
                    best = Some((dist, idx));
                }
            }
        }
    }
    best.map(|(_, idx)| idx)
}

const NONE: u32 = u32::MAX;

// Two triangles for the quad of four cell vertices, facing the other way when `flip`
fn push_quad(indices: &mut Vec<u32>, q: [u32; 4], flip: bool) {
    if q.contains(&NONE) {
        return;
    }
    let q = if flip { [q[0], q[3], q[2], q[1]] } else { q };
    indices.extend_from_slice(&[q[0], q[1], q[2], q[0], q[2], q[3]]);
}

/// The surface of the region `value >= threshold`.
pub fn extract(slices: &[Vec<f32>], g: &Geometry, p: &Params) -> Result<Mesh, String> {
    let depth = g.depth();
    if depth < 2 || g.cols < 2 || g.rows < 2 || slices.len() != depth {
        return Err("Inconsistent volume".into());
    }
    if slices.iter().any(|s| s.len() != g.cols * g.rows) {
        return Err("Inconsistent volume".into());
    }
    if !p.threshold.is_finite() || p.max.is_some_and(|m| !m.is_finite()) {
        return Err("Invalid threshold".into());
    }
    if p.max.is_some_and(|m| m <= p.threshold) {
        return Err("The maximum must be above the threshold".into());
    }
    let step = p.step.max(1);
    let (nx, ny, nz) = grid_dims(g, step);
    if nz < 2 || nx < 2 || ny < 2 {
        return Err("The surface step is too coarse for this volume".into());
    }
    let cols = g.cols;
    let thr = p.threshold;
    let n = nx * ny * nz;

    // Foreground: voxels at or above the threshold (and not above the maximum)
    let top = p.max.unwrap_or(f32::INFINITY);
    let mut fg = vec![0u8; n];
    let mut bright = vec![0u8; if p.max.is_some() && p.margin > 0 { n } else { 0 }];
    fg.par_chunks_mut(nx * ny).enumerate().for_each(|(k, plane)| {
        let s = &slices[(k * step).min(depth - 1)];
        for j in 0..ny {
            for i in 0..nx {
                let v = s[j * step * cols + i * step];
                plane[j * nx + i] = u8::from(v >= thr && v <= top);
            }
        }
    });
    let dims = (nx, ny, nz);
    if !bright.is_empty() {
        bright.par_chunks_mut(nx * ny).enumerate().for_each(|(k, plane)| {
            let s = &slices[(k * step).min(depth - 1)];
            for j in 0..ny {
                for i in 0..nx {
                    plane[j * nx + i] = u8::from(s[j * step * cols + i * step] > top);
                }
            }
        });
        dilate(&mut bright, dims, p.margin);
        fg.par_iter_mut().zip(bright.par_iter()).for_each(|(f, &b)| {
            if b != 0 {
                *f = 0;
            }
        });
        drop(bright);
    }
    if !fg.iter().any(|&f| f != 0) {
        return Err("No voxel reaches the threshold".into());
    }

    let keep: Vec<u8> = match p.part {
        Part::All => fg,
        Part::Largest => {
            let mut seen = vec![0u8; n];
            let mut best = (0usize, 0usize);
            for idx in 0..n {
                if fg[idx] != 0 && seen[idx] == 0 {
                    let size = flood(&fg, &mut seen, idx, dims);
                    if size > best.0 {
                        best = (size, idx);
                    }
                }
            }
            seen.fill(0);
            flood(&fg, &mut seen, best.1, dims);
            seen
        }
        Part::At { i, j, k } => {
            let at = ((i / step).min(nx - 1), (j / step).min(ny - 1), (k / step).min(nz - 1));
            let start = nearest_foreground(&fg, dims, at)
                .ok_or("Nothing reaches the threshold at the crosshair")?;
            let mut seen = vec![0u8; n];
            let size = flood(&fg, &mut seen, start, dims);
            // A region that fills much of the volume has leaked into something else
            if size * 5 > n * 2 {
                return Err(
                    "The region grows into more than 40% of the volume: raise the threshold or set a maximum"
                        .into(),
                );
            }
            seen
        }
    };

    // Coordinates: grid index -> millimetres. Beyond the ends the spacing continues.
    let zs: Vec<f64> = (0..nz).map(|k| g.z[(k * step).min(depth - 1)]).collect();
    let (sx, sy) = (g.sx * step as f64, g.sy * step as f64);
    let to_mm = |f: [f64; 3]| -> [f32; 3] {
        let z = if f[2] <= 0.0 {
            zs[0] + f[2] * (zs[1] - zs[0])
        } else if f[2] >= (nz - 1) as f64 {
            zs[nz - 1] + (f[2] - (nz - 1) as f64) * (zs[nz - 1] - zs[nz - 2])
        } else {
            let k = f[2].floor() as usize;
            zs[k] + (f[2] - k as f64) * (zs[k + 1] - zs[k])
        };
        [(f[0] * sx) as f32, (f[1] * sy) as f32, z as f32]
    };

    let in_range = |i: isize, j: isize, k: isize| {
        i >= 0 && j >= 0 && k >= 0 && (i as usize) < nx && (j as usize) < ny && (k as usize) < nz
    };
    // Outside the grid is empty space
    let inside = |i: isize, j: isize, k: isize| {
        in_range(i, j, k) && keep[(k as usize * ny + j as usize) * nx + i as usize] != 0
    };
    let value = |i: isize, j: isize, k: isize| -> f32 {
        slices[(k as usize * step).min(depth - 1)][j as usize * step * cols + i as usize * step]
    };

    // Where along the edge a -> b the surface lies, as a fraction
    let crossing = |a: [isize; 3], b: [isize; 3]| -> f64 {
        if !in_range(a[0], a[1], a[2]) || !in_range(b[0], b[1], b[2]) {
            return 0.5; // the padding has no value of its own
        }
        let (va, vb) = (
            f64::from(value(a[0], a[1], a[2])),
            f64::from(value(b[0], b[1], b[2])),
        );
        // A voxel left out for being too bright or too close to one is not a crossing of
        // the threshold: put the surface half way
        let t_in = f64::from(thr);
        if (va >= t_in) == (vb >= t_in) {
            return 0.5;
        }
        let t = (f64::from(thr) - va) / (vb - va);
        if t.is_finite() {
            t.clamp(0.01, 0.99)
        } else {
            0.5
        }
    };

    let corner = |ci: isize, cj: isize, ck: isize, c: usize| -> [isize; 3] {
        [ci + (c & 1) as isize, cj + ((c >> 1) & 1) as isize, ck + ((c >> 2) & 1) as isize]
    };
    // Vertex of a cell: the mean of the points where the surface crosses its edges
    let cell_vertex = |ci: isize, cj: isize, ck: isize| -> Option<[f32; 3]> {
        let mut flags = [false; 8];
        for (c, f) in flags.iter_mut().enumerate() {
            let q = corner(ci, cj, ck, c);
            *f = inside(q[0], q[1], q[2]);
        }
        if flags.iter().all(|&f| f) || !flags.iter().any(|&f| f) {
            return None;
        }
        let mut sum = [0.0f64; 3];
        let mut count = 0.0;
        for c in 0..8 {
            for bit in 0..3 {
                if c & (1 << bit) != 0 {
                    continue;
                }
                let d = c | (1 << bit);
                if flags[c] == flags[d] {
                    continue;
                }
                let (a, b) = (corner(ci, cj, ck, c), corner(ci, cj, ck, d));
                let t = crossing(a, b);
                for axis in 0..3 {
                    sum[axis] += a[axis] as f64 + t * (b[axis] - a[axis]) as f64;
                }
                count += 1.0;
            }
        }
        Some(to_mm([sum[0] / count, sum[1] / count, sum[2] / count]))
    };

    let w = nx + 1;
    let id = |ci: isize, cj: isize| (ci + 1) as usize + (cj + 1) as usize * w;
    let mut prev = vec![NONE; w * (ny + 1)];
    let mut cur = vec![NONE; w * (ny + 1)];
    let mut positions: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let (nxi, nyi, nzi) = (nx as isize, ny as isize, nz as isize);


    // Cells are visited layer by layer; a layer needs the one before it for the quads
    // around edges that run in x and y
    for k in -1..nzi {
        cur.fill(NONE);
        for cj in -1..nyi {
            for ci in -1..nxi {
                if let Some(v) = cell_vertex(ci, cj, k) {
                    cur[id(ci, cj)] = (positions.len() / 3) as u32;
                    positions.extend_from_slice(&v);
                }
            }
        }

        if k >= 0 {
            // Edges along x
            for j in 0..nyi {
                for i in -1..nxi {
                    let a = inside(i, j, k);
                    if a != inside(i + 1, j, k) {
                        let q = [prev[id(i, j - 1)], prev[id(i, j)], cur[id(i, j)], cur[id(i, j - 1)]];
                        push_quad(&mut indices, q, !a);
                    }
                }
            }
            // Edges along y
            for j in -1..nyi {
                for i in 0..nxi {
                    let a = inside(i, j, k);
                    if a != inside(i, j + 1, k) {
                        let q = [prev[id(i - 1, j)], cur[id(i - 1, j)], cur[id(i, j)], prev[id(i, j)]];
                        push_quad(&mut indices, q, !a);
                    }
                }
            }
        }
        // Edges along z, from this layer to the next
        for j in 0..nyi {
            for i in 0..nxi {
                let a = inside(i, j, k);
                if a != inside(i, j, k + 1) {
                    let q = [cur[id(i - 1, j - 1)], cur[id(i, j - 1)], cur[id(i, j)], cur[id(i - 1, j)]];
                    push_quad(&mut indices, q, !a);
                }
            }
        }

        if indices.len() / 3 > p.max_triangles {
            return Err(format!(
                "The surface has more than {} triangles; use a coarser detail or another threshold",
                p.max_triangles
            ));
        }
        std::mem::swap(&mut prev, &mut cur);
    }

    if p.smooth > 0 {
        smooth_mesh(&mut positions, &indices, p.smooth);
    }
    let normals = vertex_normals(&positions, &indices);
    Ok(Mesh {
        positions,
        normals,
        indices,
    })
}

// Grows a mask by `times` voxels in every direction (a 3 x 3 x 3 box, one axis at a time)
fn dilate(mask: &mut [u8], dims: (usize, usize, usize), times: usize) {
    let (nx, ny, nz) = dims;
    let plane = nx * ny;
    let mut tmp = vec![0u8; mask.len()];
    for _ in 0..times {
        // x
        tmp.par_chunks_mut(plane).zip(mask.par_chunks(plane)).for_each(|(d, s)| {
            for j in 0..ny {
                let row = &s[j * nx..(j + 1) * nx];
                for i in 0..nx {
                    let lo = row[i.saturating_sub(1)];
                    let hi = row[(i + 1).min(nx - 1)];
                    d[j * nx + i] = row[i] | lo | hi;
                }
            }
        });
        // y
        mask.par_chunks_mut(plane).zip(tmp.par_chunks(plane)).for_each(|(d, s)| {
            for j in 0..ny {
                let (a, b) = (j.saturating_sub(1), (j + 1).min(ny - 1));
                for i in 0..nx {
                    d[j * nx + i] = s[j * nx + i] | s[a * nx + i] | s[b * nx + i];
                }
            }
        });
        // z
        let src: &[u8] = &*mask;
        tmp.par_chunks_mut(plane).enumerate().for_each(|(k, d)| {
            let (a, b) = (k.saturating_sub(1), (k + 1).min(nz - 1));
            for i in 0..plane {
                d[i] = src[k * plane + i] | src[a * plane + i] | src[b * plane + i];
            }
        });
        mask.copy_from_slice(&tmp);
    }
}

// Taubin smoothing: a step towards the mean of the neighbours, then a slightly longer step
// back, so the surface loses its roughness without shrinking.
fn smooth_mesh(positions: &mut [f32], indices: &[u32], rounds: usize) {
    let nv = positions.len() / 3;
    let mut offsets = vec![0u32; nv + 1];
    for t in indices.chunks_exact(3) {
        for &v in t {
            offsets[v as usize + 1] += 2; // two neighbours per corner
        }
    }
    for v in 0..nv {
        offsets[v + 1] += offsets[v];
    }
    let mut fill = offsets.clone();
    let mut adj = vec![0u32; offsets[nv] as usize];
    for t in indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            adj[fill[a as usize] as usize] = b;
            fill[a as usize] += 1;
            adj[fill[b as usize] as usize] = a;
            fill[b as usize] += 1;
        }
    }
    drop(fill);

    // Each edge belongs to two triangles, so every neighbour is listed twice; the mean is not
    // affected by that
    let step = |src: &[f32], dst: &mut [f32], factor: f32| {
        dst.par_chunks_mut(3).enumerate().for_each(|(v, out)| {
            let (a, b) = (offsets[v] as usize, offsets[v + 1] as usize);
            let p = [src[v * 3], src[v * 3 + 1], src[v * 3 + 2]];
            if a == b {
                out.copy_from_slice(&p);
                return;
            }
            let mut sum = [0.0f32; 3];
            for &w in &adj[a..b] {
                let o = w as usize * 3;
                sum[0] += src[o];
                sum[1] += src[o + 1];
                sum[2] += src[o + 2];
            }
            let k = 1.0 / (b - a) as f32;
            for c in 0..3 {
                out[c] = p[c] + factor * (sum[c] * k - p[c]);
            }
        });
    };
    let mut tmp = positions.to_vec();
    for _ in 0..rounds {
        step(positions, &mut tmp, 0.5);
        step(&tmp, positions, -0.53);
    }
}

// Area-weighted average of the normals of the triangles around each vertex
fn vertex_normals(positions: &[f32], indices: &[u32]) -> Vec<f32> {
    let mut acc = vec![0.0f32; positions.len()];
    let at = |v: u32| -> [f32; 3] {
        let o = v as usize * 3;
        [positions[o], positions[o + 1], positions[o + 2]]
    };
    for t in indices.chunks_exact(3) {
        let (a, b, c) = (at(t[0]), at(t[1]), at(t[2]));
        let (u, v) = (
            [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        );
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        for &vi in t {
            let o = vi as usize * 3;
            acc[o] += n[0];
            acc[o + 1] += n[1];
            acc[o + 2] += n[2];
        }
    }
    for n in acc.chunks_exact_mut(3) {
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len > 1e-12 {
            n.iter_mut().for_each(|x| *x /= len);
        } else {
            n.copy_from_slice(&[0.0, 0.0, 1.0]);
        }
    }
    acc
}

/// Binary STL of the mesh. `transform` maps every vertex first (rotation into patient axes).
pub fn stl_bytes(mesh: &Mesh, transform: impl Fn([f32; 3]) -> [f32; 3]) -> Vec<u8> {
    let tris = mesh.triangle_count();
    let mut out = Vec::with_capacity(84 + tris * 50);
    let mut header = [0u8; 80];
    let text = b"Binary STL, millimetres";
    header[..text.len()].copy_from_slice(text);
    out.extend_from_slice(&header);
    out.extend_from_slice(&(tris as u32).to_le_bytes());
    let at = |v: u32| -> [f32; 3] {
        let o = v as usize * 3;
        transform([mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]])
    };
    for t in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (at(t[0]), at(t[1]), at(t[2]));
        let (u, v) = (
            [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        );
        let mut n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len > 1e-20 {
            n.iter_mut().for_each(|x| *x /= len);
        }
        for f in n.iter().chain(&a).chain(&b).chain(&c) {
            out.extend_from_slice(&f.to_le_bytes());
        }
        out.extend_from_slice(&0u16.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn geo(n: usize, depth: usize, z: &[f64]) -> Geometry<'_> {
        assert_eq!(z.len(), depth);
        Geometry { cols: n, rows: n, sx: 1.0, sy: 1.0, z }
    }

    // value 1 inside the balls (centre, radius), 0 elsewhere
    fn balls(n: usize, depth: usize, zstep: f64, list: &[([f64; 3], f64)]) -> Vec<Vec<f32>> {
        (0..depth)
            .map(|k| {
                let mut s = vec![0f32; n * n];
                for j in 0..n {
                    for i in 0..n {
                        let p = [i as f64, j as f64, k as f64 * zstep];
                        if list.iter().any(|(c, r)| {
                            ((p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) + (p[2] - c[2]).powi(2))
                                .sqrt()
                                <= *r
                        }) {
                            s[j * n + i] = 1.0;
                        }
                    }
                }
                s
            })
            .collect()
    }

    fn params(part: Part, step: usize) -> Params {
        Params { threshold: 0.5, max: None, margin: 0, smooth: 0, part, step, max_triangles: 10_000_000 }
    }

    fn zs(depth: usize, step: f64) -> Vec<f64> {
        (0..depth).map(|k| k as f64 * step).collect()
    }

    // Every edge is used once in each direction: closed and consistently wound
    fn assert_closed(m: &Mesh) {
        let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
        for t in m.indices.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *edges.entry((a, b)).or_default() += 1;
            }
        }
        for (&(a, b), &c) in &edges {
            assert_eq!(c, 1, "edge {a}->{b} used {c} times in the same direction");
            assert!(edges.contains_key(&(b, a)), "edge {a}->{b} has no partner");
        }
    }

    fn signed_volume(m: &Mesh) -> f64 {
        let p = |v: u32| -> [f64; 3] {
            let o = v as usize * 3;
            [m.positions[o] as f64, m.positions[o + 1] as f64, m.positions[o + 2] as f64]
        };
        m.indices
            .chunks_exact(3)
            .map(|t| {
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0]))
                    / 6.0
            })
            .sum()
    }

    #[test]
    fn sphere_is_a_closed_outward_surface() {
        let z = zs(24, 1.0);
        let v = balls(24, 24, 1.0, &[([11.5, 11.5, 11.5], 7.0)]);
        let m = extract(&v, &geo(24, 24, &z), &params(Part::All, 1)).unwrap();
        assert_closed(&m);
        let expected = 4.0 / 3.0 * std::f64::consts::PI * 343.0;
        let vol = signed_volume(&m);
        assert!((vol - expected).abs() / expected < 0.1, "volume {vol}, expected {expected}");
        // Normals point away from the centre
        let outward = (0..m.vertex_count())
            .filter(|&i| {
                let o = i * 3;
                let d = [m.positions[o] - 11.5, m.positions[o + 1] - 11.5, m.positions[o + 2] - 11.5];
                d[0] * m.normals[o] + d[1] * m.normals[o + 1] + d[2] * m.normals[o + 2] > 0.0
            })
            .count();
        assert_eq!(outward, m.vertex_count());
    }

    #[test]
    fn a_volume_filled_to_the_edge_is_capped() {
        let z = zs(6, 1.0);
        let v = vec![vec![1.0f32; 36]; 6];
        let m = extract(&v, &geo(6, 6, &z), &params(Part::All, 1)).unwrap();
        assert_closed(&m);
        assert!(m.triangle_count() > 0);
    }

    #[test]
    fn largest_part_and_part_at_a_voxel() {
        let z = zs(30, 1.0);
        let v = balls(30, 30, 1.0, &[([8.0, 15.0, 15.0], 6.0), ([24.0, 15.0, 15.0], 3.0)]);
        let g = geo(30, 30, &z);
        let max_x = |m: &Mesh| m.positions.chunks_exact(3).map(|p| p[0]).fold(f32::MIN, f32::max);
        let min_x = |m: &Mesh| m.positions.chunks_exact(3).map(|p| p[0]).fold(f32::MAX, f32::min);

        let all = extract(&v, &g, &params(Part::All, 1)).unwrap();
        assert!(max_x(&all) > 25.0 && min_x(&all) < 4.0);
        let big = extract(&v, &g, &params(Part::Largest, 1)).unwrap();
        assert!(max_x(&big) < 16.0);
        assert_closed(&big);
        let small = extract(&v, &g, &params(Part::At { i: 24, j: 15, k: 15 }, 1)).unwrap();
        assert!(min_x(&small) > 18.0);
        assert!(small.triangle_count() < big.triangle_count());
        // A seed in empty space snaps to a part that is close, and fails when none is
        let near = extract(&v, &g, &params(Part::At { i: 29, j: 15, k: 15 }, 1)).unwrap();
        assert!(min_x(&near) > 18.0);
        assert!(extract(&v, &g, &params(Part::At { i: 15, j: 0, k: 0 }, 1)).is_err());
    }

    #[test]
    fn uneven_image_positions_are_respected() {
        let z: Vec<f64> = (0..20).map(|k| k as f64 * 1.5 + if k > 10 { 2.0 } else { 0.0 }).collect();
        let v: Vec<Vec<f32>> = (0..20)
            .map(|k| (0..400).map(|n| if (5..15).contains(&(n % 20)) && (5..15).contains(&(n / 20)) && (4..16).contains(&k) { 1.0 } else { 0.0 }).collect())
            .collect();
        let m = extract(&v, &geo(20, 20, &z), &params(Part::All, 1)).unwrap();
        assert_closed(&m);
        let (lo, hi) = m
            .positions
            .chunks_exact(3)
            .fold((f32::MAX, f32::MIN), |(l, h), p| (l.min(p[2]), h.max(p[2])));
        // The block spans images 4 to 15; the surface lies half a cell beyond them
        assert!((lo as f64 - (z[4] - 0.5 * (z[4] - z[3]))).abs() < 0.2, "lo {lo}");
        assert!((hi as f64 - (z[15] + 0.5 * (z[16] - z[15]))).abs() < 0.2, "hi {hi}");
    }

    #[test]
    fn coarser_steps_make_smaller_meshes() {
        let z = zs(33, 1.0);
        let v = balls(33, 33, 1.0, &[([16.0, 16.0, 16.0], 12.0)]);
        let g = geo(33, 33, &z);
        let fine = extract(&v, &g, &params(Part::All, 1)).unwrap();
        let coarse = extract(&v, &g, &params(Part::All, 2)).unwrap();
        assert!(coarse.triangle_count() * 2 < fine.triangle_count());
        assert_closed(&coarse);
        assert_eq!(auto_step(&g, 33 * 33 * 33), 1);
        assert!(auto_step(&g, 20_000) > 1);
    }

    #[test]
    fn errors_are_reported() {
        let z = zs(6, 1.0);
        let v = vec![vec![0.0f32; 36]; 6];
        let g = geo(6, 6, &z);
        assert!(extract(&v, &g, &params(Part::All, 1)).is_err()); // nothing above the threshold
        let ball = balls(24, 24, 1.0, &[([11.5, 11.5, 11.5], 7.0)]);
        let z24 = zs(24, 1.0);
        let tiny = Params { max_triangles: 10, ..params(Part::All, 1) };
        assert!(extract(&ball, &geo(24, 24, &z24), &tiny).is_err());
    }

    #[test]
    fn stl_has_the_binary_layout() {
        let z = zs(24, 1.0);
        let v = balls(24, 24, 1.0, &[([11.5, 11.5, 11.5], 5.0)]);
        let m = extract(&v, &geo(24, 24, &z), &params(Part::All, 1)).unwrap();
        let stl = stl_bytes(&m, |p| [p[0] * 2.0, p[1], p[2]]);
        assert_eq!(stl.len(), 84 + 50 * m.triangle_count());
        assert_eq!(u32::from_le_bytes([stl[80], stl[81], stl[82], stl[83]]) as usize, m.triangle_count());
        // First vertex of the first triangle is the transformed first vertex of the mesh
        let a = m.indices[0] as usize * 3;
        let x = f32::from_le_bytes([stl[96], stl[97], stl[98], stl[99]]);
        assert!((x - m.positions[a] * 2.0).abs() < 1e-6);
    }

    #[test]
    fn smoothing_rounds_the_surface_without_shrinking_it() {
        let z = zs(40, 1.0);
        let v = balls(40, 40, 1.0, &[([19.5, 19.5, 19.5], 12.0)]);
        let g = geo(40, 40, &z);
        let rough = extract(&v, &g, &params(Part::All, 1)).unwrap();
        let smooth = extract(&v, &g, &Params { smooth: 20, ..params(Part::All, 1) }).unwrap();
        assert_eq!(rough.indices, smooth.indices); // same connectivity
        assert_closed(&smooth);
        let spread = |m: &Mesh| {
            let r: Vec<f64> = m
                .positions
                .chunks_exact(3)
                .map(|p| {
                    ((p[0] as f64 - 19.5).powi(2)
                        + (p[1] as f64 - 19.5).powi(2)
                        + (p[2] as f64 - 19.5).powi(2))
                    .sqrt()
                })
                .collect();
            let mean = r.iter().sum::<f64>() / r.len() as f64;
            (r.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / r.len() as f64).sqrt()
        };
        assert!(spread(&smooth) < spread(&rough) * 0.6, "{} vs {}", spread(&smooth), spread(&rough));
        let (v0, v1) = (signed_volume(&rough), signed_volume(&smooth));
        assert!((v1 - v0).abs() / v0 < 0.05, "volume {v0} -> {v1}");
        // Normals still point outwards
        let outward = (0..smooth.vertex_count())
            .filter(|&i| {
                let o = i * 3;
                let d = [smooth.positions[o] - 19.5, smooth.positions[o + 1] - 19.5, smooth.positions[o + 2] - 19.5];
                d[0] * smooth.normals[o] + d[1] * smooth.normals[o + 1] + d[2] * smooth.normals[o + 2] > 0.0
            })
            .count();
        assert_eq!(outward, smooth.vertex_count());
    }

    // A vessel (300) that runs into a block of bone (1000) wrapped in a shell of in-between
    // values (450), the way partial volume makes it look in a CT
    fn vessel_and_bone() -> Vec<Vec<f32>> {
        (0..40)
            .map(|k| {
                let mut s = vec![0f32; 40 * 40];
                for j in 0..40 {
                    for i in 0..40 {
                        let in_bone = (26..=34).contains(&i) && (6..=14).contains(&j) && (6..=14).contains(&k);
                        let in_shell = (25..=35).contains(&i) && (5..=15).contains(&j) && (5..=15).contains(&k);
                        let in_tube = i <= 25 && ((j as f32 - 10.0).powi(2) + (k as f32 - 10.0).powi(2)).sqrt() <= 1.6;
                        s[j * 40 + i] = if in_bone { 1000.0 } else if in_shell { 450.0 } else if in_tube { 300.0 } else { 0.0 };
                    }
                }
                s
            })
            .collect()
    }

    #[test]
    fn a_maximum_and_a_margin_keep_bone_out_of_the_vessel() {
        let z = zs(40, 1.0);
        let v = vessel_and_bone();
        let g = geo(40, 40, &z);
        let at = Part::At { i: 5, j: 10, k: 10 };
        let reach = |m: &Mesh| m.positions.chunks_exact(3).map(|p| p[0]).fold(f32::MIN, f32::max);
        let thr = |max: Option<f32>, margin: usize| Params { threshold: 200.0, max, margin, smooth: 0, part: at, step: 1, max_triangles: 10_000_000 };

        // Growing from the vessel with a lower limit only runs into the bone as well
        let all = extract(&v, &g, &thr(None, 0)).unwrap();
        assert!(reach(&all) > 34.0, "{}", reach(&all));
        // A maximum removes the bone, but its shell still joins the vessel
        let shell = extract(&v, &g, &thr(Some(600.0), 0)).unwrap();
        assert!(reach(&shell) > 34.0, "{}", reach(&shell));
        // A margin around what is too bright cuts the shell away
        let cut = extract(&v, &g, &thr(Some(600.0), 1)).unwrap();
        assert!(reach(&cut) < 26.0, "{}", reach(&cut));
        assert_closed(&cut);
        assert!(extract(&v, &g, &thr(Some(100.0), 1)).is_err()); // maximum below the threshold
    }

    #[test]
    fn a_leaking_region_is_reported() {
        let z = zs(10, 1.0);
        let v = vec![vec![500.0f32; 100]; 10];
        let g = geo(10, 10, &z);
        let p = Params { threshold: 200.0, max: None, margin: 0, smooth: 0, part: Part::At { i: 5, j: 5, k: 5 }, step: 1, max_triangles: 10_000_000 };
        let err = extract(&v, &g, &p).err().unwrap();
        assert!(err.contains("40%"), "{err}");
    }

    #[test]
    fn dilation_grows_a_mask_by_one_voxel_per_round() {
        let dims = (7, 7, 7);
        let mut m = vec![0u8; 343];
        m[(3 * 7 + 3) * 7 + 3] = 1;
        dilate(&mut m, dims, 2);
        let count = m.iter().filter(|&&x| x != 0).count();
        assert_eq!(count, 5 * 5 * 5); // a 5 x 5 x 5 box around the voxel
        assert_eq!(m[0], 0);
        assert_ne!(m[(1 * 7 + 1) * 7 + 1], 0);
    }
}
