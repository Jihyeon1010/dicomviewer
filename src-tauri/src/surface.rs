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
    if !p.threshold.is_finite() {
        return Err("Invalid threshold".into());
    }
    let step = p.step.max(1);
    let (nx, ny, nz) = grid_dims(g, step);
    if nz < 2 || nx < 2 || ny < 2 {
        return Err("The surface step is too coarse for this volume".into());
    }
    let cols = g.cols;
    let thr = p.threshold;
    let n = nx * ny * nz;

    // Foreground: voxels at or above the threshold
    let mut fg = vec![0u8; n];
    fg.par_chunks_mut(nx * ny).enumerate().for_each(|(k, plane)| {
        let s = &slices[(k * step).min(depth - 1)];
        for j in 0..ny {
            for i in 0..nx {
                plane[j * nx + i] = u8::from(s[j * step * cols + i * step] >= thr);
            }
        }
    });
    if !fg.iter().any(|&f| f != 0) {
        return Err("No voxel reaches the threshold".into());
    }

    let dims = (nx, ny, nz);
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
            flood(&fg, &mut seen, start, dims);
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

    let normals = vertex_normals(&positions, &indices);
    Ok(Mesh {
        positions,
        normals,
        indices,
    })
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
        Params { threshold: 0.5, part, step, max_triangles: 10_000_000 }
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
}
