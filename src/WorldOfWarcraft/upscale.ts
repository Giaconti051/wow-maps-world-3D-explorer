import { fullscreenMegaState } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary.js";
import { GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode, type GfxProgram, type GfxSampler } from "../gfx/platform/GfxPlatform.js";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache.js";
import { GfxrAttachmentSlot, type GfxrGraphBuilder, type GfxrRenderTargetID } from "../gfx/render/GfxRenderGraph.js";
import type { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { preprocessProgram_GLSL } from "../gfx/shaderc/GfxShaderCompiler.js";

export enum WowUpscaleMode {
    Bilinear,
    Sharp,
    EdgeAdaptive,
}

function createProgram(cache: GfxRenderCache, mode: WowUpscaleMode): GfxProgram {
    const vert = GfxShaderLibrary.fullscreenVS;
    let filter = `return texture(PU_SAMPLER_2D(t_Texture), uv);`;

    if (mode === WowUpscaleMode.Sharp) {
        filter = `
    vec2 texel = 1.0 / vec2(textureSize(TEXTURE(t_Texture), 0));
    vec4 c = texture(PU_SAMPLER_2D(t_Texture), uv);
    vec4 n = texture(PU_SAMPLER_2D(t_Texture), uv + vec2(0.0, -texel.y));
    vec4 s = texture(PU_SAMPLER_2D(t_Texture), uv + vec2(0.0,  texel.y));
    vec4 e = texture(PU_SAMPLER_2D(t_Texture), uv + vec2( texel.x, 0.0));
    vec4 w = texture(PU_SAMPLER_2D(t_Texture), uv + vec2(-texel.x, 0.0));
    vec3 lo = min(c.rgb, min(min(n.rgb, s.rgb), min(e.rgb, w.rgb)));
    vec3 hi = max(c.rgb, max(max(n.rgb, s.rgb), max(e.rgb, w.rgb)));
    vec3 sharpened = c.rgb * 1.55 - (n.rgb + s.rgb + e.rgb + w.rgb) * 0.1375;
    return vec4(clamp(sharpened, lo, hi), c.a);`;
    } else if (mode === WowUpscaleMode.EdgeAdaptive) {
        // A compact EASU-style spatial reconstruction. It intentionally avoids
        // temporal history and motion vectors so it works on both WebGL 2 and WebGPU.
        filter = `
    vec2 size = vec2(textureSize(TEXTURE(t_Texture), 0));
    vec2 texel = 1.0 / size;
    vec2 p = uv * size - 0.5;
    vec2 f = fract(p);
    vec2 base = (floor(p) + 0.5) * texel;

    vec3 c00 = texture(PU_SAMPLER_2D(t_Texture), base).rgb;
    vec3 c10 = texture(PU_SAMPLER_2D(t_Texture), base + vec2(texel.x, 0.0)).rgb;
    vec3 c01 = texture(PU_SAMPLER_2D(t_Texture), base + vec2(0.0, texel.y)).rgb;
    vec3 c11 = texture(PU_SAMPLER_2D(t_Texture), base + texel).rgb;
    vec3 reconstructed = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);

    vec3 l = texture(PU_SAMPLER_2D(t_Texture), uv - vec2(texel.x, 0.0)).rgb;
    vec3 r = texture(PU_SAMPLER_2D(t_Texture), uv + vec2(texel.x, 0.0)).rgb;
    vec3 u = texture(PU_SAMPLER_2D(t_Texture), uv - vec2(0.0, texel.y)).rgb;
    vec3 d = texture(PU_SAMPLER_2D(t_Texture), uv + vec2(0.0, texel.y)).rgb;
    vec3 center = texture(PU_SAMPLER_2D(t_Texture), uv).rgb;
    vec2 gradient = vec2(dot(r - l, vec3(0.299, 0.587, 0.114)), dot(d - u, vec3(0.299, 0.587, 0.114)));
    float edge = clamp(length(gradient) * 3.0, 0.0, 1.0);

    vec3 lo = min(center, min(min(l, r), min(u, d)));
    vec3 hi = max(center, max(max(l, r), max(u, d)));
    vec3 sharpened = center * 1.6 - (l + r + u + d) * 0.15;
    sharpened = clamp(sharpened, lo, hi);
    vec3 color = mix(reconstructed, sharpened, 0.35 + edge * 0.35);
    return vec4(color, 1.0);`;
    }

    const frag = `
uniform sampler2D u_Texture;
in vec2 v_TexCoord;

vec4 upscale(PD_SAMPLER_2D(t_Texture), vec2 uv) {
    ${filter}
}

void main() {
    gl_FragColor = upscale(PP_SAMPLER_2D(u_Texture), v_TexCoord.xy);
}
`;

    return cache.createProgramSimple(preprocessProgram_GLSL(cache.device.queryVendorInfo(), vert, frag));
}

export class WowSpatialUpscaler {
    private programs: GfxProgram[];
    private sampler: GfxSampler;

    constructor(private renderCache: GfxRenderCache) {
        this.programs = [
            createProgram(renderCache, WowUpscaleMode.Bilinear),
            createProgram(renderCache, WowUpscaleMode.Sharp),
            createProgram(renderCache, WowUpscaleMode.EdgeAdaptive),
        ];
        this.sampler = renderCache.createSampler({
            wrapS: GfxWrapMode.Clamp,
            wrapT: GfxWrapMode.Clamp,
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
        });
    }

    public pushPass(builder: GfxrGraphBuilder, renderHelper: GfxRenderHelper, sourceTargetID: GfxrRenderTargetID, destinationTargetID: GfxrRenderTargetID, mode: WowUpscaleMode): void {
        builder.pushPass((pass) => {
            pass.setDebugName('WoW Spatial Upscale');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, destinationTargetID);

            const sourceResolveTextureID = builder.resolveRenderTarget(sourceTargetID);
            pass.attachResolveTexture(sourceResolveTextureID);

            const renderInst = renderHelper.renderInstManager.newRenderInst();
            renderInst.setUniformBuffer(renderHelper.uniformBuffer);
            renderInst.setAllowSkippingIfPipelineNotReady(false);
            renderInst.setMegaStateFlags(fullscreenMegaState);
            renderInst.setBindingLayouts([{ numUniformBuffers: 0, numSamplers: 1 }]);
            renderInst.setDrawCount(3);
            renderInst.setGfxProgram(this.programs[mode]);

            pass.exec((passRenderer, scope) => {
                renderInst.setSamplerBindingsFromTextureMappings([{
                    gfxTexture: scope.getResolveTextureForID(sourceResolveTextureID),
                    gfxSampler: this.sampler,
                }]);
                renderInst.drawOnPass(this.renderCache, passRenderer);
            });
        });
    }
}
