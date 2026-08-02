// src/render/post.ts — the post-processing chain (art §7) and the auto-quality
// probe (arch §5).
//
// Two things live here, and they are related only through `Quality`: the effect
// chain each preset is made of, and the pure decision that picks a preset for a
// device. Both are exported as **data + pure functions** so `tests/render/
// post.test.ts` can pin them in the node environment, where there is no GL.
//
// ## Why the chain does not start with a `RenderPass` (measured, binding)
//
// Arch §5 describes the chain as "EffectComposer — Render → UnrealBloom →
// SMAA/FXAA → vignette/grade". The `Render` link is the one that cannot be
// taken literally in three 0.185.1, and the reason is a two-line rule in the
// renderer (`WebGLRenderer.js`, the `getProgram` path):
//
//     let toneMapping = NoToneMapping;
//     if ( material.toneMapped ) {
//       if ( _currentRenderTarget === null || … isXRRenderTarget … ) {
//         toneMapping = _this.toneMapping;
//       }
//     }
//
// i.e. **rendering into a render target disables tone mapping for every
// material**, on the assumption that an `OutputPass` will tone-map the finished
// frame instead. Art §3.0 is built on the opposite assumption: flat graphics
// (board, grid lattice, frame wall) carry `toneMapped = false` so the authored
// hex survives ACES *unchanged*, and the lit path is tone-mapped at the
// calibrated 0.70 exposure. A whole-frame `OutputPass` cannot express that split
// — ACES at exposure 0.70 maps the board's `#10121b` to `#020202` and the grid
// to the same, which is exactly the 1.07× "grid is invisible" contrast T2.2
// measured and §3.0 was written to fix.
//
// So the beauty pass still renders **straight to the drawing buffer**, exactly
// as T2.2/T2.3/T2.4 calibrated it, and the chain picks the finished frame up
// from there with `copyFramebufferToTexture` into a `FramebufferTexture` (a
// documented three pattern; `webgl_framebuffer_texture` is the example). The
// copy was measured **bit-identical** to the drawing buffer at DPR 2 with MSAA
// on — max per-channel delta 0 over 800×600 — so no calibration target can move
// because of the transport. Everything after it is a screen-space operation on
// the same LDR sRGB values art §6 measured, which is also why the chain is a
// strictly-after layer that `npm run calibrate:lighting` can measure with and
// without (see `docs/calibration/lighting.json`, rows `chain:…`).
//
// The cost of that choice is one full-frame GPU copy plus one blit per frame,
// which is what buys a calibration that provably cannot drift.
//
// ## Why bloom is layer-selective
//
// Art §8's emissive ruling (2026-08-02) says exactly two things glow: the
// **spawn star** and the **tier-3 barrel tip**, each one shared emissive
// material. `tankView.ts` puts those two meshes on {@link BLOOM_LAYER}; the
// bloom source is a render of that layer alone, so the selection is a property
// of the scene graph and cannot drift with the lighting.
//
// The alternative — one full-frame pass relying on a luminance threshold — was
// measured and is exactly as fragile as it sounds on a board calibrated this
// dark. In a High frame of a full board (`docs/calibration/post.json`): the
// brightest **non-emissive** pixel is 0.8168, and art §7's threshold of 0.85 is
// crossed by **18 pixels in the whole frame**, all of them emissive core. So a
// full-frame bloom at 0.85 is a no-op with 0.033 of headroom before lit steel
// starts glowing — and art §9's white hit-flash is still to come.

import {
  Color,
  FramebufferTexture,
  HalfFloatType,
  NoColorSpace,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { Quality } from './materials';

// ---------------------------------------------------------------------------
// The chain, as data (art §7)
// ---------------------------------------------------------------------------

/**
 * The scene layer the bloom source pass renders. Objects on it are drawn
 * **twice** — once in the beauty pass on layer 0, once alone into the bloom
 * source — so anything put here must be genuinely emissive and cheap.
 *
 * Layer 0 is every object's default and stays the beauty pass's layer; a mesh
 * that blooms *enables* this one rather than moving to it.
 */
export const BLOOM_LAYER = 1;

/**
 * Marker for the `?probe=post` diagnostic, bumped whenever the sizing rules
 * change. It exists so a pasted probe log proves which build produced it —
 * a stale Vite module graph or an un-hard-reloaded tab is otherwise
 * indistinguishable from a fix that did not work.
 */
const PROBE_BUILD = 'realBuffer-sizing + per-frame-guard (T3.2 fix 2)';

/** UnrealBloom's three knobs, art §7's row for the preset. */
export interface BloomConfig {
  readonly strength: number;
  readonly radius: number;
  /**
   * Luminance floor for the high-pass, applied to the **bloom source pass** —
   * which contains only {@link BLOOM_LAYER} objects on black. Selection is
   * therefore already done by the layer, and this number's only remaining job
   * is to reject the source pass's own anti-aliased edge pixels.
   */
  readonly threshold: number;
}

export type AntiAliasing = 'none' | 'fxaa' | 'smaa';

export interface PostPreset {
  /** `null` = no bloom pass at all (art §7's Low row). */
  readonly bloom: BloomConfig | null;
  readonly aa: AntiAliasing;
  /** Corner darkening, 0…1. `0` = no vignette/grade pass. */
  readonly vignette: number;
  /** Grade amount, 0…1 — teal shadows / warm highlights. `0` = neutral. */
  readonly grade: number;
}

/**
 * Art §7's threshold, recorded because the shipped value differs and the
 * difference is a **doc amendment request, not a code liberty**.
 *
 * §7 specifies 0.85 for a full-frame bloom. Measured, committed in
 * `docs/calibration/post.json`:
 *
 * | sample | luminance |
 * |---|---|
 * | spawn star `#7fc4ff` @ intensity 1, in the source pass | **0.5121** linear |
 * | tier tip `#ffd76b` @ intensity 0.7, in the source pass | **0.4965** linear |
 * | brightest non-emissive pixel, High beauty frame | 0.8168 |
 * | brightest pixel with both emissives on screen | 0.8661 |
 *
 * The source pass is the layer render — linear and un-tone-mapped — so 0.85
 * there catches **nothing at all**, and the pass would be dead code. (In the
 * beauty frame, where §7's full-frame reading would put it, 0.85 catches 18
 * pixels of emissive core and 0 pixels of anything else: technically alive,
 * but a no-op with 0.033 of headroom before lit steel joins in.)
 *
 * With the source pass restricted to {@link BLOOM_LAYER} the threshold is not
 * the selector anyway, so it drops to a value that only rejects blend edges.
 */
export const ART7_BLOOM = Object.freeze({
  /** What art §7 authored, kept as history — **not** what the chain uses. */
  supersededThreshold: 0.85,
  shipped: 0.0,
  reason:
    'nothing in the art §6 calibrated scene reaches 0.85 luminance; ' +
    'selection is by BLOOM_LAYER instead',
});

/**
 * Art §7, one row per preset. Medium's radius and vignette are not spelled out
 * in the doc ("Bloom (0.4) + FXAA + vignette") and inherit High's, so the only
 * difference between the two rows is the one §7 states.
 */
export const POST_PRESETS: Readonly<Record<Quality, PostPreset>> =
  Object.freeze({
    high: Object.freeze({
      bloom: Object.freeze({
        strength: 0.55,
        radius: 0.4,
        threshold: ART7_BLOOM.shipped,
      }),
      aa: 'smaa',
      vignette: 0.25,
      grade: 1,
    }),
    medium: Object.freeze({
      bloom: Object.freeze({
        strength: 0.4,
        radius: 0.4,
        threshold: ART7_BLOOM.shipped,
      }),
      aa: 'fxaa',
      vignette: 0.25,
      grade: 0,
    }),
    low: Object.freeze({
      bloom: null,
      aa: 'fxaa',
      vignette: 0,
      grade: 0,
    }),
  } satisfies Record<Quality, PostPreset>);

/** One link in the chain. `beauty` is the finished drawing buffer. */
export type PassKind = 'beauty' | 'bloom' | 'smaa' | 'fxaa' | 'grade';

/**
 * The passes a preset assembles, in order. Pure, so the test can compare the
 * chain against art §7's table without a GL context.
 */
export function passChain(preset: PostPreset): readonly PassKind[] {
  const kinds: PassKind[] = ['beauty'];
  if (preset.bloom !== null) {
    kinds.push('bloom');
  }
  if (preset.aa !== 'none') {
    kinds.push(preset.aa);
  }
  if (preset.vignette > 0 || preset.grade > 0) {
    kinds.push('grade');
  }
  return kinds;
}

/**
 * The grade, art §7: "slight teal shadows / warm highlights".
 *
 * Both the grade and the vignette are **multiplicative**, which is not a style
 * choice: a multiply preserves the *ratio* between two samples, so art §6's
 * calibration — every target of which is a ratio (rendered ÷ token, shadow ÷
 * lit) — survives the chain by construction rather than by luck. An additive
 * lift would raise the near-black board's floor and collapse the 1.88× grid
 * contrast §3.0 exists to protect.
 */
export const GRADE = Object.freeze({
  /** Per-channel gain at luminance 0 — cool/teal. */
  shadow: Object.freeze([0.96, 1.0, 1.05]) as readonly number[],
  /** Per-channel gain at luminance 1 — warm. */
  highlight: Object.freeze([1.05, 1.01, 0.95]) as readonly number[],
  /** Vignette starts here (0 = centre, 1 = corner) and reaches full at 1. */
  vignetteInner: 0.5,
});

const VIGNETTE_GRADE_SHADER = {
  name: 'VignetteGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    vignette: { value: 0 },
    grade: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  // `r` is normalised by `1 / length(vec2(0.5))` = √2, so it is 0 at the centre
  // and exactly **1 in the corners** at any aspect ratio. Getting that constant
  // wrong is not a subtle mistake: at 2/length(vec2(0.5)) the vignette reaches
  // full strength half way out and the mid-scanline edges measured 0.78 of
  // their unvignetted luminance instead of 0.96 (caught by `capture:post`).
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float grade;
    varying vec2 vUv;

    const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
    const vec3 SHADOW_GAIN = vec3( ${GRADE.shadow[0]}, ${GRADE.shadow[1]}, ${GRADE.shadow[2]} );
    const vec3 HIGHLIGHT_GAIN = vec3( ${GRADE.highlight[0]}, ${GRADE.highlight[1]}, ${GRADE.highlight[2]} );

    void main() {
      vec4 texel = texture2D( tDiffuse, vUv );
      vec3 c = texel.rgb;

      float l = clamp( dot( c, LUMA ), 0.0, 1.0 );
      c *= mix( vec3( 1.0 ), mix( SHADOW_GAIN, HIGHLIGHT_GAIN, l ), grade );

      float r = length( vUv - 0.5 ) * 1.4142135623730951;
      c *= 1.0 - vignette * smoothstep( ${GRADE.vignetteInner}, 1.0, r );

      gl_FragColor = vec4( c, texel.a );
    }`,
};

/**
 * Additive composite of the **glow alone** over the beauty.
 *
 * `tBloom` is `UnrealBloomPass.renderTargetsHorizontal[0]` — the composited mip
 * chain with `strength` and `radius` already applied, and **without** the
 * emissive source it was extracted from. That distinction is the whole of this
 * comment: the pass's own output buffer (the `readBuffer` it is handed) holds
 * `source + glow`, because with `renderToScreen === false` it blends its result
 * additively back into its input (`UnrealBloomPass.js:351-368`). Compositing
 * *that* over a beauty frame which already contains the source adds the emissive
 * core a second time at full strength — measured: it is what drove `#7fc4ff` to
 * pure white at the star's core, and no amount of tuning art §7's 0.55 fixes a
 * double-count.
 *
 * The add happens in **display space** while the blur happened in linear: light
 * spreads linearly, but an LDR add is what gives bloom its falloff — a bright
 * core saturates, while the far-field halo at 0.0037 adds one 255th and
 * disappears. Encoding the halo to sRGB first would turn that same 0.0037 into
 * 12/255 of haze across the whole board.
 */
const BLOOM_COMPOSITE_SHADER = {
  name: 'BloomCompositeShader',
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
  },
  vertexShader: VIGNETTE_GRADE_SHADER.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D( tDiffuse, vUv );
      gl_FragColor = vec4( base.rgb + texture2D( tBloom, vUv ).rgb, base.a );
    }`,
};

// ---------------------------------------------------------------------------
// Disposal, made observable without GL
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void;
}

/**
 * A single-occupant holder that **disposes whatever it replaces**.
 *
 * A preset switch swaps three of these (bloom pass, AA pass, grade pass) plus
 * the bloom's render target, and a leak there is invisible until the tab runs
 * out of GPU memory. Routing every replacement through one primitive means the
 * rule is written once and `tests/render/post.test.ts` can pin it against fake
 * disposables in the node environment, where the real passes cannot exist.
 */
export interface Slot<T extends Disposable> {
  readonly current: T | null;
  /** Replace the occupant; the previous one is disposed unless it IS `next`. */
  set(next: T | null): void;
  /** Dispose and empty. Idempotent. */
  clear(): void;
}

export function createSlot<T extends Disposable>(): Slot<T> {
  let held: T | null = null;
  // A closure, not a method: `clear()` used to call `this.set(null)`, which
  // silently depends on the slot never being destructured — `const { clear } =
  // slot` would have thrown on `this`.
  const set = (next: T | null): void => {
    if (held === next) {
      return;
    }
    // Ordered: drop the reference before disposing, so a dispose() that throws
    // cannot leave the slot pointing at a dead object.
    const previous = held;
    held = next;
    previous?.dispose();
  };
  return {
    get current(): T | null {
      return held;
    },
    set,
    clear(): void {
      set(null);
    },
  };
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export interface PostChain {
  /** Reconfigure to `preset`, disposing every effect it replaces. */
  setPreset(preset: PostPreset): void;
  /** `w`/`h` in CSS pixels — the same pair `renderer.resize` receives. */
  setSize(w: number, h: number): void;
  /**
   * Post-process the frame **currently in the drawing buffer**, in place. Call
   * it right after `renderer.render(scene, camera)`; skip it and the raw beauty
   * pass is already on screen, which is what makes the chain a strictly-after
   * layer (and what lets the calibration harness measure both).
   */
  render(): void;
  dispose(): void;
}

/**
 * Half-resolution bloom source. Standard for a blur chain (UnrealBloom's own
 * first mip is already half of whatever it is given) and it keeps the extra
 * scene traversal off the full-DPR pixel count.
 */
const BLOOM_SOURCE_SCALE = 0.5;

export function createPostChain(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
): PostChain {
  const composer = new EffectComposer(gl);
  // The composer never renders the scene: pass 0 is always the copied beauty.
  // `NoColorSpace` is deliberate — the copy holds the drawing buffer's own sRGB
  // bytes, and every pass below is a pure image operation on those values, so
  // marking it sRGB would make three decode to linear on sample and the frame
  // would come back brighter than the one art §6 measured.
  let beautyTexture = new FramebufferTexture(1, 1);
  beautyTexture.colorSpace = NoColorSpace;
  const beautyPass = new TexturePass(beautyTexture);
  composer.addPass(beautyPass);

  const bloomSlot = createSlot<UnrealBloomPass>();
  const bloomSourceSlot = createSlot<WebGLRenderTarget>();
  const bloomCompositeSlot = createSlot<ShaderPass>();
  const aaSlot = createSlot<Pass & Disposable>();
  const gradeSlot = createSlot<ShaderPass>();

  // Scratch — `render()` runs every frame and allocates nothing.
  const clearColour = new Color();
  // Diagnostic counters (see the probe block below). Two integer increments.
  let applySizeCalls = 0;
  let guardResyncs = 0;
  let cssW = 1;
  let cssH = 1;
  let preset: PostPreset = POST_PRESETS.low;

  function bloomSourceSize(): [number, number] {
    // Same real-buffer rule as the beauty texture: the bloom source is a
    // half-resolution render of the same frame, so it has to scale off what
    // the buffer actually is.
    const [w, h] = realBufferSize();
    return [
      Math.max(1, Math.floor(w * BLOOM_SOURCE_SCALE)),
      Math.max(1, Math.floor(h * BLOOM_SOURCE_SCALE)),
    ];
  }

  function buildBloom(config: BloomConfig): ShaderPass {
    const [w, h] = bloomSourceSize();
    // Half float: the source is a linear, un-tone-mapped render of the emissive
    // layer, and UnrealBloom's composite pushes a bright core well past 1.0
    // before the additive composite clips it.
    bloomSourceSlot.set(
      new WebGLRenderTarget(w, h, { type: HalfFloatType, depthBuffer: true }),
    );
    const bloom = new UnrealBloomPass(
      new Vector2(w, h),
      config.strength,
      config.radius,
      config.threshold,
    );
    bloomSlot.set(bloom);

    const composite = new ShaderPass(BLOOM_COMPOSITE_SHADER);
    // The GLOW, not the pass's output buffer — see BLOOM_COMPOSITE_SHADER. The
    // binding survives a resize: `UnrealBloomPass.setSize` calls `setSize` on
    // its existing targets rather than replacing them.
    composite.uniforms.tBloom.value = bloom.renderTargetsHorizontal[0].texture;
    bloomCompositeSlot.set(composite);
    return composite;
  }

  function buildGrade(): ShaderPass {
    const grade = new ShaderPass(VIGNETTE_GRADE_SHADER);
    grade.uniforms.vignette.value = preset.vignette;
    grade.uniforms.grade.value = preset.grade;
    gradeSlot.set(grade);
    return grade;
  }

  /**
   * Assembles the composer from {@link passChain} — the same ordered data the
   * test asserts against art §7. Driving the build from it rather than from a
   * parallel set of `if`s is the point: a chain that reordered AA and the grade
   * would otherwise leave every test green, because the test would be pinning a
   * re-statement of these conditionals instead of the chain itself.
   */
  function rebuildPasses(): void {
    // Passes are removed rather than disabled so the composer's ping-pong does
    // not spend a buffer swap on a pass that does nothing.
    for (const pass of [...composer.passes]) {
      composer.removePass(pass);
    }

    const kinds = passChain(preset);
    // Anything this preset does not use is disposed, not merely detached.
    if (!kinds.includes('bloom')) {
      bloomSlot.clear();
      bloomSourceSlot.clear();
      bloomCompositeSlot.clear();
    }
    if (!kinds.includes('smaa') && !kinds.includes('fxaa')) {
      aaSlot.clear();
    }
    if (!kinds.includes('grade')) {
      gradeSlot.clear();
    }

    for (const kind of kinds) {
      switch (kind) {
        case 'beauty':
          composer.addPass(beautyPass);
          break;
        case 'bloom':
          if (preset.bloom !== null) {
            composer.addPass(buildBloom(preset.bloom));
          }
          break;
        case 'smaa': {
          const smaa = new SMAAPass();
          aaSlot.set(smaa);
          composer.addPass(smaa);
          break;
        }
        case 'fxaa': {
          const fxaa = new FXAAPass();
          aaSlot.set(fxaa);
          composer.addPass(fxaa);
          break;
        }
        case 'grade':
          composer.addPass(buildGrade());
          break;
      }
    }

    applySize();
  }

  /**
   * The **real** drawing buffer, read off the GL context.
   *
   * Deliberately not `gl.getDrawingBufferSize()`. That method answers from
   * three's own bookkeeping — `three.module.js:16691`,
   * `target.set( _width * _pixelRatio, _height * _pixelRatio )` — which is what
   * the renderer *asked* for, not what the browser gave it. The two diverge
   * whenever the drawing buffer is reallocated behind three's back (a clamped
   * canvas size, a context restored at a different size, a second renderer
   * sharing the canvas with its own `_width`/`_pixelRatio`).
   *
   * That divergence is not cosmetic here, because of how the copy is specified
   * (`three.module.js:19233`):
   *
   *     const width  = Math.floor( texture.image.width  * levelScale );
   *     const height = Math.floor( texture.image.height * levelScale );
   *     _gl.copyTexSubImage2D( _gl.TEXTURE_2D, level, 0, 0, x, y, width, height );
   *
   * The copy rectangle comes from the **texture**, not from the framebuffer. So
   * a beauty texture bigger than the real buffer has only its bottom-left
   * corner written — GL clamps the read at the framebuffer edge — and the
   * `TexturePass` then stretches the *whole* texture across the screen. The
   * frame lands scaled by `realBuffer / textureSize` and anchored in the
   * corner: bottom-left in GL, which is **top-left on screen** after the v
   * flip, with the rest black.
   *
   * That is the failure mode reported against T3.2 — board small, anchored top
   * left — and it is invisible to every obvious check, because `canvas.width`,
   * `gl.drawingBufferWidth` and the GL viewport are all still correct. Only the
   * texture is wrong, and only relative to a number three keeps privately.
   */
  function realBufferSize(): [number, number] {
    const ctx = gl.getContext();
    return [
      Math.max(1, Math.floor(ctx.drawingBufferWidth)),
      Math.max(1, Math.floor(ctx.drawingBufferHeight)),
    ];
  }

  function applySize(): void {
    applySizeCalls++;
    const [dbw, dbh] = realBufferSize();

    // `FramebufferTexture` sizes its storage once, at first upload, so a resize
    // means a new texture — and the old one is a GPU allocation that has to go.
    const image = beautyTexture.image;
    if (image.width !== dbw || image.height !== dbh) {
      beautyTexture.dispose();
      beautyTexture = new FramebufferTexture(dbw, dbh);
      beautyTexture.colorSpace = NoColorSpace;
      beautyPass.map = beautyTexture;
      note('beautyTexture created', dbw, dbh);
    }

    composer.setPixelRatio(gl.getPixelRatio());
    composer.setSize(cssW, cssH);
    note('composer.setSize(css)', cssW, cssH);

    const source = bloomSourceSlot.current;
    if (source !== null) {
      const [bw, bh] = bloomSourceSize();
      source.setSize(bw, bh);
      // `UnrealBloomPass.setSize` resizes its existing mip targets rather than
      // replacing them, so the composite's `tBloom` binding stays valid.
      bloomSlot.current?.setSize(bw, bh);
    }
  }

  /** The emissive layer alone, on black — the bloom's source of truth. */
  function renderBloomSource(): void {
    const target = bloomSourceSlot.current;
    const bloom = bloomSlot.current;
    if (target === null || bloom === null) {
      return;
    }
    // Saved as a mask rather than restored with `layers.set(0)`: the camera's
    // enabled set is the caller's, and clobbering it here would be a bug that
    // only shows up when somebody else starts using layers.
    const mask = camera.layers.mask;
    const clearAlpha = gl.getClearAlpha();
    gl.getClearColor(clearColour);

    camera.layers.set(BLOOM_LAYER);
    // Pure black, fully transparent: the high-pass reads luminance, and the
    // renderer's own `#0a0a0a` clear would put a floor of 0.0033 under every
    // pixel of the frame — enough to bloom the whole board at this threshold.
    gl.setClearColor(0x000000, 0);
    gl.setRenderTarget(target);
    gl.clear();
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    // Extract → blur → composite the mips. The composite pass reads the mip
    // result (`renderTargetsHorizontal[0]`), **not** `target`: the last thing
    // this call does is blend the glow additively back into its own input, so
    // `target` ends the call holding `source + glow` and using it would add the
    // emissive core to a beauty frame that already has it. `writeBuffer` is
    // unused when the pass is not rendering to screen, hence the same target
    // twice. The blend-back is one wasted half-res quad; `target` is cleared and
    // re-rendered at the top of the next frame, so nothing carries over.
    bloom.render(gl, target, target, 0, false);

    gl.setRenderTarget(null);
    gl.setClearColor(clearColour, clearAlpha);
    camera.layers.mask = mask;
  }

  // -------------------------------------------------------------------------
  // TEMPORARY diagnostic — T3.2 follow-up, remove once the corner-anchored
  // blit is closed.
  //
  // The symptom is a frame drawn scaled and anchored top-left while
  // `canvas.width`, `gl.drawingBufferWidth` and the GL viewport all read
  // correct. That can only happen when something full-screen is sampled across
  // a texture whose valid content is a sub-rect of its allocation, so the
  // question is *which* member of the size ladder disagrees with the real
  // drawing buffer, and by how much. Reported ratio is exactly 2.0, which is
  // not `devicePixelRatio` (1.5) and not the Low DPR cap (1) — so it is a
  // number nobody has looked at yet.
  //
  // Every size the chain owns, in one place, logged whenever any of them
  // moves. Dev builds only, and inert unless `?probe=post` is in the URL.
  // -------------------------------------------------------------------------

  /**
   * A pass's resolution uniform, if it has one (FXAA does; SMAA does not).
   * FXAA's is the RECIPROCAL of the resolution, so the implied pixel size is
   * printed alongside — misreading `0.0011` as a size has fooled people before.
   */
  function passResolution(pass: Pass | null): string {
    const p = pass as unknown as {
      material?: {
        uniforms?: { resolution?: { value?: { x: number; y: number } } };
      };
    } | null;
    const v = p?.material?.uniforms?.resolution?.value;
    if (v === undefined) {
      return '—';
    }
    const implied =
      v.x > 0 && v.y > 0
        ? ` (implies ${Math.round(1 / v.x)} x ${Math.round(1 / v.y)})`
        : '';
    return `${v.x} x ${v.y}${implied}`;
  }

  function sizeLadder(): Record<string, string> {
    const ctx = gl.getContext();
    const believed = gl.getDrawingBufferSize(new Vector2());
    const cssSize = gl.getSize(new Vector2());
    const vp = ctx.getParameter(ctx.VIEWPORT) as Int32Array | null;
    const canvas = gl.domElement;
    const bloom = bloomSlot.current;
    const source = bloomSourceSlot.current;
    const rt1 = composer.renderTarget1;
    const rt2 = composer.renderTarget2;
    const wh = (w: number, h: number): string => `${w} x ${h}`;
    return {
      // A literal, so the log proves WHICH build produced it. If this field is
      // missing or reads anything else, the page is running pre-fix code — a
      // stale Vite module graph or a browser that did not hard-reload — and the
      // rest of the table is describing the old chain.
      'probe build': PROBE_BUILD,
      // How many times the per-frame guard in `render()` found the beauty
      // texture out of step with the real buffer and re-synced. Nonzero means
      // the buffer really is moving underneath the renderer; ZERO while the
      // frame is visibly wrong means the mis-sized member is something else in
      // this table, and the guard is looking at the wrong thing.
      'guard re-syncs': String(guardResyncs),
      'applySize calls': String(applySizeCalls),
      'REAL drawing buffer': wh(
        ctx.drawingBufferWidth,
        ctx.drawingBufferHeight,
      ),
      'three believes': wh(believed.x, believed.y),
      'beauty texture': wh(
        beautyTexture.image.width,
        beautyTexture.image.height,
      ),
      'composer rt1': wh(rt1.width, rt1.height),
      'composer rt2': wh(rt2.width, rt2.height),
      'bloom source rt':
        source === null ? '—' : wh(source.width, source.height),
      'bloom resolution':
        bloom === null ? '—' : wh(bloom.resolution.x, bloom.resolution.y),
      'aa resolution': passResolution(aaSlot.current),
      'gl VIEWPORT':
        vp === null ? '—' : `${vp[2]} x ${vp[3]} @ ${vp[0]},${vp[1]}`,
      // What three THINKS it set, rather than the GL state left by whatever
      // drew last. A divergence here is invisible to the raw VIEWPORT query.
      'three viewport': (() => {
        const v = gl.getViewport(new Vector4());
        return `${v.z} x ${v.w} @ ${v.x},${v.y}`;
      })(),
      'three scissor': (() => {
        const s = gl.getScissor(new Vector4());
        return `${s.z} x ${s.w} @ ${s.x},${s.y} test=${String(gl.getScissorTest())}`;
      })(),
      MAX_TEXTURE_SIZE: String(ctx.getParameter(ctx.MAX_TEXTURE_SIZE)),
      MAX_VIEWPORT_DIMS: Array.from(
        (ctx.getParameter(ctx.MAX_VIEWPORT_DIMS) as Int32Array | null) ?? [],
      ).join(' x '),
      MAX_RENDERBUFFER_SIZE: String(
        ctx.getParameter(ctx.MAX_RENDERBUFFER_SIZE),
      ),
      // The sizes objects were actually CREATED at, in order. If the newest
      // entry is older than the current buffer, something was allocated once
      // and never reallocated — the class of bug `getDrawingBufferSize` hid.
      'allocation history': allocLog.join('  |  ') || '(none recorded)',
      // Written by `sceneRoot.setViewport` (same URL flag). Read through a
      // global rather than an import so this diagnostic adds no dependency
      // between the chain and the scene graph.
      'camera fits':
        (
          globalThis as unknown as { __bcCameraFits?: readonly string[] }
        ).__bcCameraFits?.join('  |  ') ?? '(none recorded)',
      'GL error since last sample': glErrorSeen,
      'renderer css size': wh(cssSize.x, cssSize.y),
      'renderer pixelRatio': String(gl.getPixelRatio()),
      'post cssW/cssH': wh(cssW, cssH),
      'canvas attr': wh(canvas.width, canvas.height),
      'canvas client': wh(canvas.clientWidth, canvas.clientHeight),
      devicePixelRatio: String(globalThis.devicePixelRatio),
    };
  }

  let probeEnabled = false;
  let bypassChain = false;
  let lastLadder = '';
  let lastSampleMs = 0;
  let glErrorSeen = 'none';
  /** Sizes every GPU object was actually CREATED at, newest last. */
  const allocLog: string[] = [];

  function note(what: string, w: number, h: number): void {
    if (!probeEnabled) {
      return;
    }
    allocLog.push(`${allocLog.length}: ${what} ${w}x${h}`);
    if (allocLog.length > 8) {
      allocLog.shift();
    }
  }

  /**
   * The bounding box of everything brighter than the clear colour, read back
   * from the **default framebuffer**. Measured twice per sampled frame — once
   * on the beauty pass before the chain touches it, once on the finished frame
   * — because that pair is the whole experiment: if the board is correct in
   * `beauty` and collapsed in `final`, the chain did it and nothing upstream
   * is implicated; if it is already collapsed in `beauty`, the chain is
   * innocent and the cause is the camera, the viewport or the scene.
   */
  function measureBox(): string {
    const ctx = gl.getContext();
    const W = ctx.drawingBufferWidth;
    const H = ctx.drawingBufferHeight;
    const px = new Uint8Array(W * H * 4);
    ctx.readPixels(0, 0, W, H, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (px[i] > 16 || px[i + 1] > 16 || px[i + 2] > 16) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) {
      return `nothing drawn (buffer ${W}x${H})`;
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    // GL's origin is bottom-left; `topPx` is the same edge counted from the top
    // of the screen, so the anchor can be read without converting by hand.
    const topPx = H - 1 - y1;
    const anchor =
      `${x0 === 0 ? 'LEFT' : `x=${x0}`}/` +
      `${topPx === 0 ? 'TOP' : y0 === 0 ? 'BOTTOM' : `top=${topPx}`}`;
    return (
      `${w}x${h} at left=${x0} top=${topPx} (anchor ${anchor}) ` +
      `fill ${(w / W).toFixed(3)}x${(h / H).toFixed(3)} of ${W}x${H}`
    );
  }

  /** Rate-limited so the two readPixels calls cannot dominate the frame. */
  function wantsSample(): boolean {
    if (!probeEnabled) {
      return false;
    }
    const now = Date.now();
    if (now - lastSampleMs < 1000) {
      return false;
    }
    lastSampleMs = now;
    return true;
  }

  /**
   * The whole experiment in one line. `beautyBox` is the board as the beauty
   * pass drew it, straight off the drawing buffer before the chain has touched
   * anything; `finalBox` is the same measurement after the chain has run.
   *
   *   beauty CORRECT + final COLLAPSED → the post chain did it.
   *   beauty COLLAPSED                 → the chain is innocent; look at the
   *                                      camera, the viewport or the scene.
   *
   * No other reading of that pair is available, which is why it is worth two
   * `readPixels` a second.
   */
  function probe(beautyBox: string | null, finalBox: string | null): void {
    if (!probeEnabled) {
      return;
    }
    const ladder = sizeLadder();
    if (beautyBox !== null) {
      ladder['BOARD before chain'] = beautyBox;
      ladder['BOARD after chain'] = finalBox ?? '(chain bypassed)';
    }
    const signature = Object.values(ladder).join('|');
    // A sampled frame always speaks, because the two board boxes are the point
    // and they are not part of the "did a size move" question.
    if (signature === lastLadder && beautyBox === null) {
      return;
    }
    lastLadder = signature;
    const real = ladder['REAL drawing buffer'];
    const beauty = ladder['beauty texture'];
    console.log(
      `[post probe] real ${real}, beauty ${beauty}` +
        (real === beauty ? '' : '  *** BEAUTY != REAL ***') +
        (beautyBox === null ? '' : `\n  before chain: ${beautyBox}`) +
        (beautyBox === null
          ? ''
          : `\n  after  chain: ${finalBox ?? 'bypassed'}`),
    );
    console.table(ladder);
  }

  // Gated on the URL alone rather than on `import.meta.env.DEV`: this module is
  // compiled by BOTH tsconfig programs, and the node one (which owns `tests/`)
  // has no Vite ambient types, so `import.meta.env` does not typecheck here the
  // way it does in `main.ts`. Nothing is attached and nothing is logged unless
  // the flag is present, so the inert cost is one `String.includes` at startup.
  const search = globalThis.location?.search ?? '';
  probeEnabled = search.includes('probe=post');
  bypassChain = search.includes('nopost=1');
  if (probeEnabled) {
    (
      globalThis as unknown as { __bcPost?: () => Record<string, string> }
    ).__bcPost = sizeLadder;
    console.log(
      `[post probe] armed${bypassChain ? ' — CHAIN BYPASSED (?nopost=1)' : ''}`,
    );
  }

  rebuildPasses();

  return {
    setPreset(next: PostPreset): void {
      preset = next;
      rebuildPasses();
    },

    setSize(w: number, h: number): void {
      cssW = Math.max(1, Math.floor(w));
      cssH = Math.max(1, Math.floor(h));
      applySize();
    },

    render(): void {
      // Self-heal, once per frame, for two integer compares. `setSize` is only
      // called on a resize, so a drawing buffer that changes underneath the
      // renderer between resizes — a restored context, a backgrounded tab
      // whose buffer was released and reallocated — would otherwise stay
      // mismatched until the next resize happened to come along, and the frame
      // would be blitted scaled into a corner for all of that time (see
      // `realBufferSize`). Catching it here means the worst case is one bad
      // frame instead of an unbounded run of them.
      const [dbw, dbh] = realBufferSize();
      if (
        beautyTexture.image.width !== dbw ||
        beautyTexture.image.height !== dbh
      ) {
        guardResyncs++;
        applySize();
      }

      // Sampled at most once a second, and only under `?probe=post`.
      const sampling = wantsSample();
      const beautyBox = sampling ? measureBox() : null;

      // The beauty pass has already drawn to the canvas; copy it out before any
      // pass overwrites it. Bit-identical (measured), so nothing art §6 pinned
      // can move between `gl.render` and here.
      gl.copyFramebufferToTexture(beautyTexture);
      if (sampling) {
        const ctx = gl.getContext();
        const err = ctx.getError();
        glErrorSeen = err === ctx.NO_ERROR ? 'none' : `0x${err.toString(16)}`;
      }

      // `?nopost=1` stops here, leaving the raw beauty frame on screen. That is
      // the control for "is the chain doing this": the board either comes back
      // or it does not, and no amount of reasoning about texture sizes is
      // needed to tell which.
      if (bypassChain) {
        probe(beautyBox, null);
        return;
      }

      renderBloomSource();
      // Explicit `0`: no pass in this chain is time-dependent, and letting the
      // composer read its own `Timer` would make a frame's output depend on
      // when it was drawn — which a screenshot harness cannot reproduce.
      composer.render(0);

      probe(beautyBox, sampling ? measureBox() : null);
    },

    dispose(): void {
      bloomSlot.clear();
      bloomSourceSlot.clear();
      bloomCompositeSlot.clear();
      aaSlot.clear();
      gradeSlot.clear();
      beautyPass.dispose();
      beautyTexture.dispose();
      composer.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Auto quality (arch §5)
// ---------------------------------------------------------------------------

/** What the boot probe measures. Injected in tests — no real timing there. */
export interface DeviceSample {
  /** Frames per second over a ~1 s sample on the title/boot screen. */
  readonly fps: number;
  /** `devicePixelRatio`. */
  readonly dpr: number;
  /** `navigator.hardwareConcurrency`, or {@link ASSUMED_CORES} if absent. */
  readonly cores: number;
}

/**
 * The thresholds, in one frozen table because they are the whole decision and a
 * test pins them.
 *
 * `dpr` participates as a **cost**, not as a badge: High renders at up to DPR 2,
 * which is four times the fragments of DPR 1, so a HiDPI device is asked for
 * more cores before it is trusted with the top preset. (`hardwareConcurrency`
 * is a CPU count and a poor proxy for a GPU — but it is the signal arch §5
 * names, and it is the only one a browser offers without a benchmark.)
 */
export const AUTO_THRESHOLDS = Object.freeze({
  /** Below this the device is not keeping up even with nothing on screen. */
  lowFps: 45,
  /** At or above this, plus enough cores, earns High. */
  highFps: 55,
  /** Cores required for High at `dpr >= hiDpr`. */
  hiDprCores: 8,
  /** Cores required for High below it. */
  loDprCores: 4,
  hiDpr: 2,
});

/** `hardwareConcurrency` is optional; assume a modest middle when it is absent. */
export const ASSUMED_CORES = 4;

/** Pure. `'auto'` resolves through here and nowhere else. */
export function decideAutoQuality(sample: DeviceSample): Quality {
  if (sample.fps < AUTO_THRESHOLDS.lowFps) {
    return 'low';
  }
  const needed =
    sample.dpr >= AUTO_THRESHOLDS.hiDpr
      ? AUTO_THRESHOLDS.hiDprCores
      : AUTO_THRESHOLDS.loDprCores;
  if (sample.fps >= AUTO_THRESHOLDS.highFps && sample.cores >= needed) {
    return 'high';
  }
  return 'medium';
}

/**
 * The quality that needs **no probe**: a `?quality=` debug flag first, then a
 * concrete stored setting. `null` means the caller must sample the device and
 * hand the result to {@link decideAutoQuality}.
 *
 * The resolved value is deliberately **not** written back to settings: storing
 * it would silently convert a player's `'auto'` into a fixed preset on the
 * first boot, and a laptop that later grows a discrete GPU (or simply stops
 * being plugged into a 4K panel) would never re-probe. The override persists;
 * the *probe result* is per-session by design.
 */
export function concreteQuality(
  setting: 'auto' | Quality,
  override?: Quality,
): Quality | null {
  if (override !== undefined) {
    return override;
  }
  return setting === 'auto' ? null : setting;
}

/**
 * A ~`ms` frame-rate sample from `requestAnimationFrame`. Not unit-tested — it
 * is the one part of the probe that is pure timing, which is exactly why
 * {@link decideAutoQuality} takes the number instead of measuring it.
 */
export async function sampleDevice(
  win: Window,
  ms = 1000,
): Promise<DeviceSample> {
  const fps = await new Promise<number>((resolve) => {
    let frames = 0;
    const t0 = win.performance.now();
    const tick = (): void => {
      const elapsed = win.performance.now() - t0;
      if (elapsed >= ms) {
        // Guard the degenerate case: a backgrounded tab can fire one frame and
        // then jump the clock, and 1 frame / 0.001 s must not read as fast.
        resolve(elapsed > 0 ? (frames * 1000) / elapsed : 0);
        return;
      }
      frames++;
      win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
  });
  const cores = win.navigator.hardwareConcurrency;
  return {
    fps,
    dpr: win.devicePixelRatio || 1,
    cores: typeof cores === 'number' && cores > 0 ? cores : ASSUMED_CORES,
  };
}
