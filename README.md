# Dicom Viewer

A local DICOM viewer for multi platform, developed with Tauri (Rust backend + TypeScript frontend)

## Status

## Limitation

## Keyboard shortcuts
 
All shortcuts can be changed in **Settings** (`Mac os` = `Cmd+`, `Windos and Linux` = `Ctrl+`). Shortcuts refer to physical keys, so they also work while a non-Latin input language is active. The list below shows the defaults.
 
### `MacOS`

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
| Play or pause cine | `Space` |
| Cine faster / slower | `]` / `[` |
| Loop start / end / clear | `Alt+I` / `Alt+O` / `Alt+L` |
| Ping-pong | `Alt+P` |
| Bookmark / next / previous bookmark | `Alt+K` / `Alt+.` / `Alt+,` |
| Build volume | `V` |
| MPR on or off | `Shift+M` |
| Crosshair / rotate tool (MPR) | `K` / `Q` |
| Reset MPR rotation / 3D view | `Shift+Q` / `Shift+V` |
| Next 3D view mode (MIP, MinIP, average, volume) | `Alt+V` |
| DSA on or off | `Shift+D` |
| Mask shift tool / use this frame as mask | `U` / `Shift+U` |
| Shift the mask | `Alt+←` `→` `↑` `↓`, reset with `Alt+0` |
| Projection over time (off, min, max, mean) | `Shift+T` |
| Open files / open folder | `Cmd+O` / `Cmd+Shift+O` |
| Save image as PNG / copy image | `Cmd+S` / `Cmd+Shift+C` |