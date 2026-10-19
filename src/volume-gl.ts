import type { VolumeTexture } from "./api";
import type { SliceData } from "./types";
import { cross, unit, type V3 } from "./vec3";

export type ProjectionMode = "max" | "min" | "mean";

/** Where and how a projection image samples the volume (local millimetre coordinates). */
export interface ProjectionParams {
  origin: V3; // the point in the middle of the image; z is the stored image position
  u: V3; // image x axis
  v: V3; // image y axis
  width: number;
  height: number;
  pixelMm: number;
  stepMm: number; // distance between samples along a ray
  mode: ProjectionMode;
}

// Most samples taken along one ray
const MAX_STEPS = 4096;

const VERT = `#version 300 es
void main() {
  // Full-screen triangle generated from gl_VertexID; no vertex buffers needed
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Mirrors reformat_oblique in src-tauri/src/mpr.rs: one ray per pixel, perpendicular to the
// image, through the whole volume. The result is the 16-bit encoding that the backend uses
// for reformatted images (value = raw * slope + intercept), packed into two 8-bit channels
// so that it can be read back from any WebGL2 implementation.
const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform vec3 uSize;   // texels per axis
uniform vec3 uExt;    // millimetres between the first and last texel centre
uniform vec3 uOrigin;
uniform vec3 uU;
uniform vec3 uV;
uniform vec3 uN;
uniform vec2 uHalf;   // half the image size in pixels
uniform float uPixel;
uniform float uStep;
uniform float uSlope;
uniform float uIntercept;
uniform float uBackground; // value of rays that miss the volume
uniform int uMode;    // 0 max, 1 min, 2 mean
out vec4 outColor;

float fetch(vec3 p) {
  // Texel centres lie at 0.5 .. size - 0.5; the first and last one sit on the faces
  vec3 t = (p / uExt * (uSize - 1.0) + 0.5) / uSize;
  return texture(uVol, t).r;
}

// Part of the ray pt + t * n that lies inside the volume box
bool clipRay(vec3 pt, vec3 n, out float t0, out float t1) {
  t0 = -1.0e9;
  t1 = 1.0e9;
  for (int a = 0; a < 3; a++) {
    float na = n[a];
    if (abs(na) < 1.0e-12) {
      if (pt[a] < -1.0e-4 || pt[a] > uExt[a] + 1.0e-4) return false;
    } else {
      float ta = (0.0 - pt[a]) / na;
      float tb = (uExt[a] - pt[a]) / na;
      if (ta > tb) {
        float s = ta;
        ta = tb;
        tb = s;
      }
      t0 = max(t0, ta);
      t1 = min(t1, tb);
    }
  }
  if (t0 <= t1 + 1.0e-4) {
    t1 = max(t1, t0);
    return true;
  }
  return false;
}

void main() {
  // Row 0 of the result is the bottom row of the framebuffer, which readPixels returns first
  float a = (gl_FragCoord.x - uHalf.x) * uPixel;
  float b = (gl_FragCoord.y - uHalf.y) * uPixel;
  vec3 pt = uOrigin + a * uU + b * uV;

  float value = uBackground;
  float t0;
  float t1;
  if (clipRay(pt, uN, t0, t1)) {
    float len = t1 - t0;
    float step = max(max(uStep, len / ${MAX_STEPS}.0), 1.0e-3);
    int count = int(floor(len / step + 1.0e-6)) + 1;
    float acc = uMode == 0 ? -3.0e38 : (uMode == 1 ? 3.0e38 : 0.0);
    for (int m = 0; m < ${MAX_STEPS + 4}; m++) {
      if (m >= count) break;
      float s = fetch(pt + (t0 + float(m) * step) * uN);
      if (uMode == 0) acc = max(acc, s);
      else if (uMode == 1) acc = min(acc, s);
      else acc += s;
    }
    value = uMode == 2 ? acc / float(count) : acc;
  }

  float raw = clamp(floor((value - uIntercept) / uSlope + 0.5), 0.0, 65535.0);
  outColor = vec4(mod(raw, 256.0) / 255.0, floor(raw / 256.0) / 255.0, 0.0, 1.0);
}`;

const UNIFORMS = [
  "uVol", "uSize", "uExt", "uOrigin", "uU", "uV", "uN", "uHalf", "uPixel", "uStep",
  "uSlope", "uIntercept", "uBackground", "uMode",
] as const;

type UniformName = (typeof UNIFORMS)[number];

const MODE_CODE: Record<ProjectionMode, number> = { max: 0, min: 1, mean: 2 };

/**
 * Renders projections (MIP, MinIP, average) of a volume on the GPU, in a WebGL2 context of
 * its own. The images come back as ordinary 16-bit slices, so the viewports can window,
 * zoom and measure them like any other image.
 */
export class VolumeGL {
  /** Largest side of the volume texture this GPU accepts */
  readonly maxDim: number;

  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly loc: Record<UniformName, WebGLUniformLocation>;
  private volumeTex: WebGLTexture | null = null;
  private target: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number } | null = null;
  private info: VolumeTexture | null = null;
  private z0 = 0;
  private lost = false;

  private constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement) {
    this.gl = gl;
    this.maxDim = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;

    const vs = this.compile(gl.VERTEX_SHADER, VERT);
    const fs = this.compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!prog) throw new Error("Could not create a WebGL program");
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.prog = prog;

    const loc = {} as Record<UniformName, WebGLUniformLocation>;
    for (const name of UNIFORMS) {
      const l = gl.getUniformLocation(prog, name);
      if (!l) throw new Error(`Missing shader uniform: ${name}`);
      loc[name] = l;
    }
    this.loc = loc;

    gl.disable(gl.DITHER); // the output carries exact numbers
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  /** Opens a context; null when WebGL2 is not available. */
  static open(): VolumeGL | null {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
      });
      return gl ? new VolumeGL(gl, canvas) : null;
    } catch (err) {
      console.warn("GPU volume rendering is not available:", err);
      return null;
    }
  }

  get ready(): boolean {
    return this.volumeTex !== null && !this.lost && !this.gl.isContextLost();
  }

  /** Puts the volume on the GPU. `z0` is the stored position of the first image. */
  upload(vol: VolumeTexture, z0: number): void {
    const gl = this.gl;
    if (vol.cols > this.maxDim || vol.rows > this.maxDim || vol.depth > this.maxDim) {
      throw new Error(
        `Volume ${vol.cols}x${vol.rows}x${vol.depth} exceeds the 3D texture limit (${this.maxDim})`,
      );
    }
    this.freeVolume();
    const tex = gl.createTexture();
    if (!tex) throw new Error("Could not create a 3D texture");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R16F, vol.cols, vol.rows, vol.depth);

    // A few images at a time keeps the driver from making a second copy of the whole volume
    const per = vol.cols * vol.rows;
    const chunk = Math.max(1, Math.floor((16 * 1024 * 1024) / (per * 2)));
    for (let k = 0; k < vol.depth; k += chunk) {
      const n = Math.min(chunk, vol.depth - k);
      gl.texSubImage3D(
        gl.TEXTURE_3D, 0, 0, 0, k, vol.cols, vol.rows, n,
        gl.RED, gl.HALF_FLOAT, vol.data, k * per,
      );
    }
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      throw new Error(`Uploading the volume failed (WebGL error ${err})`);
    }
    this.volumeTex = tex;
    // Keep the description but not the voxels
    this.info = { ...vol, data: new Uint16Array(0) };
    this.z0 = z0;
  }

  /** Renders one projection image in the 16-bit format of reformatted images. */
  project(p: ProjectionParams): SliceData {
    const gl = this.gl;
    const vol = this.info;
    if (!vol || !this.volumeTex) throw new Error("No volume on the GPU");
    if (this.lost || gl.isContextLost()) throw new Error("The WebGL context was lost");
    const { width: w, height: h } = p;
    if (!(w > 0 && h > 0 && w <= gl.getParameter(gl.MAX_TEXTURE_SIZE))) {
      throw new Error("Unsupported image size");
    }
    const n = unit(cross(p.u, p.v));
    if (!n.every(Number.isFinite) || Math.hypot(n[0], n[1], n[2]) < 1e-6) {
      throw new Error("Invalid plane");
    }

    const target = this.targetOf(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTex);

    const l = this.loc;
    gl.uniform1i(l.uVol, 0);
    gl.uniform3f(l.uSize, vol.cols, vol.rows, vol.depth);
    gl.uniform3f(l.uExt, vol.extent[0], vol.extent[1], vol.extent[2]);
    gl.uniform3f(l.uOrigin, p.origin[0], p.origin[1], p.origin[2] - this.z0);
    gl.uniform3f(l.uU, p.u[0], p.u[1], p.u[2]);
    gl.uniform3f(l.uV, p.v[0], p.v[1], p.v[2]);
    gl.uniform3f(l.uN, n[0], n[1], n[2]);
    gl.uniform2f(l.uHalf, w / 2, h / 2);
    gl.uniform1f(l.uPixel, p.pixelMm);
    gl.uniform1f(l.uStep, p.stepMm);
    gl.uniform1f(l.uSlope, vol.slope);
    gl.uniform1f(l.uIntercept, vol.intercept);
    gl.uniform1f(l.uBackground, vol.valueMin);
    gl.uniform1i(l.uMode, MODE_CODE[p.mode]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const bytes = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const pixels = new Uint16Array(w * h);
    for (let i = 0, o = 0; i < pixels.length; i++, o += 4) {
      pixels[i] = (bytes[o] as number) | ((bytes[o + 1] as number) << 8);
    }

    return {
      rows: h,
      cols: w,
      bitsAllocated: 16,
      signed: false,
      slope: vol.slope || 1,
      intercept: vol.intercept,
      defaultWl: vol.defaultWl,
      defaultWw: vol.defaultWw,
      monochrome1: vol.monochrome1,
      samples: 1,
      pixels,
    };
  }

  /** Frees everything on the GPU. The object cannot be used afterwards. */
  dispose(): void {
    if (!this.gl.isContextLost()) {
      this.freeVolume();
      this.freeTarget();
      this.gl.deleteProgram(this.prog);
    }
    this.lost = true;
  }

  private targetOf(w: number, h: number): { tex: WebGLTexture; fbo: WebGLFramebuffer } {
    const gl = this.gl;
    const t = this.target;
    if (t && t.w === w && t.h === h) return t;
    this.freeTarget();
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error("Could not create a render target");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw new Error("The render target is incomplete");
    }
    this.target = { tex, fbo, w, h };
    return this.target;
  }

  private freeTarget(): void {
    const t = this.target;
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
    this.target = null;
  }

  private freeVolume(): void {
    if (this.volumeTex) this.gl.deleteTexture(this.volumeTex);
    this.volumeTex = null;
    this.info = null;
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error("Could not create a WebGL shader");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return sh;
  }
}
