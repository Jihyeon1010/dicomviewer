import { LAYOUT_PRESETS } from "./layout";

import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import type { OverlayMode } from "./settings";

export interface MenuDeps {
  appName: string;
  presetNames: string[];
  run: (actionId: string) => void; // runs a keymap action by id
  openFiles: () => void;
  openFolder: () => void;
  setOverlay: (mode: OverlayMode) => void;
}

export interface MenuState {
  tool: string;
  invert: boolean;
  markers: boolean;
  anonymize: boolean;
  overlay: OverlayMode;
}

export interface AppMenu {
  sync(state: MenuState): void;
}

const isMac = navigator.userAgent.includes("Mac");

type StdItem =
  | "Separator" | "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll"
  | "Minimize" | "Maximize" | "Fullscreen" | "CloseWindow" | "Quit"
  | "Hide" | "HideOthers" | "ShowAll" | "Services";

export async function installMenu(deps: MenuDeps): Promise<AppMenu> {
  const checks = new Map<string, CheckMenuItem>();

  const std = (item: StdItem) => PredefinedMenuItem.new({ item });

  // Native accelerators are only used for Cmd combos. Plain keys belong to the
  // user-configurable keymap; a native accelerator would swallow them first.
  const act = (text: string, onClick: () => void, accelerator?: string) =>
    MenuItem.new(accelerator ? { text, accelerator, action: onClick } : { text, action: onClick });

  const key = (text: string, actionId: string) => act(text, () => deps.run(actionId));

  // The native click toggles the check mark itself; sync() restores the real state afterwards
  async function check(id: string, text: string, onClick: () => void): Promise<CheckMenuItem> {
    const item = await CheckMenuItem.new({ text, checked: false, action: onClick });
    checks.set(id, item);
    return item;
  }

  const settingsItem = () => act("Settings…", () => deps.run("ui.settings"), "CmdOrCtrl+,");

  const appMenu = isMac
    ? await Submenu.new({
        text: deps.appName,
        items: [
          await PredefinedMenuItem.new({ item: { About: { name: deps.appName } } }),
          await std("Separator"),
          await settingsItem(),
          await std("Separator"),
          await std("Services"),
          await std("Separator"),
          await std("Hide"),
          await std("HideOthers"),
          await std("ShowAll"),
          await std("Separator"),
          await std("Quit"),
        ],
      })
    : null;

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await act("Open Files…", deps.openFiles, "CmdOrCtrl+O"),
      await act("Open Folder…", deps.openFolder, "CmdOrCtrl+Shift+O"),
      await std("Separator"),
      await std("CloseWindow"),
      // Without an app menu (Windows, Linux) these live under File
      ...(isMac ? [] : [await std("Separator"), await settingsItem(), await std("Quit")]),
    ],
  });

  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await std("Undo"),
      await std("Redo"),
      await std("Separator"),
      await std("Cut"),
      await std("Copy"),
      await std("Paste"),
      await std("SelectAll"),
    ],
  });

  const imagesMenu = await Submenu.new({
    text: "Images",
    items: [
      await key("Previous Image", "slice.prev"),
      await key("Next Image", "slice.next"),
      await std("Separator"),
      await key("Back 10 Images", "slice.back10"),
      await key("Forward 10 Images", "slice.fwd10"),
      await std("Separator"),
      await key("First Image", "slice.first"),
      await key("Last Image", "slice.last"),
    ],
  });

  const toolsMenu = await Submenu.new({
    text: "Tools",
    items: [
      await check("tool.window", "Window / Level", () => deps.run("tool.window")),
      await check("tool.pan", "Pan", () => deps.run("tool.pan")),
      await check("tool.zoom", "Zoom", () => deps.run("tool.zoom")),
      await check("tool.scroll", "Scroll", () => deps.run("tool.scroll")),
    ],
  });

  const presetItems = [];
  for (const [i, name] of deps.presetNames.entries()) {
    presetItems.push(await key(name, `preset.${i + 1}`));
  }

  const overlayMenu = await Submenu.new({
    text: "Overlay",
    items: [
      await check("overlay.full", "Full", () => deps.setOverlay("full")),
      await check("overlay.minimal", "Minimal", () => deps.setOverlay("minimal")),
      await check("overlay.off", "Off", () => deps.setOverlay("off")),
    ],
  });

  const layoutItems: MenuItem[] = [];
  for (const l of LAYOUT_PRESETS) {
    layoutItems.push(await key(`${l.cols} × ${l.rows}`, `layout.${l.cols}x${l.rows}`));
  }

  const viewMenu = await Submenu.new({
    text: "View",
    items: [
      await key("Zoom In", "view.zoomIn"),
      await key("Zoom Out", "view.zoomOut"),
      await key("Fit to Window", "view.fit"),
      await Submenu.new({
        text: "Layout",
        items: [
          ...layoutItems,
          await std("Separator"),
          await key("Toggle Scroll Sync", "sync.scroll"),
          await key("Toggle Window Sync", "sync.window"),
        ],
      }),
      await std("Separator"),
      await check("view.invert", "Invert", () => deps.run("view.invert")),
      await key("Reset Window", "view.resetWindow"),
      await Submenu.new({ text: "Window Presets", items: presetItems }),
      await std("Separator"),
      overlayMenu,
      await check("ui.markers", "Show Markers and Scale Bars", () => deps.run("ui.markers")),
      await check("ui.anonymize", "Anonymize", () => deps.run("ui.anonymize")),
      await key("Move Image Slider (Bottom / Right)", "ui.slider"),
      await std("Separator"),
      await std("Fullscreen"),
    ],
  });

  const windowMenu = await Submenu.new({
    text: "Window",
    items: [await std("Minimize"), await std("Maximize")],
  });

  const helpMenu = await Submenu.new({
    text: "Help",
    items: [await key("Keyboard Shortcuts…", "ui.settings")],
  });

  const menu = await Menu.new({
    items: [
      ...(appMenu ? [appMenu] : []),
      fileMenu,
      editMenu,
      imagesMenu,
      toolsMenu,
      viewMenu,
      windowMenu,
      helpMenu,
    ],
  });
  await menu.setAsAppMenu();

  return {
    sync(s: MenuState): void {
      const want: Record<string, boolean> = {
        "tool.window": s.tool === "window",
        "tool.pan": s.tool === "pan",
        "tool.zoom": s.tool === "zoom",
        "tool.scroll": s.tool === "scroll",
        "view.invert": s.invert,
        "ui.markers": s.markers,
        "ui.anonymize": s.anonymize,
        "overlay.full": s.overlay === "full",
        "overlay.minimal": s.overlay === "minimal",
        "overlay.off": s.overlay === "off",
      };
      for (const [id, on] of Object.entries(want)) {
        checks.get(id)?.setChecked(on).catch((err: unknown) => {
          console.warn(`Could not update menu item ${id}`, err);
        });
      }
    },
  };
}