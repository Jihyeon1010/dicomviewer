# DICOM Viewer

A local DICOM viewer for desktop, built with [Tauri 2](https://tauri.app) (Rust backend, TypeScript frontend, WebGL2 rendering). Files are read and processed on your own machine; the app makes no network requests.

> **Not for clinical use.** This is a research and development tool. It is not a medical device and has no regulatory clearance. Measurements, including those made with an approximate calibration, must not be used for diagnosis or treatment decisions.

## Features

### Viewing
- Open files or whole folders (also by drag and drop); a series list with thumbnails
- Window / level with presets, invert, pan, zoom, scroll, rotate and flip, orientation in the radiological convention or as stored
- Overlays with patient and study data, orientation markers, scale bars, an anonymize switch, and a DICOM tag browser
- Layouts up to 4 × 3 with linked scrolling and window / level
- **Tile view**: consecutive images of one series, one per view, scrolling together
- **Enlarge a view**: double click (several views) or `Alt+Z`, again to restore
- Cine playback with loop range, ping-pong and bookmarks
- Save the image as PNG or copy it to the clipboard

### Measurements
- Length, angle, elliptical and rectangular ROI with statistics, aneurysm measurement
- Length calibration from an object of known size (an approximation, see the notes in the app)

### Angiography (XA, RF)
- Digital subtraction (DSA) with a choice of mask, linear or log mode and a mask shift tool
- Projection over time: minimum, maximum and mean

### Volume, MPR and 3D
- Build a volume from a series (images in stack order, with their real positions)
- **MPR**: axial, coronal and sagittal views linked by a crosshair, with thin planes or slabs (MIP, MinIP, average) of a chosen thickness. The planes can be turned about the crosshair, which keeps its place on screen
- **3D view** in the fourth pane, rendered on the GPU. Drag with the rotate tool; it turns about the point you picked with the crosshair
  - **MIP, MinIP, Average** projections
  - **Volume** rendering with lighting and presets: CT (bone, vessels, soft tissue), MR (tissue, MRA), X-ray (bright or dark vessels) and a generic one. A thickness setting draws only a slab around the middle
  - **Surface**: the isosurface at a threshold, with a maximum, smoothing, a choice of detail and three ways to choose the parts (see below)
  - The planes of the MPR, and the two sides of a slab, are outlined in the 3D view (the **Planes** button)
- **Export** of surfaces as STL, OBJ or PLY, in millimetres, in DICOM patient coordinates (LPS), 3D Slicer coordinates (RAS) or the axes of the volume

## Getting started

### Requirements
- [Node.js](https://nodejs.org) 20.19 or newer (Vite 8)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- The system libraries that Tauri needs: see the [prerequisites](https://tauri.app/start/prerequisites/)

The app is developed on macOS. Windows and Linux are supported by Tauri but have not been tested.

### Run and build

```bash
npm install
npm run tauri dev     # development, with hot reload
npm run tauri build   # a release build and installer
```

### Checks

```bash
npm run build                    # type check (tsc) and bundle
cd src-tauri && cargo test --lib # unit tests of the volume, MPR and surface code

# Optional: run the volume, surface and export code on a real series. It checks the
# placement of the exported files against the positions stored in the DICOM files.
DICOM_SAMPLE=/path/to/series cargo test --release --lib real_series -- --ignored --nocapture
```

## Using the 3D features

1. Open a series with at least two images, then press `V` (build volume) or `Shift+M` (MPR). The volume is kept in memory until other files are opened.
2. In the MPR, place the **crosshair** (`K`) on the structure you are interested in. Turn the planes with the rotate tool (`Q`); `Shift+Q` resets the rotation.
3. Press `Shift+V` for the 3D view and `Alt+V` to go through its modes. Click a new point with the crosshair tool to centre the 3D view there.
4. In **Volume** mode choose a preset that fits the modality. The thickness setting limits the part of the volume that is drawn.
5. In **Surface** mode:

   | Control | Meaning |
   |---|---|
   | **Min** | Lowest value that belongs to the surface. For CT the default is 300 |
   | **Max** | Highest value (empty for no limit). Set it to leave out bone next to contrast-filled vessels; voxels close to it are left out too, so the shell of in-between values around the bone does not join the vessel |
   | **All parts / Largest part / Grow from crosshair** | Which parts get a surface. *Grow from crosshair* follows the connected structure under the crosshair, for example one vessel tree. A region that fills more than 40% of the volume is reported as a leak |
   | **Smoothing** | Taubin smoothing of the mesh (none, light, medium, strong). It also applies to the exported file |
   | **Detail** | Automatic, or every voxel, every second, every third. Coarser is faster and smaller |
   | **Update** | Builds the surface again, for example at a new crosshair position |
   | **Export** | Saves an STL, OBJ or PLY file in the chosen coordinates |

   A typical CTA of the head: Min around 200 to 300, Max around 600 to 700, *Grow from crosshair*, the crosshair on a vessel.

## Keyboard shortcuts

All shortcuts can be changed in **Settings** (`,` or `?`). Shortcuts refer to physical keys, so they also work while a non-Latin input language is active. The list shows the defaults for **macOS** (`Alt` is `Option`). On Windows and Linux `Cmd` is `Ctrl`.

| Action | Keys |
|---|---|
| Previous / next image | `↑` `←` / `↓` `→` |
| Back / forward 10 images | `Page Up` / `Page Down` |
| First / last image | `Home` / `End` |
| Zoom in / out / fit | `=` `+` / `-` / `0` |
| Rotate clockwise / counterclockwise | `E` / `Shift+E` |
| Flip horizontally / vertically | `H` / `Shift+H` |
| Reset orientation | `Shift+R` |
| Orientation: standard / as stored | `Shift+O` |
| Window/level, pan, zoom, scroll tool | `W` `P` `Z` `S` |
| Length, angle, ellipse, rectangle | `D` `G` `C` `X` |
| Aneurysm, calibrate length | `N` `J` |
| Delete last measurement / clear all on image | `Backspace` or `Delete` / `Shift` + the same |
| Remove calibration | `Shift+J` |
| Invert / reset window | `I` / `R` |
| Window presets 1 to 6 | `1` to `6` |
| Overlay detail / markers / anonymize | `O` / `M` / `A` |
| Slider position / DICOM tags / settings | `B` / `T` / `,` or `?` |
| Layouts 1x1, 2x1, 1x2, 2x2, 3x2, 3x3, 4x3 | `Alt+1` to `Alt+7` |
| Sync scroll / sync window | `L` / `Shift+L` |
| Tile view: consecutive images in the views | `Alt+T` |
| Enlarge / restore the active view (also a double click with several views) | `Alt+Z` |
| Play or pause cine | `Space` |
| Cine faster / slower | `]` / `[` |
| Loop start / end / clear | `Alt+I` / `Alt+O` / `Alt+L` |
| Ping-pong | `Alt+P` |
| Bookmark / next / previous bookmark | `Alt+K` / `Alt+.` / `Alt+,` |
| Build volume | `V` |
| MPR on or off | `Shift+M` |
| Crosshair / rotate tool (MPR) | `K` / `Q` |
| Reset MPR rotation / 3D view | `Shift+Q` / `Shift+V` |
| Next 3D view mode (MIP, MinIP, average, volume, surface) | `Alt+V` |
| DSA on or off | `Shift+D` |
| Mask shift tool / use this frame as mask | `U` / `Shift+U` |
| Shift the mask | `Alt+←` `→` `↑` `↓`, reset with `Alt+0` |
| Projection over time (off, min, max, mean) | `Shift+T` |
| Open files / open folder | `Cmd+O` / `Cmd+Shift+O` |
| Save image as PNG / copy image | `Cmd+S` / `Cmd+Shift+C` |

## Limitations

- **Volumes** are limited to 4 GB of 32-bit values and need images of one size. Colour series cannot be built into a volume.
- **GPU rendering** needs WebGL2. The 3D projections fall back to the CPU when it is missing; volume rendering and surfaces need the GPU. Volumes larger than about 384 MB as half floats, or than the 3D texture limit of the GPU, are scaled down for the 3D view.
- **Surfaces** are limited to 6 million triangles on screen and 30 million in a file; use a coarser detail or a higher threshold when the limit is reached.
- The **CT presets** assume CT numbers in Hounsfield units. MR and X-ray presets are placed relative to the bulk of the values and may need another threshold for the surface.
- The **viewing side** of volume and surface renderings follows the patient orientation of the series; series without orientation data use a default side.
- Segmentation is limited to thresholding with region growing; there are no organ or lesion segmentation tools.

## Project layout

```
src/                 TypeScript frontend (no framework)
  main.ts            application, toolbar, shortcuts, layout, tile view
  viewport.ts        one image view: tools, overlays, measurements, crosshair
  mpr.ts             MPR controller: planes, rotation, 3D view, surface settings
  volume-gl.ts       GPU rendering of the volume (projections, volume rendering, meshes)
  transfer.ts        colour and opacity presets for volume rendering
  renderer.ts        WebGL2 drawing of 2D images
  api.ts             calls to the Rust backend
src-tauri/src/
  lib.rs             Tauri commands, file reading, volume building
  mpr.rs             reformatting, slabs, oblique planes, texture data
  surface.rs         isosurface (surface nets), smoothing, region growing, STL/OBJ/PLY
```

## Status

Early development (version 0.1). Interfaces and file formats may change.
