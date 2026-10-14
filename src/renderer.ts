import type { SliceData } from "./types";

export interface DrawParams {
  wl: number;
  ww: number;
  invert: boolean;
}

// "int" and "uint" are windowed grayscale (signed / unsigned samples); "rgb" is colour
type Kind = "int" | "uint" | "rgb";

interface GrayUniforms {
  uSlope: WebGLUniformLocation;
  uIntercept: WebGLUniformLocation;
  uLo: WebGLUniformLocation;
  uInvWidth: WebGLUniformLocation;
}

interface ProgramInfo {
  prog: WebGLProgram;
  uTex: WebGLUniformLocation;
  uFlip: WebGLUniformLocation;
  gray: GrayUniforms | null; // null for the colour program, which has no windowing
}

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  // Full-screen triangle generated from gl_VertexID; no vertex buffers needed
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y); // image row 0 is the top of the screen
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Integer sampler types have no default precision in GLSL ES 3.00,
// so the precision statement for the sampler is required.
function fragSource(sampler: "isampler2D" | "usampler2D"): string {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp ${sampler};
uniform ${sampler} uTex;
uniform float uSlope;
uniform float uIntercept;
uniform float uLo;
uniform float uInvWidth;
uniform bool uFlip;
in vec2 vUv;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uTex, 0);
  ivec2 c = min(ivec2(vUv * vec2(size)), size - ivec2(1));
  float raw = float(texelFetch(uTex, c, 0).r);
  float v = clamp((raw * uSlope + uIntercept - uLo) * uInvWidth, 0.0, 1.0);
  if (uFlip) v = 1.0 - v;
  outColor = vec4(v, v, v, 1.0);
}`;
}

// Colour images are shown as they are: no rescale and no windowing
const RGB_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform bool uFlip;
in vec2 vUv;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uTex, 0);
  ivec2 c = min(ivec2(vUv * vec2(size)), size - ivec2(1));
  vec3 rgb = texelFetch(uTex, c, 0).rgb;
  if (uFlip) rgb = vec3(1.0) - rgb;
  outColor = vec4(rgb, 1.0);
}`;

export class GLRenderer {
  private canvas: HTMLCanvasElement;
  private onRestored: () => void;
  private gl!: WebGL2RenderingContext;
  private programs!: Record<Kind, ProgramInfo>;
  private maxSize = 0;

  private tex: WebGLTexture | null = null;
  private texW = 0;
  private texH = 0;
  private texFormat = 0;

  private slice: SliceData | null = null;
  private kind: Kind = "uint";

  constructor(canvas: HTMLCanvasElement, onRestored: () => void) {
    this.canvas = canvas;
    this.onRestored = onRestored;
    this.init();

    // GPU resources are lost with the context; rebuild them from the last slice
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => {
      try {
        this.init();
        if (this.slice) this.uploadTexture(this.slice);
        this.onRestored();
      } catch (err) {
        console.error(err);
      }
    });
  }

  private init(): void {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.programs = {
      int: this.link(fragSource("isampler2D"), true),
      uint: this.link(fragSource("usampler2D"), true),
      rgb: this.link(RGB_FRAG, false),
    };
    this.tex = null;
    this.texW = 0;
    this.texH = 0;
    this.texFormat = 0;
    // Pixel rows are tightly packed, so no row padding on upload
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
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

  private link(fragSrc: string, windowed: boolean): ProgramInfo {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, VERT);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragSrc);
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

    const loc = (name: string): WebGLUniformLocation => {
      const l = gl.getUniformLocation(prog, name);
      if (!l) throw new Error(`Missing shader uniform: ${name}`);
      return l;
    };
    const gray: GrayUniforms | null = windowed
      ? {
          uSlope: loc("uSlope"),
          uIntercept: loc("uIntercept"),
          uLo: loc("uLo"),
          uInvWidth: loc("uInvWidth"),
        }
      : null;
    return { prog, uTex: loc("uTex"), uFlip: loc("uFlip"), gray };
  }

  /** Uploads a slice to the GPU. Call once per slice, not per redraw. */
  upload(slice: SliceData): void {
    this.slice = slice;
    if (this.gl.isContextLost()) return; // re-uploaded on context restore
    this.uploadTexture(slice);
  }

  private uploadTexture(s: SliceData): void {
    const gl = this.gl;
    if (s.cols > this.maxSize || s.rows > this.maxSize) {
      throw new Error(
        `Image ${s.cols}x${s.rows} exceeds the maximum texture size (${this.maxSize})`,
      );
    }

    let internal: number;
    let format: number;
    let type: number;
    if (s.samples === 3) {
      internal = gl.RGB8;
      format = gl.RGB;
      type = gl.UNSIGNED_BYTE;
      this.kind = "rgb";
    } else if (s.bitsAllocated === 8) {
      internal = gl.R8UI;
      format = gl.RED_INTEGER;
      type = gl.UNSIGNED_BYTE;
      this.kind = "uint";
    } else if (s.signed) {
      internal = gl.R16I;
      format = gl.RED_INTEGER;
      type = gl.SHORT;
      this.kind = "int";
    } else {
      internal = gl.R16UI;
      format = gl.RED_INTEGER;
      type = gl.UNSIGNED_SHORT;
      this.kind = "uint";
    }

    if (!this.tex) {
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      // Integer textures cannot be filtered; the default filter would make them incomplete
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    if (this.texFormat === internal && this.texW === s.cols && this.texH === s.rows) {
      // Same layout as the previous slice: overwrite in place, no reallocation
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, s.cols, s.rows, format, type, s.pixels);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, s.cols, s.rows, 0, format, type, s.pixels);
      this.texFormat = internal;
      this.texW = s.cols;
      this.texH = s.rows;
    }
  }

  /** Redraws the uploaded slice. Only uniforms change, so this is cheap. */
  draw(p: DrawParams): void {
    const gl = this.gl;
    const s = this.slice;
    if (!s || !this.tex || gl.isContextLost()) return;

    const info = this.programs[this.kind];
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(info.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(info.uTex, 0);

    const g = info.gray;
    if (g) {
      gl.uniform1f(g.uSlope, s.slope);
      gl.uniform1f(g.uIntercept, s.intercept);
      gl.uniform1f(g.uLo, p.wl - p.ww / 2);
      gl.uniform1f(g.uInvWidth, 1 / Math.max(1, p.ww));
    }
    // MONOCHROME1 and the manual invert toggle cancel each other out
    // (monochrome1 is always false for colour images)
    gl.uniform1i(info.uFlip, s.monochrome1 !== p.invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}