import type { VolumeTexture } from "./api";
import type { SurfaceMesh } from "./api";
import { LUT_SIZE, type TransferFunction } from "./transfer";
import type { SliceData } from "./types";
import { cross, scale, unit, type V3 } from "./vec3";

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

/** A shaded volume rendering (colour and opacity from a transfer function). */
export interface RenderParams {
  origin: V3;
  u: V3;
  v: V3;
  width: number;
  height: number;
  pixelMm: number;
  stepMm: number;
  /** Thickness in mm of the part of the volume that is drawn, around its middle; Infinity for all */
  slabMm: number;
  shade: boolean;
  /** The slab is centred on this point (stored z positions); the middle of the volume if absent */
  centre?: V3;
  /** The viewer looks along this sign times u x v; -1 unless the data needs the other side */
  lookAlong?: 1 | -1;
}

/** A lit surface mesh drawn from the same view as the other renderings. */
export interface MeshParams {
  origin: V3;
  u: V3;
  v: V3;
  width: number;
  height: number;
  pixelMm: number;
  slabMm: number;
  /** Middle and radius of a sphere around the volume; the depth range of the view */
  centre: V3;
  radius: number;
  lookAlong?: 1 | -1; // see RenderParams
}

// Most samples taken along one ray
const MAX_STEPS = 4096;
// Opacities of the transfer function are for this much material
const REF_STEP_MM = 1;

const VERT = `#version 300 es
void main() {
  // Full-screen triangle generated from gl_VertexID; no vertex buffers needed
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Parts shared by both shaders: the volume, the image plane and the ray through a pixel.
// Mirrors reformat_oblique in src-tauri/src/mpr.rs.
const COMMON = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp sampler2D;
uniform sampler3D uVol;
uniform vec3 uSize;   // texels per axis
uniform vec3 uExt;    // millimetres between the first and last texel centre
uniform vec3 uOrigin;
uniform vec3 uU;
uniform vec3 uV;
uniform vec3 uN;      // direction of the rays
uniform vec2 uHalf;   // half the image size in pixels
uniform float uPixel;
uniform float uStep;
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

// Point of the volume that the ray of this pixel passes through
vec3 rayPoint() {
  // Row 0 of the result is the bottom row of the framebuffer, which readPixels returns first
  float a = (gl_FragCoord.x - uHalf.x) * uPixel;
  float b = (gl_FragCoord.y - uHalf.y) * uPixel;
  return uOrigin + a * uU + b * uV;
}
`;

// Projection: the result is the 16-bit encoding that the backend uses for reformatted
// images (value = raw * slope + intercept), packed into two 8-bit channels so that it can
// be read back from any WebGL2 implementation.
const MIP_FRAG = COMMON + `
uniform float uSlope;
uniform float uIntercept;
uniform float uBackground; // value of rays that miss the volume
uniform int uMode;    // 0 max, 1 min, 2 mean

void main() {
  vec3 pt = rayPoint();
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

// Volume rendering: samples are looked up in the transfer function and composited front to
// back, with early termination. Surfaces are lit from the viewer's side with a light that
// follows the view; the gradient of the volume gives the surface normal.
const VR_FRAG = COMMON + `
uniform sampler2D uLut;
uniform float uLutLo;
uniform float uLutInv;     // 1 / (hi - lo)
uniform float uRefStep;
uniform float uGradStep;   // mm between the samples of the gradient
uniform float uGradRef;    // value change across the gradient step that counts as a full surface
uniform vec3 uCentre;
uniform float uHalfSlab;
uniform bool uShade;

vec4 classify(float v) {
  float x = clamp((v - uLutLo) * uLutInv, 0.0, 1.0);
  return texture(uLut, vec2((x * ${LUT_SIZE - 1}.0 + 0.5) / ${LUT_SIZE}.0, 0.5));
}

void main() {
  vec3 pt = rayPoint();
  vec3 acc = vec3(0.0);
  float alpha = 0.0;
  float t0;
  float t1;
  if (clipRay(pt, uN, t0, t1)) {
    // Keep only the slab around the middle of the volume
    float off = dot(pt - uCentre, uN);
    t0 = max(t0, -uHalfSlab - off);
    t1 = min(t1, uHalfSlab - off);
    if (t1 >= t0) {
      float len = t1 - t0;
      float step = max(max(uStep, len / ${MAX_STEPS}.0), 1.0e-3);
      int count = int(floor(len / step + 1.0e-6)) + 1;
      float corr = step / uRefStep;
      vec3 light = -uN;
      for (int m = 0; m < ${MAX_STEPS + 4}; m++) {
        if (m >= count) break;
        vec3 p = pt + (t0 + float(m) * step) * uN;
        vec4 c = classify(fetch(p));
        float a = 1.0 - pow(1.0 - min(c.a, 0.999), corr);
        if (a < 0.002) continue;
        vec3 col = c.rgb;
        if (uShade) {
          float h = uGradStep;
          vec3 g = vec3(
            fetch(p + vec3(h, 0.0, 0.0)) - fetch(p - vec3(h, 0.0, 0.0)),
            fetch(p + vec3(0.0, h, 0.0)) - fetch(p - vec3(0.0, h, 0.0)),
            fetch(p + vec3(0.0, 0.0, h)) - fetch(p - vec3(0.0, 0.0, h)));
          float gl = length(g);
          float w = clamp(gl / uGradRef, 0.0, 1.0);
          if (w > 0.0) {
            vec3 nrm = -g / gl; // points out of the denser material
            float d = abs(dot(nrm, light));
            float spec = pow(d, 24.0) * 0.25;
            col = mix(col, col * (0.3 + 0.8 * d) + vec3(spec), w);
          }
        }
        acc += (1.0 - alpha) * a * col;
        alpha += (1.0 - alpha) * a;
        if (alpha > 0.97) break;
      }
    }
  }
  outColor = vec4(clamp(acc, 0.0, 1.0), 1.0);
}`;

// Surface meshes: orthographic projection onto the image plane with a depth buffer. The
// pixel mapping is the same as that of the ray shaders, so the images line up with them.
const MESH_VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
uniform vec3 uOrigin;
uniform vec3 uU;
uniform vec3 uV;
uniform vec3 uN;
uniform vec3 uCentre;
uniform vec2 uHalf;
uniform float uPixel;
uniform float uRadius;
out vec3 vNormal;
out float vDepth;
void main() {
  vec3 q = aPos - uOrigin;
  vec2 pix = vec2(dot(q, uU), dot(q, uV)) / uPixel + uHalf;
  vDepth = dot(aPos - uCentre, uN);
  vNormal = aNormal;
  gl_Position = vec4(pix.x / uHalf.x - 1.0, pix.y / uHalf.y - 1.0, vDepth / uRadius, 1.0);
}`;

const MESH_FRAG = `#version 300 es
precision highp float;
uniform vec3 uN;
uniform float uHalfSlab;
in vec3 vNormal;
in float vDepth;
out vec4 outColor;
void main() {
  if (abs(vDepth) > uHalfSlab) discard;
  // Lit from the viewer's side; both sides of the surface are lit alike
  float d = abs(dot(normalize(vNormal), uN));
  float spec = pow(d, 32.0) * 0.3;
  vec3 col = vec3(0.86, 0.80, 0.70) * (0.25 + 0.75 * d) + vec3(spec);
  outColor = vec4(min(col, vec3(1.0)), 1.0);
}`;

const COMMON_UNIFORMS = [
  "uVol", "uSize", "uExt", "uOrigin", "uU", "uV", "uN", "uHalf", "uPixel", "uStep",
] as const;
const MIP_UNIFORMS = [...COMMON_UNIFORMS, "uSlope", "uIntercept", "uBackground", "uMode"] as const;
const VR_UNIFORMS = [
  ...COMMON_UNIFORMS, "uLut", "uLutLo", "uLutInv", "uRefStep", "uGradStep", "uGradRef",
  "uCentre", "uHalfSlab", "uShade",
] as const;

const MESH_UNIFORMS = [
  "uOrigin", "uU", "uV", "uN", "uCentre", "uHalf", "uPixel", "uRadius", "uHalfSlab",
] as const;

interface Prog<N extends string> {
  prog: WebGLProgram;
  loc: Record<N, WebGLUniformLocation>;
}

const MODE_CODE: Record<ProjectionMode, number> = { max: 0, min: 1, mean: 2 };

/**
 * Renders projections (MIP, MinIP, average) and shaded volume renderings of a volume on the
 * GPU, in a WebGL2 context of its own. Projections come back as ordinary 16-bit slices and
 * renderings as RGB slices, so the viewports can zoom and measure them like any other image.
 */
export class VolumeGL {
  /** Largest side of the volume texture this GPU accepts */
  readonly maxDim: number;

  private readonly gl: WebGL2RenderingContext;
  private readonly mip: Prog<(typeof MIP_UNIFORMS)[number]>;
  private readonly vr: Prog<(typeof VR_UNIFORMS)[number]>;
  private readonly meshProg: Prog<(typeof MESH_UNIFORMS)[number]>;
  private meshGpu: {
    vao: WebGLVertexArrayObject;
    buffers: WebGLBuffer[];
    count: number;
  } | null = null;
  private depthTarget: {
    tex: WebGLTexture;
    depth: WebGLRenderbuffer;
    fbo: WebGLFramebuffer;
    w: number;
    h: number;
  } | null = null;
  private volumeTex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private lutRange: [number, number] = [0, 1];
  private target: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number } | null = null;
  private info: VolumeTexture | null = null;
  private z0 = 0;
  private lost = false;

  private constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement) {
    this.gl = gl;
    this.maxDim = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    this.mip = this.link(MIP_FRAG, MIP_UNIFORMS);
    this.vr = this.link(VR_FRAG, VR_UNIFORMS);
    this.meshProg = this.link(MESH_FRAG, MESH_UNIFORMS, MESH_VERT);

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

  /** Sets the colours and opacities that `render` uses. */
  setTransferFunction(tf: TransferFunction): void {
    const gl = this.gl;
    if (tf.lut.length !== LUT_SIZE * 4) throw new Error("Unexpected transfer function size");
    if (!this.lutTex) {
      const tex = gl.createTexture();
      if (!tex) throw new Error("Could not create a texture");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, LUT_SIZE, 1);
      this.lutTex = tex;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, tf.lut);
    this.lutRange = [tf.lo, Math.max(tf.hi, tf.lo + 1e-6)];
  }

  /** Renders one projection image in the 16-bit format of reformatted images. */
  project(p: ProjectionParams): SliceData {
    const vol = this.begin(p.width, p.height);
    const gl = this.gl;
    const dir = unit(cross(p.u, p.v));
    this.checkDirection(dir);

    gl.useProgram(this.mip.prog);
    const l = this.mip.loc;
    this.setCommon(l, vol, p, dir);
    gl.uniform1f(l.uSlope, vol.slope);
    gl.uniform1f(l.uIntercept, vol.intercept);
    gl.uniform1f(l.uBackground, vol.valueMin);
    gl.uniform1i(l.uMode, MODE_CODE[p.mode]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const bytes = this.readBack(p.width, p.height);
    const pixels = new Uint16Array(p.width * p.height);
    for (let i = 0, o = 0; i < pixels.length; i++, o += 4) {
      pixels[i] = (bytes[o] as number) | ((bytes[o + 1] as number) << 8);
    }
    return {
      rows: p.height,
      cols: p.width,
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

  /**
   * Renders the volume with the current transfer function as an 8-bit RGB image. The viewer
   * looks along -(u x v) unless `lookAlong` says otherwise.
   */
  render(p: RenderParams): SliceData {
    const vol = this.begin(p.width, p.height);
    const gl = this.gl;
    if (!this.lutTex) throw new Error("No transfer function set");
    const dir = scale(unit(cross(p.u, p.v)), p.lookAlong ?? -1);
    this.checkDirection(dir);

    gl.useProgram(this.vr.prog);
    const l = this.vr.loc;
    this.setCommon(l, vol, p, dir);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(l.uLut, 1);
    const [lo, hi] = this.lutRange;
    gl.uniform1f(l.uLutLo, lo);
    gl.uniform1f(l.uLutInv, 1 / (hi - lo));
    gl.uniform1f(l.uRefStep, REF_STEP_MM);
    // Gradient over one voxel of the finest axis; a surface is a change of about 5% of the
    // value range across it
    const voxel = Math.min(
      vol.extent[0] / Math.max(1, vol.cols - 1),
      vol.extent[1] / Math.max(1, vol.rows - 1),
      vol.extent[2] / Math.max(1, vol.depth - 1),
    );
    gl.uniform1f(l.uGradStep, Math.max(voxel, 1e-3));
    gl.uniform1f(l.uGradRef, Math.max(1e-6, 0.05 * (hi - lo)));
    const c = p.centre;
    if (c) gl.uniform3f(l.uCentre, c[0], c[1], c[2] - this.z0);
    else gl.uniform3f(l.uCentre, vol.extent[0] / 2, vol.extent[1] / 2, vol.extent[2] / 2);
    gl.uniform1f(l.uHalfSlab, Number.isFinite(p.slabMm) ? Math.max(p.slabMm, 0) / 2 : 1e8);
    gl.uniform1i(l.uShade, p.shade ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const bytes = this.readBack(p.width, p.height);
    const pixels = new Uint8Array(p.width * p.height * 3);
    for (let i = 0, o = 0, q = 0; i < p.width * p.height; i++, o += 4, q += 3) {
      pixels[q] = bytes[o] as number;
      pixels[q + 1] = bytes[o + 1] as number;
      pixels[q + 2] = bytes[o + 2] as number;
    }
    return {
      rows: p.height,
      cols: p.width,
      bitsAllocated: 8,
      signed: false,
      slope: 1,
      intercept: 0,
      defaultWl: null,
      defaultWw: null,
      monochrome1: false,
      samples: 3,
      pixels,
    };
  }

  get hasMesh(): boolean {
    return this.meshGpu !== null;
  }

  /** Puts a surface mesh on the GPU, replacing the previous one. */
  setMesh(mesh: SurfaceMesh): void {
    const gl = this.gl;
    this.freeMesh();
    const vao = gl.createVertexArray();
    const buffers = [gl.createBuffer(), gl.createBuffer(), gl.createBuffer()];
    if (!vao || buffers.some((b) => !b)) throw new Error("Could not create mesh buffers");
    const [pos, nrm, idx] = buffers as WebGLBuffer[];
    gl.bindVertexArray(vao);
    for (const [buf, data, name] of [
      [pos, mesh.positions, "aPos"],
      [nrm, mesh.normals, "aNormal"],
    ] as const) {
      const at = gl.getAttribLocation(this.meshProg.prog, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteVertexArray(vao);
      for (const b of buffers) gl.deleteBuffer(b);
      throw new Error(`Uploading the surface failed (WebGL error ${err})`);
    }
    this.meshGpu = { vao, buffers: buffers as WebGLBuffer[], count: mesh.indices.length };
  }

  /** Draws the uploaded surface mesh as an 8-bit RGB image. */
  drawMesh(p: MeshParams): SliceData {
    const gl = this.gl;
    const mesh = this.meshGpu;
    if (!mesh) throw new Error("No surface on the GPU");
    if (this.lost || gl.isContextLost()) throw new Error("The WebGL context was lost");
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (!(p.width > 0 && p.height > 0 && p.width <= max && p.height <= max)) {
      throw new Error("Unsupported image size");
    }
    const dir = scale(unit(cross(p.u, p.v)), p.lookAlong ?? -1);
    this.checkDirection(dir);

    const target = this.depthTargetOf(p.width, p.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, p.width, p.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.meshProg.prog);
    const l = this.meshProg.loc;
    gl.uniform3f(l.uOrigin, p.origin[0], p.origin[1], p.origin[2]);
    gl.uniform3f(l.uU, p.u[0], p.u[1], p.u[2]);
    gl.uniform3f(l.uV, p.v[0], p.v[1], p.v[2]);
    gl.uniform3f(l.uN, dir[0], dir[1], dir[2]);
    gl.uniform3f(l.uCentre, p.centre[0], p.centre[1], p.centre[2]);
    gl.uniform2f(l.uHalf, p.width / 2, p.height / 2);
    gl.uniform1f(l.uPixel, p.pixelMm);
    gl.uniform1f(l.uRadius, p.radius);
    gl.uniform1f(l.uHalfSlab, Number.isFinite(p.slabMm) ? Math.max(p.slabMm, 0) / 2 : 1e8);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);

    const bytes = this.readBack(p.width, p.height);
    const pixels = new Uint8Array(p.width * p.height * 3);
    for (let i = 0, o = 0, q = 0; i < p.width * p.height; i++, o += 4, q += 3) {
      pixels[q] = bytes[o] as number;
      pixels[q + 1] = bytes[o + 1] as number;
      pixels[q + 2] = bytes[o + 2] as number;
    }
    return {
      rows: p.height,
      cols: p.width,
      bitsAllocated: 8,
      signed: false,
      slope: 1,
      intercept: 0,
      defaultWl: null,
      defaultWw: null,
      monochrome1: false,
      samples: 3,
      pixels,
    };
  }

  /** Frees everything on the GPU. The object cannot be used afterwards. */
  dispose(): void {
    if (!this.gl.isContextLost()) {
      this.freeVolume();
      this.freeTarget();
      this.freeMesh();
      this.freeDepthTarget();
      this.gl.deleteProgram(this.meshProg.prog);
      if (this.lutTex) this.gl.deleteTexture(this.lutTex);
      this.lutTex = null;
      this.gl.deleteProgram(this.mip.prog);
      this.gl.deleteProgram(this.vr.prog);
    }
    this.lost = true;
  }

  // Binds the render target and the volume; returns the description of the volume
  private begin(w: number, h: number): VolumeTexture {
    const gl = this.gl;
    const vol = this.info;
    if (!vol || !this.volumeTex) throw new Error("No volume on the GPU");
    if (this.lost || gl.isContextLost()) throw new Error("The WebGL context was lost");
    if (!(w > 0 && h > 0 && w <= gl.getParameter(gl.MAX_TEXTURE_SIZE) && h <= gl.getParameter(gl.MAX_TEXTURE_SIZE))) {
      throw new Error("Unsupported image size");
    }
    const target = this.targetOf(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTex);
    return vol;
  }

  private checkDirection(d: V3): void {
    if (!d.every(Number.isFinite) || Math.hypot(d[0], d[1], d[2]) < 1e-6) {
      throw new Error("Invalid plane");
    }
  }

  private setCommon(
    l: Record<(typeof COMMON_UNIFORMS)[number], WebGLUniformLocation>,
    vol: VolumeTexture,
    p: { origin: V3; u: V3; v: V3; width: number; height: number; pixelMm: number; stepMm: number },
    dir: V3,
  ): void {
    const gl = this.gl;
    gl.uniform1i(l.uVol, 0);
    gl.uniform3f(l.uSize, vol.cols, vol.rows, vol.depth);
    gl.uniform3f(l.uExt, vol.extent[0], vol.extent[1], vol.extent[2]);
    gl.uniform3f(l.uOrigin, p.origin[0], p.origin[1], p.origin[2] - this.z0);
    gl.uniform3f(l.uU, p.u[0], p.u[1], p.u[2]);
    gl.uniform3f(l.uV, p.v[0], p.v[1], p.v[2]);
    gl.uniform3f(l.uN, dir[0], dir[1], dir[2]);
    gl.uniform2f(l.uHalf, p.width / 2, p.height / 2);
    gl.uniform1f(l.uPixel, p.pixelMm);
    gl.uniform1f(l.uStep, p.stepMm);
  }

  private readBack(w: number, h: number): Uint8Array {
    const bytes = new Uint8Array(w * h * 4);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, bytes);
    return bytes;
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

  private depthTargetOf(w: number, h: number): { fbo: WebGLFramebuffer } {
    const gl = this.gl;
    const t = this.depthTarget;
    if (t && t.w === w && t.h === h) return t;
    this.freeDepthTarget();
    const tex = gl.createTexture();
    const depth = gl.createRenderbuffer();
    const fbo = gl.createFramebuffer();
    if (!tex || !depth || !fbo) throw new Error("Could not create a render target");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteRenderbuffer(depth);
      gl.deleteTexture(tex);
      throw new Error("The render target is incomplete");
    }
    this.depthTarget = { tex, depth, fbo, w, h };
    return this.depthTarget;
  }

  private freeDepthTarget(): void {
    const t = this.depthTarget;
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteRenderbuffer(t.depth);
    this.gl.deleteTexture(t.tex);
    this.depthTarget = null;
  }

  private freeMesh(): void {
    const m = this.meshGpu;
    if (!m) return;
    this.gl.deleteVertexArray(m.vao);
    for (const b of m.buffers) this.gl.deleteBuffer(b);
    this.meshGpu = null;
  }

  private freeVolume(): void {
    if (this.volumeTex) this.gl.deleteTexture(this.volumeTex);
    this.volumeTex = null;
    this.info = null;
  }

  private link<N extends string>(frag: string, names: readonly N[], vert = VERT): Prog<N> {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, vert);
    const fs = this.compile(gl.FRAGMENT_SHADER, frag);
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

    const loc = {} as Record<N, WebGLUniformLocation>;
    for (const name of names) {
      const l = gl.getUniformLocation(prog, name);
      if (!l) throw new Error(`Missing shader uniform: ${name}`);
      loc[name] = l;
    }
    return { prog, loc };
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
