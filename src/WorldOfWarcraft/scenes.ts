import { mat4, ReadonlyMat4, vec3, vec4 } from "gl-matrix";
import type { ConvexHull } from "noclip-rust-support";
import { CameraController } from "../Camera.js";
import { AABB, Frustum } from "../Geometry.js";
import { getMatrixTranslation, invlerp, lerp, projectionMatrixForFrustum, setMatrixTranslation, transformVec3Mat4w1 } from "../MathHelpers.js";
import { SceneContext } from "../SceneBase.js";
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { GfxClipSpaceNearZ, GfxCullMode, GfxDevice, GfxPlatform, GfxProgram } from "../gfx/platform/GfxPlatform.js";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { gfxRenderInstCompareNone, GfxRenderInstExecutionOrder, GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { rust } from "../rustlib.js";
import { assert } from "../util.js";
import * as UI from "../ui.js";
import * as Viewer from "../viewer.js";
import { AdtCoord, AdtData, Database, DoodadData, LazyWorldData, ModelData, TerrainDetailLevel, WmoData, WmoDefinition, WorldData, WowCache } from "./data.js";
import { BaseProgram, ContinentalTerrainProgram, LoadingAdtProgram, ModelProgram, ParticleProgram, SkyboxProgram, TerrainProgram, WaterProgram, WmoProgram } from "./program.js";
import { LoadingAdtRenderer, ModelRenderer, SkyboxRenderer, TerrainRenderer, WaterRenderer, WmoRenderer } from "./render.js";
import { TextureCache } from "./tex.js";
import { WowSpatialUpscaler, WowUpscaleMode } from "./upscale.js";

export const MAP_SIZE = 17066;

export const placementSpaceFromAdtSpace: ReadonlyMat4 = mat4.fromValues(
    0, 0, -1, 0,
    -1, 0, 0, 0,
    0, 1, 0, 0,
    MAP_SIZE, 0, MAP_SIZE, 1,
);
// noclip space is placement space
const noclipSpaceFromAdtSpace = placementSpaceFromAdtSpace;

export const placementSpaceFromModelSpace: ReadonlyMat4 = mat4.fromValues(
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
);

export const adtSpaceFromPlacementSpace: ReadonlyMat4 = mat4.invert(mat4.create(), placementSpaceFromAdtSpace);
export const adtSpaceFromModelSpace: ReadonlyMat4 = mat4.mul(mat4.create(), adtSpaceFromPlacementSpace, placementSpaceFromModelSpace);

export const modelSpaceFromAdtSpace: ReadonlyMat4 = mat4.invert(mat4.create(), adtSpaceFromModelSpace);
export const modelSpaceFromPlacementSpace: ReadonlyMat4 = mat4.invert(mat4.create(), placementSpaceFromModelSpace);

const scratchVec3 = vec3.create();
export class View {
    // aka viewMatrix
    public viewFromWorldMatrix = mat4.create();
    // aka worldMatrix
    public worldFromViewMatrix = mat4.create();
    public clipFromWorldMatrix = mat4.create();
    // aka projectionMatrix
    public clipFromViewMatrix = mat4.create();
    public backbufferWidth: number;
    public backbufferHeight: number;
    public interiorSunDirection = vec4.fromValues(-0.30822, -0.30822, -0.9, 0);
    public exteriorDirectColorDirection = vec4.fromValues(-0.30822, -0.30822, -0.9, 0);
    public clipSpaceNearZ: GfxClipSpaceNearZ;
    public cameraPos = vec3.create();
    public time: number;
    public dayNight = 0;
    public deltaTime: number;
    public cullingNearPlane = 0.1;
    public cullingFarPlane = 10000;
    public cullingFrustum: Frustum = new Frustum();
    public timeOffset = 1440;
    public secondsPerGameDay = 90;
    public fogEnabled = true;
    public freezeTime = false;
    public frozenTime = 800;

    constructor() {}

    public finishSetup(): void {
        mat4.invert(this.worldFromViewMatrix, this.viewFromWorldMatrix);
        mat4.mul(this.clipFromWorldMatrix, this.clipFromViewMatrix, this.viewFromWorldMatrix);
        getMatrixTranslation(this.cameraPos, this.worldFromViewMatrix);
    }

    private calculateSunDirection(): void {
        const theta = 3.926991;
        const phiMin = 2.2165682;
        const phiMax = 1.9198623;
        let phi;
        if (this.dayNight < 0.25) {
            phi = lerp(phiMax, phiMin, invlerp(0.0, 0.25, this.dayNight));
        } else if (this.dayNight < 0.5) {
            phi = lerp(phiMin, phiMax, invlerp(0.25, 0.5, this.dayNight));
        } else if (this.dayNight < 0.75) {
            phi = lerp(phiMax, phiMin, invlerp(0.5, 0.75, this.dayNight));
        } else {
            phi = lerp(phiMin, phiMax, invlerp(0.75, 1.0, this.dayNight));
        }
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        vec4.set(this.exteriorDirectColorDirection, sinPhi * cosTheta, sinPhi * sinTheta, cosPhi, 0);
    }

    public cameraDistanceToWorldSpaceAABB(aabb: AABB): number {
        aabb.centerPoint(scratchVec3);
        return vec3.distance(this.cameraPos, scratchVec3);
    }

    public setupFromViewerInput(viewerInput: Viewer.ViewerRenderInput): void {
        this.backbufferWidth = viewerInput.backbufferWidth;
        this.backbufferHeight = viewerInput.backbufferHeight;

        this.cullingNearPlane = viewerInput.camera.near;
        this.clipSpaceNearZ = viewerInput.camera.clipSpaceNearZ;
        mat4.mul(this.viewFromWorldMatrix, viewerInput.camera.viewMatrix, noclipSpaceFromAdtSpace);
        mat4.copy(this.clipFromViewMatrix, viewerInput.camera.projectionMatrix);

        // Culling uses different near/far planes
        const clipFromViewMatrixCull = mat4.create();
        projectionMatrixForFrustum(
            clipFromViewMatrixCull,
            viewerInput.camera.left,
            viewerInput.camera.right,
            viewerInput.camera.bottom,
            viewerInput.camera.top,
            this.cullingNearPlane,
            this.cullingFarPlane,
        );
        const clipFromWorldMatrixCull = mat4.create();
        mat4.mul(clipFromWorldMatrixCull, clipFromViewMatrixCull, this.viewFromWorldMatrix);
        this.cullingFrustum.updateClipFrustum(clipFromWorldMatrixCull, GfxClipSpaceNearZ.NegativeOne);

        if (this.freezeTime) {
            this.time = this.frozenTime;
        } else {
            this.time = (viewerInput.time / this.secondsPerGameDay + this.timeOffset) % 2880;
        }
        this.dayNight = this.time / 2880.0;
        this.deltaTime = viewerInput.deltaTime;
        this.calculateSunDirection();
        this.finishSetup();
    }
}

enum CullingState {
    Running,
    Paused,
    OneShot,
};

enum CameraState {
    Frozen,
    Running,
};

// A set of all doodads, ADTs, WMOs, etc to render each frame
export class FrameData {
    public wmoDefGroups = new MapArray<number, number>(); // WmoDefinition uniqueId => [WMO groupId]
    public wmoDefs = new MapArray<number, WmoDefinition>(); // WMO fileId => [WmoDefinition]
    public doodads = new MapArray<number, DoodadData>(); // Model fileId => [DoodadData]
    public liquidIndices: number[] = []; // index into either WMO or ADT liquids array
    public adtChunkIndices = new MapArray<number, number>(); // ADT fileId => [chunk index]
    public activeWmoSkybox: number | null = null;
    public adtLiquids = new MapArray<number, number>(); // ADT fileId => [liquidIndex]
    public wmoLiquids = new MapArray<number, number>(); // WmoDefinition uniqueId => [liquidIndex]

    private wmoDefToDoodadIndices = new MapArray<number, number>(); // WmoDefinition uniqueId => [doodad index]
    private adtDoodadUniqueIds = new Set<number>();

    public addWmoDef(wmo: WmoData, def: WmoDefinition) {
        this.wmoDefs.append(wmo.fileId, def);
    }

    public addWmoGroup(wmo: WmoData, def: WmoDefinition, groupId: number, justWmo = false) {
        this.wmoDefGroups.append(def.uniqueId, groupId);
        if (justWmo)
            return;
        if (def.groupIdToDoodadIndices.has(groupId)) {
            for (let index of def.groupIdToDoodadIndices.get(groupId)) {
                this.addWmoDoodad(def, index);
            }
        }
        if (def.groupIdToLiquidIndices.has(groupId)) {
            for (let index of wmo.groupLiquids.get(groupId)) {
                this.addWmoDefLiquid(def, index);
            }
        }
    }

    public addWmoDoodad(def: WmoDefinition, index: number) {
        if (this.wmoDefToDoodadIndices.get(def.uniqueId).includes(index))
            return;
        const doodad = def.doodadIndexToDoodad.get(index)!;
        this.wmoDefToDoodadIndices.append(def.uniqueId, index);
        this.doodads.append(doodad.modelId, doodad);
    }

    public addAdtDoodad(doodad: DoodadData) {
        const uniqueId = doodad.uniqueId!;
        assert(uniqueId !== undefined);
        if (this.adtDoodadUniqueIds.has(uniqueId))
            return;
        this.adtDoodadUniqueIds.add(uniqueId);
        this.doodads.append(doodad.modelId, doodad);
    }

    public addWmoDefLiquid(def: WmoDefinition, liquidIndex: number) {
        this.wmoLiquids.append(def.uniqueId, liquidIndex);
    }

    public addAdtLiquid(adt: AdtData, liquidIndex: number) {
        this.adtLiquids.append(adt.fileId, liquidIndex);
    }

    public addAdtChunk(adt: AdtData, chunkIndex: number) {
        this.adtChunkIndices.append(adt.fileId, chunkIndex);
    }
}

export class MapArray<K, V> {
    public map: Map<K, V[]> = new Map();

    public has(key: K): boolean {
        return this.map.has(key);
    }

    public get(key: K): V[] {
        const result = this.map.get(key);
        if (result === undefined) {
            return [];
        }
        return result;
    }

    public entries(): IterableIterator<[K, V[]]> {
        return this.map.entries();
    }

    public appendUnique(key: K, value: V): void {
        if (this.map.has(key)) {
            const L = this.map.get(key)!;
            if (!L.includes(value)) L.push(value);
        } else {
            this.map.set(key, [value]);
        }
    }

    public append(key: K, value: V) {
        if (this.map.has(key)) {
            this.map.get(key)!.push(value);
        } else {
            this.map.set(key, [value]);
        }
    }

    public extend(key: K, values: V[]) {
        if (this.map.has(key)) {
            this.map.set(key, this.map.get(key)!.concat(values));
        } else {
            this.map.set(key, values);
        }
    }

    public keys(): IterableIterator<K> {
        return this.map.keys();
    }

    public values(): IterableIterator<V[]> {
        return this.map.values();
    }

    public remove(key: K, value: V): void {
        const values = this.map.get(key);
        if (values === undefined)
            return;
        const index = values.indexOf(value);
        if (index >= 0)
            values.splice(index, 1);
        if (values.length === 0)
            this.map.delete(key);
    }
}

interface AdtResourceRefs {
    modelIds: Set<number>;
    wmoIds: Set<number>;
    wmoDefs: Set<WmoDefinition>;
    doodads: Set<DoodadData>;
    activeLodLevels: Set<number>;
}

interface AdtLodRequest {
    adt: AdtData;
    lodLevel: number;
    distance: number;
}

interface WowArchaeologySettings {
    version: 1;
    atmosphericFog: boolean;
    particles: boolean;
    viewDistance: number;
    residentRadius: number;
    terrainDetailRadius: number;
    ultraTerrainLod: boolean;
    extremeTerrainLod: boolean;
    continentalTerrainLod: boolean;
    continentalTerrainDistance: number;
    reduceDistantTextures: boolean;
    distantTextureMinLod: number;
    objectDetailRadius: number;
    objectRadius: number;
    dynamicTime: boolean;
    timeOfDay: number;
    renderScale: number;
    upscaleMode: WowUpscaleMode;
}

const WOW_ARCHAEOLOGY_SETTINGS_KEY = 'wow-archaeology-settings-v1';

function savedNumber(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function savedBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

interface CullWmoResult {
    cameraState: CullCameraState,
    frustums?: ConvexHull[],
}

enum CullCameraState {
    CameraInsideAndExteriorVisible,
    CameraInside,
    CameraOutside,
}

export class WdtScene implements Viewer.SceneGfx {
    private terrainRenderers = new Map<number, TerrainRenderer>();
    private adtWaterRenderers = new Map<number, WaterRenderer>();
    private wmoWaterRenderers = new Map<number, WaterRenderer>();
    private modelRenderers = new Map<number, ModelRenderer>();
    private skyboxModelRenderers = new Map<string, ModelRenderer>();
    private wmoRenderers = new Map<number, WmoRenderer>();
    private wmoSkyboxRenderers = new Map<number, ModelRenderer>();
    private skyboxRenderer: SkyboxRenderer;
    private loadingAdtRenderer: LoadingAdtRenderer;
    private renderInstListMain = new GfxRenderInstList();
    private renderInstListSky = new GfxRenderInstList(gfxRenderInstCompareNone, GfxRenderInstExecutionOrder.Forwards);

    public ADT_LOD0_DISTANCE = 1000;
    public TERRAIN_HIGH_DETAIL_DISTANCE = 2000;
    public ULTRA_TERRAIN_LOD = false;
    public EXTREME_TERRAIN_LOD = false;
    public CONTINENTAL_TERRAIN_LOD = false;
    public CONTINENTAL_TERRAIN_DISTANCE = 4000;
    public REDUCE_DISTANT_TERRAIN_TEXTURES = false;
    public DISTANT_TERRAIN_TEXTURE_MIN_LOD = 3;
    public OBJECT_CULL_DISTANCE = 3000;
    public RENDER_SCALE = 1.0;
    public UPSCALE_MODE = WowUpscaleMode.EdgeAdaptive;

    private terrainProgram: GfxProgram;
    private continentalTerrainProgram: GfxProgram;
    private waterProgram: GfxProgram;
    private modelProgram: GfxProgram;
    private wmoProgram: GfxProgram;
    private skyboxProgram: GfxProgram;
    private loadingAdtProgram: GfxProgram;
    private particleProgram: GfxProgram;
    private spatialUpscaler: WowSpatialUpscaler;
    private smoothedFrameMs = 0;

    private modelIdToDoodads = new MapArray<number, DoodadData>();
    private wmoIdToDefs = new MapArray<number, WmoDefinition>();
    private adtResourceRefs = new Map<number, AdtResourceRefs>();
    private modelRefCounts = new Map<number, number>();
    private wmoRefCounts = new Map<number, number>();
    private wmoSkyboxRefCounts = new Map<number, number>();
    private wmoDefRefCounts = new Map<WmoDefinition, number>();
    private doodadRefCounts = new Map<DoodadData, number>();
    private adtLodQueue: AdtLodRequest[] = [];
    private adtLodWorkerRunning = false;
    private lastAdtLodQueueRefresh = 0;

    public mainView = new View();
    private textureCache: TextureCache;
    public enableProgressiveLoading = false;
    public currentAdtCoords: [number, number] = [0, 0];
    public loadingAdts: [number, number][] = [];

    public enableFog = false;
    public enableParticles = false;
    public cullingState = CullingState.Running;
    public cameraState = CameraState.Running;
    public frozenCamera = vec3.create();
    public frozenFrustum = new Frustum();
    private frozenFrameData: FrameData | null = null;
    private modelCamera = vec3.create();
    private modelFrustum: ConvexHull;

    private timeOfDayPanel: UI.TimeOfDayPanel | null = null;
    private diagnosticsElement: HTMLElement | null = null;
    private lastDiagnosticsText = '';
    private savedResidentRadius = 4;

    constructor(private device: GfxDevice, public world: WorldData | LazyWorldData, public renderHelper: GfxRenderHelper, private db: Database) {
        console.time("WdtScene construction");
        this.loadSettings();
        this.textureCache = new TextureCache(this.renderHelper.renderCache);
        this.terrainProgram = this.renderHelper.renderCache.createProgram(new TerrainProgram());
        this.continentalTerrainProgram = this.renderHelper.renderCache.createProgram(new ContinentalTerrainProgram());
        this.waterProgram = this.renderHelper.renderCache.createProgram(new WaterProgram());
        this.modelProgram = this.renderHelper.renderCache.createProgram(new ModelProgram());
        this.particleProgram = this.renderHelper.renderCache.createProgram(new ParticleProgram());
        this.wmoProgram = this.renderHelper.renderCache.createProgram(new WmoProgram());
        this.skyboxProgram = this.renderHelper.renderCache.createProgram(new SkyboxProgram());
        this.loadingAdtProgram = this.renderHelper.renderCache.createProgram(new LoadingAdtProgram());
        this.spatialUpscaler = new WowSpatialUpscaler(this.renderHelper.renderCache);

        this.setupSkyboxes();
        if (this.world.globalWmo) {
            this.mainView.freezeTime = true;
            this.setupWmoDef(this.world.globalWmoDef!);
            this.setupWmo(this.world.globalWmo);
        } else {
            for (let adt of this.world.adts) {
                this.setupAdt(adt);
            }
        }

        this.skyboxRenderer = new SkyboxRenderer(device, this.renderHelper);
        this.loadingAdtRenderer = new LoadingAdtRenderer(device, this.renderHelper);
        console.timeEnd("WdtScene construction");
    }

    private loadSettings(): void {
        try {
            const serialized = window.localStorage.getItem(WOW_ARCHAEOLOGY_SETTINGS_KEY);
            if (serialized === null)
                return;
            const settings = JSON.parse(serialized) as Partial<WowArchaeologySettings>;
            this.enableFog = savedBoolean(settings.atmosphericFog, this.enableFog);
            this.enableParticles = savedBoolean(settings.particles, this.enableParticles);
            this.mainView.cullingFarPlane = savedNumber(settings.viewDistance, this.mainView.cullingFarPlane, 1000, 20000);
            this.TERRAIN_HIGH_DETAIL_DISTANCE = savedNumber(settings.terrainDetailRadius, this.TERRAIN_HIGH_DETAIL_DISTANCE, 0, 10000);
            this.ULTRA_TERRAIN_LOD = savedBoolean(settings.ultraTerrainLod, this.ULTRA_TERRAIN_LOD);
            this.EXTREME_TERRAIN_LOD = savedBoolean(settings.extremeTerrainLod, this.EXTREME_TERRAIN_LOD);
            this.CONTINENTAL_TERRAIN_LOD = savedBoolean(settings.continentalTerrainLod, this.CONTINENTAL_TERRAIN_LOD);
            this.CONTINENTAL_TERRAIN_DISTANCE = savedNumber(settings.continentalTerrainDistance, this.CONTINENTAL_TERRAIN_DISTANCE, 0, 20000);
            this.REDUCE_DISTANT_TERRAIN_TEXTURES = savedBoolean(settings.reduceDistantTextures, this.REDUCE_DISTANT_TERRAIN_TEXTURES);
            this.DISTANT_TERRAIN_TEXTURE_MIN_LOD = savedNumber(settings.distantTextureMinLod, this.DISTANT_TERRAIN_TEXTURE_MIN_LOD, 1, 5);
            this.ADT_LOD0_DISTANCE = savedNumber(settings.objectDetailRadius, this.ADT_LOD0_DISTANCE, 0, 5000);
            this.OBJECT_CULL_DISTANCE = savedNumber(settings.objectRadius, this.OBJECT_CULL_DISTANCE, 500, 10000);
            this.mainView.freezeTime = !savedBoolean(settings.dynamicTime, !this.mainView.freezeTime);
            this.mainView.frozenTime = savedNumber(settings.timeOfDay, this.mainView.frozenTime / 2880, 0, 1) * 2880;
            this.savedResidentRadius = savedNumber(settings.residentRadius, this.savedResidentRadius, 2, 12);
            this.RENDER_SCALE = savedNumber(settings.renderScale, this.RENDER_SCALE, 0.33, 1.0);
            this.UPSCALE_MODE = savedNumber(settings.upscaleMode, this.UPSCALE_MODE, WowUpscaleMode.Bilinear, WowUpscaleMode.EdgeAdaptive) as WowUpscaleMode;
            if (this.world instanceof LazyWorldData)
                this.world.adtRadius = this.savedResidentRadius;
        } catch (e) {
            console.warn('Could not restore WoW Archaeology settings:', e);
        }
    }

    private saveSettings(): void {
        const settings: WowArchaeologySettings = {
            version: 1,
            atmosphericFog: this.enableFog,
            particles: this.enableParticles,
            viewDistance: this.mainView.cullingFarPlane,
            residentRadius: this.world instanceof LazyWorldData ? this.world.adtRadius : this.savedResidentRadius,
            terrainDetailRadius: this.TERRAIN_HIGH_DETAIL_DISTANCE,
            ultraTerrainLod: this.ULTRA_TERRAIN_LOD,
            extremeTerrainLod: this.EXTREME_TERRAIN_LOD,
            continentalTerrainLod: this.CONTINENTAL_TERRAIN_LOD,
            continentalTerrainDistance: this.CONTINENTAL_TERRAIN_DISTANCE,
            reduceDistantTextures: this.REDUCE_DISTANT_TERRAIN_TEXTURES,
            distantTextureMinLod: this.DISTANT_TERRAIN_TEXTURE_MIN_LOD,
            objectDetailRadius: this.ADT_LOD0_DISTANCE,
            objectRadius: this.OBJECT_CULL_DISTANCE,
            dynamicTime: !this.mainView.freezeTime,
            timeOfDay: this.mainView.frozenTime / 2880,
            renderScale: this.RENDER_SCALE,
            upscaleMode: this.UPSCALE_MODE,
        };
        try {
            window.localStorage.setItem(WOW_ARCHAEOLOGY_SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            console.warn('Could not save WoW Archaeology settings:', e);
        }
    }

    public setupWmoDef(def: WmoDefinition) {
        this.retainWmoDef(def);
    }

    public getDefaultWorldMatrix(dst: mat4): void {
        if ("startAdtCoords" in this.world) {
            // if we're in a continent scene
            const [startX, startY] = this.world.startAdtCoords;
            vec3.set(scratchVec3, (32 - startY) * 533.33, (32 - startX) * 533.33, 0);
            transformVec3Mat4w1(scratchVec3, noclipSpaceFromAdtSpace, scratchVec3);
            mat4.fromTranslation(dst, scratchVec3);
        } else if (this.world.globalWmoDef) {
            mat4.getTranslation(scratchVec3, this.world.globalWmoDef!.modelMatrix);
            transformVec3Mat4w1(scratchVec3, noclipSpaceFromAdtSpace, scratchVec3);
            mat4.fromTranslation(dst, scratchVec3);
        } else {
            assert(this.world.adts.length > 0);
            this.world.adts[this.world.adts.length - 1].worldSpaceAABB.centerPoint(scratchVec3);
            transformVec3Mat4w1(scratchVec3, noclipSpaceFromAdtSpace, scratchVec3);
            mat4.fromTranslation(dst, scratchVec3);
        }
    }

    public async setupSkyboxes() {
        for (const skybox of this.world.skyboxes) {
            assert(skybox.modelData !== undefined);
            assert(skybox.modelFileId !== undefined);
            if (!this.skyboxModelRenderers.has(skybox.filename)) {
                this.skyboxModelRenderers.set(skybox.filename, new ModelRenderer(this.device, skybox.modelData, this.renderHelper, this.textureCache));
            }
        }
    }

    public setupAdt(adt: AdtData) {
        if (this.terrainRenderers.has(adt.fileId))
            return;

        this.terrainRenderers.set(adt.fileId, new TerrainRenderer(this.device, this.renderHelper, adt, this.textureCache));
        this.adtWaterRenderers.set(adt.fileId, new WaterRenderer(this.device, this.renderHelper, adt.liquids, adt.liquidTypes, this.textureCache));
        const refs: AdtResourceRefs = {
            modelIds: new Set(),
            wmoIds: new Set(),
            wmoDefs: new Set(),
            doodads: new Set(),
            activeLodLevels: new Set(),
        };
        this.adtResourceRefs.set(adt.fileId, refs);
        for (let lodLevel = 0; lodLevel < adt.lodData.length; lodLevel++)
            this.setupAdtLod(adt, lodLevel);
    }

    private setupAdtLod(adt: AdtData, lodLevel: number): void {
        if (!adt.hasLodLevel(lodLevel))
            return;
        const refs = this.adtResourceRefs.get(adt.fileId);
        if (refs === undefined)
            return;
        if (refs.activeLodLevels.has(lodLevel))
            return;
        const lodData = adt.lodData[lodLevel];
        for (const modelId of lodData.modelIds) {
            if (!refs.modelIds.has(modelId)) {
                refs.modelIds.add(modelId);
                this.retainModel(adt.models.get(modelId)!);
            }
        }
        for (const wmoDef of lodData.wmoDefs) {
            if (!refs.wmoIds.has(wmoDef.wmoId)) {
                refs.wmoIds.add(wmoDef.wmoId);
                this.retainWmo(adt.wmos.get(wmoDef.wmoId)!);
            }
            if (!refs.wmoDefs.has(wmoDef)) {
                refs.wmoDefs.add(wmoDef);
                this.retainWmoDef(wmoDef);
            }
        }
        for (const doodad of lodData.doodads) {
            if (!refs.doodads.has(doodad)) {
                refs.doodads.add(doodad);
                this.retainDoodad(doodad);
            }
        }
        refs.activeLodLevels.add(lodLevel);
    }

    private releaseAdtObjectRefs(adt: AdtData): void {
        const refs = this.adtResourceRefs.get(adt.fileId);
        if (!refs)
            return;
        for (const doodad of refs.doodads)
            this.releaseDoodad(doodad);
        for (const def of refs.wmoDefs)
            this.releaseWmoDef(def);
        for (const wmoId of refs.wmoIds)
            this.releaseWmo(adt.wmos.get(wmoId)!);
        for (const modelId of refs.modelIds)
            this.releaseModel(modelId);
        refs.doodads.clear();
        refs.wmoDefs.clear();
        refs.wmoIds.clear();
        refs.modelIds.clear();
        refs.activeLodLevels.clear();
    }

    private setAdtActiveLods(adt: AdtData, desiredLodLevels: number[]): void {
        const refs = this.adtResourceRefs.get(adt.fileId);
        if (!refs)
            return;
        const desired = desiredLodLevels.filter((lodLevel) => adt.hasLodLevel(lodLevel));
        const alreadyActive = desired.length === refs.activeLodLevels.size &&
            desired.every((lodLevel) => refs.activeLodLevels.has(lodLevel));
        if (alreadyActive)
            return;
        this.releaseAdtObjectRefs(adt);
        for (const lodLevel of desired)
            this.setupAdtLod(adt, lodLevel);
    }

    public setupWmo(wmo: WmoData) {
        this.retainWmo(wmo);
    }

    private retainModel(model: ModelData): void {
        const count = this.modelRefCounts.get(model.fileId) ?? 0;
        this.modelRefCounts.set(model.fileId, count + 1);
        if (count === 0)
            this.createModelRenderer(model);
    }

    private releaseModel(modelId: number): void {
        const count = this.modelRefCounts.get(modelId);
        if (count === undefined)
            return;
        if (count > 1) {
            this.modelRefCounts.set(modelId, count - 1);
            return;
        }
        this.modelRefCounts.delete(modelId);
        const renderer = this.modelRenderers.get(modelId);
        if (renderer) {
            renderer.destroy(this.device);
            this.modelRenderers.delete(modelId);
        }
    }

    private retainWmo(wmo: WmoData): void {
        const count = this.wmoRefCounts.get(wmo.fileId) ?? 0;
        this.wmoRefCounts.set(wmo.fileId, count + 1);
        if (count > 0)
            return;

        this.wmoRenderers.set(wmo.fileId, new WmoRenderer(this.device, wmo, this.textureCache, this.renderHelper));
        this.wmoWaterRenderers.set(wmo.fileId, new WaterRenderer(this.device, this.renderHelper, wmo.liquids, wmo.liquidTypes, this.textureCache));
        for (let model of wmo.models.values())
            this.retainModel(model);
        if (wmo.skyboxModel)
            this.retainWmoSkybox(wmo.skyboxModel);
    }

    private releaseWmo(wmo: WmoData): void {
        const count = this.wmoRefCounts.get(wmo.fileId);
        if (count === undefined)
            return;
        if (count > 1) {
            this.wmoRefCounts.set(wmo.fileId, count - 1);
            return;
        }
        this.wmoRefCounts.delete(wmo.fileId);
        this.wmoRenderers.get(wmo.fileId)?.destroy(this.device);
        this.wmoRenderers.delete(wmo.fileId);
        this.wmoWaterRenderers.get(wmo.fileId)?.destroy(this.device);
        this.wmoWaterRenderers.delete(wmo.fileId);
        for (const model of wmo.models.values())
            this.releaseModel(model.fileId);
        if (wmo.skyboxModel)
            this.releaseWmoSkybox(wmo.skyboxModel.fileId);
    }

    private retainWmoSkybox(model: ModelData): void {
        const count = this.wmoSkyboxRefCounts.get(model.fileId) ?? 0;
        this.wmoSkyboxRefCounts.set(model.fileId, count + 1);
        if (count === 0)
            this.wmoSkyboxRenderers.set(model.fileId, new ModelRenderer(this.device, model, this.renderHelper, this.textureCache));
    }

    private releaseWmoSkybox(modelId: number): void {
        const count = this.wmoSkyboxRefCounts.get(modelId);
        if (count === undefined)
            return;
        if (count > 1) {
            this.wmoSkyboxRefCounts.set(modelId, count - 1);
            return;
        }
        this.wmoSkyboxRefCounts.delete(modelId);
        this.wmoSkyboxRenderers.get(modelId)?.destroy(this.device);
        this.wmoSkyboxRenderers.delete(modelId);
    }

    public createModelRenderer(model: ModelData) {
        if (!this.modelRenderers.has(model.fileId))
            this.modelRenderers.set(model.fileId, new ModelRenderer(this.device, model, this.renderHelper, this.textureCache));
    }

    private retainDoodad(doodad: DoodadData): void {
        const count = this.doodadRefCounts.get(doodad) ?? 0;
        this.doodadRefCounts.set(doodad, count + 1);
        if (count === 0)
            this.modelIdToDoodads.appendUnique(doodad.modelId, doodad);
    }

    private releaseDoodad(doodad: DoodadData): void {
        const count = this.doodadRefCounts.get(doodad);
        if (count === undefined)
            return;
        if (count > 1) {
            this.doodadRefCounts.set(doodad, count - 1);
            return;
        }
        this.doodadRefCounts.delete(doodad);
        this.modelIdToDoodads.remove(doodad.modelId, doodad);
    }

    private retainWmoDef(def: WmoDefinition): void {
        const count = this.wmoDefRefCounts.get(def) ?? 0;
        this.wmoDefRefCounts.set(def, count + 1);
        if (count > 0)
            return;
        this.wmoIdToDefs.appendUnique(def.wmoId, def);
        for (const doodad of def.doodadIndexToDoodad.values())
            this.retainDoodad(doodad);
    }

    private releaseWmoDef(def: WmoDefinition): void {
        const count = this.wmoDefRefCounts.get(def);
        if (count === undefined)
            return;
        if (count > 1) {
            this.wmoDefRefCounts.set(def, count - 1);
            return;
        }
        this.wmoDefRefCounts.delete(def);
        this.wmoIdToDefs.remove(def.wmoId, def);
        for (const doodad of def.doodadIndexToDoodad.values())
            this.releaseDoodad(doodad);
    }

    private unloadAdt(adt: AdtData): void {
        this.terrainRenderers.get(adt.fileId)?.destroy(this.device);
        this.terrainRenderers.delete(adt.fileId);
        this.adtWaterRenderers.get(adt.fileId)?.destroy(this.device);
        this.adtWaterRenderers.delete(adt.fileId);

        this.releaseAdtObjectRefs(adt);
        this.adtResourceRefs.delete(adt.fileId);
        this.adtLodQueue = this.adtLodQueue.filter((request) => request.adt !== adt);
    }

    public freezeCamera() {
        this.cameraState = CameraState.Frozen;
        vec3.copy(this.frozenCamera, this.mainView.cameraPos);
        this.frozenFrustum.copy(this.mainView.cullingFrustum);
    }

    public getCameraAndFrustum(): [vec3, Frustum] {
        if (this.cameraState === CameraState.Frozen) {
            return [this.frozenCamera, this.frozenFrustum];
        } else {
            return [this.mainView.cameraPos, this.mainView.cullingFrustum];
        }
    }

    public unfreezeCamera() {
        this.cameraState = CameraState.Running;
    }

    public freezeCulling(oneShot = false) {
        this.cullingState = oneShot ? CullingState.OneShot : CullingState.Paused;
    }

    public unfreezeCulling() {
        this.cullingState = CullingState.Running;
        this.frozenFrameData = null;
    }

    public cull() {
        const frame = new FrameData();
        if (this.world.globalWmo) {
            this.cullWmoDef(frame, this.world.globalWmoDef!, this.world.globalWmo);
            return frame;
        }

        const [worldCamera, worldFrustum] = this.getCameraAndFrustum();

        // Do a first pass and get candidate WMOs the camera's inside of,
        // disable WMOs not in the frustum, and determine if any ADTs are
        // visible based on where the camera is
        const wmosToCull: Map<number, [WmoData, WmoDefinition]> = new Map();
        const candidateAdts: AdtData[] = [];
        const objectAdts = new Set<AdtData>();
        for (let adt of this.world.adts) {
            adt.worldSpaceAABB.centerPoint(scratchVec3);
            const distance = vec3.distance(worldCamera, scratchVec3);
            // An ADT is roughly 533 m wide. Avoid all object/WMO work for
            // resident tiles that cannot possibly reach the far plane.
            if (distance > this.mainView.cullingFarPlane + 800)
                continue;
            candidateAdts.push(adt);
            const terrainDistance = adt.worldSpaceAABB.distFromClosestPoint(worldCamera);
            adt.terrainDetailLevel = terrainDistance < this.TERRAIN_HIGH_DETAIL_DISTANCE ? TerrainDetailLevel.High :
                this.CONTINENTAL_TERRAIN_LOD && terrainDistance >= this.CONTINENTAL_TERRAIN_DISTANCE ? TerrainDetailLevel.Continental :
                this.EXTREME_TERRAIN_LOD ? TerrainDetailLevel.Extreme :
                this.ULTRA_TERRAIN_LOD ? TerrainDetailLevel.Ultra : TerrainDetailLevel.Low;
            adt.setLodLevel(distance < this.ADT_LOD0_DISTANCE ? 0 : 1);
            if (distance <= this.OBJECT_CULL_DISTANCE + 800) {
                objectAdts.add(adt);
                adt.setupWmoCandidates(worldCamera, worldFrustum);
            } else {
                // Keep the far ring terrain-only. Clear the previous frame's
                // candidates so a tile that moved out of range cannot leak WMOs.
                adt.insideWmoCandidates = [];
                adt.visibleWmoCandidates = [];
            }

            for (let def of adt.insideWmoCandidates) {
                const wmo = adt.wmos.get(def.wmoId)!;
                wmosToCull.set(def.uniqueId, [wmo, def]);
            }
        }

        let exteriorVisible = true;
        let exteriorFrustums: ConvexHull[] = [];
        for (let [wmo, def] of wmosToCull.values()) {
            const result = this.cullWmoDef(frame, def, wmo);
            if (result.cameraState === CullCameraState.CameraInside) {
                exteriorVisible = false;
            } else if (result.cameraState === CullCameraState.CameraInsideAndExteriorVisible) {
                for (let frustum of result.frustums!) {
                    frustum.js_transform(def.modelMatrix as Float32Array);
                    exteriorFrustums.push(frustum);
                }
            }
        }

        function aabbIsVisible(aabb: AABB): boolean {
            if (exteriorFrustums.length > 0) {
                return exteriorFrustums.some(frustum => frustum.js_contains_aabb(
                    aabb.min[0],
                    aabb.min[1],
                    aabb.min[2],
                    aabb.max[0],
                    aabb.max[1],
                    aabb.max[2],
                ));
            } else {
                return worldFrustum.contains(aabb);
            }
        }

        const wmosAlreadyCulled = Array.from(wmosToCull.keys());
        wmosToCull.clear();
        for (let adt of candidateAdts) {
            if (exteriorVisible) {
                if (aabbIsVisible(adt.worldSpaceAABB)) {
                    for (let i = 0; i < adt.chunkData.length; i++) {
                        const chunk = adt.chunkData[i];
                        if (aabbIsVisible(chunk.worldSpaceAABB)) {
                            frame.addAdtChunk(adt, i);
                        }
                    }
                    for (let i = 0; i < adt.liquids.length; i++) {
                        const liquid = adt.liquids[i];
                        if (aabbIsVisible(liquid.worldSpaceAABB)) {
                            frame.addAdtLiquid(adt, i);
                        }
                    }
                    if (objectAdts.has(adt)) {
                        for (let doodad of adt.lodDoodads()) {
                            if (aabbIsVisible(doodad.worldAABB)) {
                                frame.addAdtDoodad(doodad);
                            }
                        }
                    }
                }
                if (objectAdts.has(adt)) {
                    for (let def of adt.visibleWmoCandidates) {
                        const wmo = adt.wmos.get(def.wmoId)!;
                        if (aabbIsVisible(def.worldAABB) && !wmosAlreadyCulled.includes(def.uniqueId)) {
                            wmosToCull.set(def.uniqueId, [wmo, def]);
                        }
                    }
                }
            }
        }

        for (let [wmo, def] of wmosToCull.values()) {
            this.cullWmoDef(frame, def, wmo);
        }

        for (let frustum of exteriorFrustums) {
            frustum.free();
        }
        return frame;
    }

    public cullWmoDef(frame: FrameData, def: WmoDefinition, wmo: WmoData): CullWmoResult {
        const [worldCamera, worldFrustum] = this.getCameraAndFrustum();

        // Check if we're looking at this particular world-space WMO, then do the
        // rest of culling in model space
        if (!worldFrustum.contains(def.worldAABB)) {
            return { cameraState: CullCameraState.CameraOutside };
        }

        frame.addWmoDef(wmo, def);

        vec3.transformMat4(this.modelCamera, worldCamera, def.invPlacementMatrix);
        this.modelFrustum = worldFrustum.getRust().copy();
        this.modelFrustum.js_transform(def.invPlacementMatrix as Float32Array);

        // Find groups the camera's a member of (i.e. within), or
        // if they're merely in the frustum. Also record if we started in an
        // interiod group or not, and whether any member groups have a skybox
        let startedInInteriorGroup = false;
        let frustumGroups: number[] = [];
        let memberGroups: number[] = [];
        const memberGroupId = wmo.wmo.find_group_for_modelspace_point(this.modelCamera as Float32Array);
        if (memberGroupId !== undefined) {
            const group = wmo.groupDescriptors[wmo.groupIdToIndex.get(memberGroupId)!];
            if (group.show_skybox && wmo.skyboxModel) {
                frame.activeWmoSkybox = wmo.skyboxModel.fileId;
            }
            if (!group.exterior) {
                startedInInteriorGroup = true;
            }
            memberGroups.push(group.group_id);
        }
        for (let group of wmo.groupDescriptors) {
            if (group.exterior && wmo.wmo.group_in_modelspace_frustum(group.group_id, this.modelFrustum)) {
                frustumGroups.push(group.group_id);
            }
            if (group.always_draw) {
                frame.addWmoGroup(wmo, def, group.group_id);
            }
        }

        // if we're a member of any groups, either traverse from just those groups,
        // or if we started in an exterior group, include the frustum groups as well.
        let rootGroups: number[];
        if (memberGroups.length > 0) {
            if (startedInInteriorGroup) {
                rootGroups = memberGroups;
            } else {
                rootGroups = memberGroups.concat(frustumGroups);
            }
        } else {
            rootGroups = frustumGroups;
        }

        // If we still don't have any groups, the user might be flying out of
        // bounds, just render the WMO geometry without doodads/liquids
        if (rootGroups.length === 0) {
            for (let group of wmo.groupDescriptors) {
                frame.addWmoGroup(wmo, def, group.group_id, true);
            }
            return { cameraState: CullCameraState.CameraOutside };
        }

        // do portal culling on the root groups to build our visible set
        let visibleGroups: Set<number> = new Set();
        let exteriorFrustums: ConvexHull[] = [];
        for (let groupId of rootGroups) {
            let groups = wmo.wmo.find_visible_groups(
                groupId,
                this.modelCamera as Float32Array,
                this.modelFrustum,
                exteriorFrustums
            );
            for (let visibleGroup of groups) {
                visibleGroups.add(visibleGroup);
            }
        }

        // determine if we have any exterior groups in the visible set...
        let hasExternalGroup = false;
        for (let groupId of visibleGroups) {
            const group = wmo.getGroup(groupId)!;
            if (group.exterior) {
                hasExternalGroup = true;
            }
            frame.addWmoGroup(wmo, def, groupId);
        }

        // ...and if we do, add in the frustum groups as well
        if (hasExternalGroup) {
            for (let groupId of frustumGroups) {
                frame.addWmoGroup(wmo, def, groupId);
            }
        }

        // finally, return a value describing the state of the camera w.r.t.
        // these groups
        if (startedInInteriorGroup) {
            if (hasExternalGroup) {
                return { cameraState: CullCameraState.CameraInsideAndExteriorVisible, frustums: exteriorFrustums };
            } else {
                return { cameraState: CullCameraState.CameraInside };
            }
        } else {
            return { cameraState: CullCameraState.CameraOutside };
        }
    }

    private prepareToRender(): void {
        const renderInstManager = this.renderHelper.renderInstManager;

        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(BaseProgram.bindingLayouts);
        template.setMegaStateFlags({ cullMode: GfxCullMode.Back });
        template.setGfxProgram(this.skyboxProgram);

        this.renderHelper.debugDraw.beginFrame(this.mainView.clipFromViewMatrix, this.mainView.viewFromWorldMatrix, this.mainView.backbufferWidth, this.mainView.backbufferHeight);

        const lightingData = this.db.getGlobalLightingData(this.world.lightdbMapId, this.mainView.cameraPos, this.mainView.time);
        BaseProgram.layoutUniformBufs(template, this.mainView, lightingData);
        renderInstManager.setCurrentList(this.renderInstListSky);
        this.skyboxRenderer.prepareToRenderSkybox(renderInstManager);

        template.setGfxProgram(this.loadingAdtProgram);
        renderInstManager.setCurrentList(this.renderInstListMain);
        this.loadingAdtRenderer.update(this.mainView);
        this.loadingAdtRenderer.prepareToRenderLoadingBox(renderInstManager, this.loadingAdts);

        const frame = this.frozenFrameData !== null ? this.frozenFrameData : this.cull();

        for (let renderer of this.terrainRenderers.values()) {
            template.setGfxProgram(renderer.adt.terrainDetailLevel === TerrainDetailLevel.Continental ? this.continentalTerrainProgram : this.terrainProgram);
            renderer.prepareToRenderTerrain(
                renderInstManager,
                frame,
                this.REDUCE_DISTANT_TERRAIN_TEXTURES,
                this.DISTANT_TERRAIN_TEXTURE_MIN_LOD,
            );
        }

        template.setGfxProgram(this.wmoProgram);
        for (let renderer of this.wmoRenderers.values()) {
            renderer.prepareToRenderWmo(renderInstManager, frame);
        }

        template.setGfxProgram(this.waterProgram);
        for (let [adtFileId, renderer] of this.adtWaterRenderers.entries()) {
            renderer.update(this.mainView);
            renderer.prepareToRenderAdtWater(renderInstManager, frame, adtFileId);
        }
        for (let [wmoId, renderer] of this.wmoWaterRenderers.entries()) {
            renderer.update(this.mainView);
            renderer.prepareToRenderWmoWater(renderInstManager, frame, wmoId);
        }

        template.setGfxProgram(this.modelProgram);
        renderInstManager.setCurrentList(this.renderInstListSky);
        if (frame.activeWmoSkybox !== null) {
            const renderer = this.wmoSkyboxRenderers.get(frame.activeWmoSkybox);
            if (!renderer) {
                console.warn(
                    `couldn't find WMO skybox renderer for ${frame.activeWmoSkybox}`,
                );
            } else {
                renderer.update(this.mainView);
                renderer.prepareToRenderSkybox(renderInstManager, 1.0);
            }
        } else {
            const skyboxes = lightingData.get_skyboxes();
            for (let skybox of skyboxes) {
                const name = skybox.name;
                const renderer = this.skyboxModelRenderers.get(name);
                if (!renderer) {
                    console.warn(`couldn't find skybox renderer for "${name}"`);
                    continue;
                }
                renderer.update(this.mainView);
                renderer.prepareToRenderSkybox(renderInstManager, skybox.weight);

                skybox.free();
            }
        }
        renderInstManager.setCurrentList(this.renderInstListMain);

        for (let [modelId, renderer] of this.modelRenderers.entries()) {
            const doodads = frame.doodads
                .get(modelId)!
                .filter((doodad) => doodad.visible)
                .filter((doodad) => {
                    const dist = this.mainView.cameraDistanceToWorldSpaceAABB(doodad.worldAABB);
                    return dist < this.mainView.cullingFarPlane;
                });
            if (doodads.length === 0) continue;

            template.setGfxProgram(this.modelProgram);
            renderer.update(this.mainView);
            renderer.prepareToRenderModel(renderInstManager, doodads);

            if (this.enableParticles && renderer.model.particleEmitters.length > 0) {
                template.setGfxProgram(this.particleProgram);
                renderer.prepareToRenderParticles(renderInstManager, doodads);
            }
        }

        renderInstManager.popTemplate();
        this.renderHelper.prepareToRender();

        if (this.cullingState === CullingState.OneShot) {
            this.cullingState = CullingState.Paused;
        }

        if (this.cullingState === CullingState.Paused && this.frozenFrameData === null) {
            this.frozenFrameData = frame;
        }

        lightingData.free();
    }

    private refreshAdtLodQueue(force = false): void {
        if (!(this.world instanceof LazyWorldData))
            return;
        const now = performance.now();
        if (!force && now - this.lastAdtLodQueueRefresh < 500)
            return;
        this.lastAdtLodQueueRefresh = now;

        const requests: AdtLodRequest[] = [];
        for (const adt of this.world.adts) {
            const distance = adt.worldSpaceAABB.distFromClosestPoint(this.mainView.cameraPos);
            if (distance > this.OBJECT_CULL_DISTANCE) {
                this.setAdtActiveLods(adt, []);
                continue;
            }

            // LOD 1 is always the first object stage. LOD 0 is requested only
            // after the far representation exists and only near the camera.
            if (!adt.hasLodLevel(1) && !adt.isLoadingLodLevel(1)) {
                requests.push({ adt, lodLevel: 1, distance });
                this.setAdtActiveLods(adt, []);
                continue;
            }

            const wantsHighDetail = distance <= this.ADT_LOD0_DISTANCE;
            if (wantsHighDetail && !adt.hasLodLevel(0) && !adt.isLoadingLodLevel(0))
                requests.push({ adt, lodLevel: 0, distance });

            this.setAdtActiveLods(adt, wantsHighDetail ? [1, 0] : [1]);
        }

        requests.sort((a, b) => a.distance - b.distance || b.lodLevel - a.lodLevel);
        this.adtLodQueue = requests;
        this.pumpAdtLodQueue();
    }

    private pumpAdtLodQueue(): void {
        if (this.adtLodWorkerRunning)
            return;
        const request = this.adtLodQueue.shift();
        if (request === undefined)
            return;

        this.adtLodWorkerRunning = true;
        void request.adt.loadLod(this.world.cache, request.lodLevel).then(() => {
            if (this.world.adts.includes(request.adt))
                this.refreshAdtLodQueue(true);
        }).catch((e) => {
            console.error(`failed to load ADT object LOD ${request.lodLevel}:`, e);
        }).finally(() => {
            this.adtLodWorkerRunning = false;
            this.refreshAdtLodQueue(true);
        });
    }

    private updateCurrentAdt(force = false) {
        const adtCoords = this.getCurrentAdtCoords();
        if (adtCoords) {
            if (force || this.currentAdtCoords[0] !== adtCoords[0] || this.currentAdtCoords[1] !== adtCoords[1]) {
                this.currentAdtCoords = adtCoords;
                if (this.enableProgressiveLoading && "onEnterAdt" in this.world) {
                    const newCoords = this.world.onEnterAdt(
                        this.currentAdtCoords,
                        (coord: AdtCoord, maybeAdt: AdtData | undefined) => {
                            this.loadingAdts = this.loadingAdts.filter(([x, y]) => !(x === coord[0] && y === coord[1]));
                            if (maybeAdt) {
                                this.setupAdt(maybeAdt);
                                this.refreshAdtLodQueue(true);
                            }
                        },
                        (_coord: AdtCoord, adt: AdtData) => {
                            this.unloadAdt(adt);
                        },
                    );
                    for (let coord of newCoords) {
                        this.loadingAdts.push(coord);
                    }
                    this.refreshAdtLodQueue(true);
                }
            }
        }
    }

    public getCurrentAdtCoords(): [number, number] | undefined {
        const [worldY, worldX, _] = this.mainView.cameraPos;
        const adt_dimension = 533.33;
        const x_coord = Math.floor(32 - worldX / adt_dimension);
        const y_coord = Math.floor(32 - worldY / adt_dimension);
        if (x_coord >= 0 && x_coord < 64 && y_coord >= 0 && y_coord < 64) {
            return [x_coord, y_coord];
        }
        return undefined;
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(0.01);
    }

    public dbgTeleportWorldSpaceCoord(pos: vec3) {
        vec3.transformMat4(pos, pos, noclipSpaceFromAdtSpace);
        const wmtx = window.main.viewer.camera.worldMatrix;
        setMatrixTranslation(wmtx, pos);
        console.log(`Teleported to: ${pos}`);
    }

    public debugTeleport() {
        const worldPos = vec3.create();
        if (this.world.globalWmoDef) {
            this.world.globalWmoDef!.worldAABB.centerPoint(worldPos);
        } else {
            this.world.adts[this.world.adts.length - 1].worldSpaceAABB.centerPoint(worldPos);
        }
        this.dbgTeleportWorldSpaceCoord(worldPos);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        if (viewerInput.deltaTime > 0 && viewerInput.deltaTime < 250)
            this.smoothedFrameMs = this.smoothedFrameMs === 0 ? viewerInput.deltaTime : lerp(this.smoothedFrameMs, viewerInput.deltaTime, 0.08);
        viewerInput.camera.setClipPlanes(0.1, this.mainView.cullingFarPlane);
        this.mainView.fogEnabled = this.enableFog;
        this.mainView.setupFromViewerInput(viewerInput);
        this.updateCurrentAdt();
        this.refreshAdtLodQueue();
        this.updateDiagnostics();

        if (this.timeOfDayPanel !== null && !this.mainView.freezeTime) {
            this.timeOfDayPanel.setTime(this.mainView.time / 2880);
        }

        const scaledRenderInput = {
            backbufferWidth: Math.max(1, Math.floor(viewerInput.backbufferWidth * this.RENDER_SCALE)),
            backbufferHeight: Math.max(1, Math.floor(viewerInput.backbufferHeight * this.RENDER_SCALE)),
            antialiasingMode: viewerInput.antialiasingMode,
        };
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, scaledRenderInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, scaledRenderInput, standardFullClearRenderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, "Main Color");
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, "Main Depth");
        builder.pushPass((pass) => {
            const skyDepthTargetID = builder.createRenderTargetID(mainDepthDesc, "Sky Depth");
            pass.setDebugName("Sky");
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, skyDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListSky.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });

        builder.pushPass((pass) => {
            pass.setDebugName("Main");
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        this.renderHelper.debugDraw.pushPasses(builder, mainColorTargetID, mainDepthTargetID);
        this.renderHelper.antialiasingSupport.pushPasses(builder, scaledRenderInput, mainColorTargetID);
        if (this.RENDER_SCALE < 0.995) {
            const outputColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
            const outputColorTargetID = builder.createRenderTargetID(outputColorDesc, 'Upscaled Color');
            this.spatialUpscaler.pushPass(builder, this.renderHelper, mainColorTargetID, outputColorTargetID, this.UPSCALE_MODE);
            builder.resolveRenderTargetToExternalTexture(outputColorTargetID, viewerInput.onscreenTexture);
        } else {
            builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);
        }

        this.prepareToRender();
        builder.execute();
        this.renderInstListMain.reset();
        this.renderInstListSky.reset();
    }

    private updateDiagnostics(): void {
        if (this.diagnosticsElement === null)
            return;
        const platform = this.device.queryVendorInfo().platform === GfxPlatform.WebGPU ? 'WebGPU' : 'WebGL 2';
        const cache = this.world.cache.dataFetcher.cacheStats;
        const cacheErrors = cache.readErrors + cache.writeErrors;
        const lodLoading = this.adtLodQueue.length + (this.adtLodWorkerRunning ? 1 : 0);
        let terrainHigh = 0, terrainLow = 0, terrainUltra = 0, terrainExtreme = 0, terrainContinental = 0;
        for (const adt of this.world.adts) {
            if (adt.terrainDetailLevel === TerrainDetailLevel.High)
                terrainHigh++;
            else if (adt.terrainDetailLevel === TerrainDetailLevel.Low)
                terrainLow++;
            else if (adt.terrainDetailLevel === TerrainDetailLevel.Ultra)
                terrainUltra++;
            else if (adt.terrainDetailLevel === TerrainDetailLevel.Extreme)
                terrainExtreme++;
            else
                terrainContinental++;
        }
        const textureMode = this.REDUCE_DISTANT_TERRAIN_TEXTURES ? `mip ${this.DISTANT_TERRAIN_TEXTURE_MIN_LOD}+` : 'full';
        const fps = this.smoothedFrameMs > 0 ? (1000 / this.smoothedFrameMs).toFixed(0) : '--';
        const sourceWidth = Math.max(1, Math.floor((this.mainView.backbufferWidth || 1) * this.RENDER_SCALE));
        const sourceHeight = Math.max(1, Math.floor((this.mainView.backbufferHeight || 1) * this.RENDER_SCALE));
        const upscaleName = ['bilinear', 'sharp', 'edge-adaptive'][this.UPSCALE_MODE];
        const text = `GPU: ${platform} | FPS: ${fps} (${this.smoothedFrameMs.toFixed(1)} ms) | Render: ${Math.round(this.RENDER_SCALE * 100)}% ${sourceWidth}x${sourceHeight}${this.RENDER_SCALE < 0.995 ? ` -> ${upscaleName}` : ''}\nADTs: ${this.world.adts.length} | Terrain HD/LD/U/X/C: ${terrainHigh}/${terrainLow}/${terrainUltra}/${terrainExtreme}/${terrainContinental} | Far textures: ${textureMode} | Models: ${this.modelRenderers.size} | WMOs: ${this.wmoRenderers.size} | Terrain queue: ${this.loadingAdts.length} | Object queue: ${lodLoading}\nCache hit/miss: ${cache.hits}/${cache.misses} | Network: ${cache.networkRequests} | Writes: ${cache.writes} | Errors: ${cacheErrors}`;
        if (text !== this.lastDiagnosticsText) {
            this.diagnosticsElement.textContent = text;
            this.lastDiagnosticsText = text;
        }
    }

    public createPanels(): UI.Panel[] {
        // Global WMO scenes do not use the continent streaming controls. A
        // manually frozen time-of-day is not an interior scene and must not
        // hide the Archaeology panel after settings are restored.
        if (this.world.globalWmo) {
            return [];
        }

        const archaeologyPanel = new UI.Panel();
        archaeologyPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        archaeologyPanel.setTitle(UI.RENDER_HACKS_ICON, 'World Explorer Settings');

        const cacheNotice = document.createElement('div');
        cacheNotice.textContent = 'Downloads and viewer settings stay on disk; distant resources are released.';
        cacheNotice.style.color = '#bbb';
        cacheNotice.style.fontSize = '13px';
        cacheNotice.style.paddingBottom = '6px';
        archaeologyPanel.contents.appendChild(cacheNotice);

        const fogCheckbox = new UI.Checkbox('Atmospheric fog', this.enableFog);
        fogCheckbox.onchanged = () => {
            this.enableFog = fogCheckbox.checked;
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(fogCheckbox.elem);

        const particlesCheckbox = new UI.Checkbox('Particles', this.enableParticles);
        particlesCheckbox.onchanged = () => {
            this.enableParticles = particlesCheckbox.checked;
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(particlesCheckbox.elem);

        const renderScaleSlider = new UI.Slider(`Render scale: ${Math.round(this.RENDER_SCALE * 100)}%`, Math.round(this.RENDER_SCALE * 100), 33, 100);
        renderScaleSlider.setRange(33, 100, 1);
        renderScaleSlider.onvalue = (percentage: number) => {
            this.RENDER_SCALE = percentage / 100;
            renderScaleSlider.setLabel(`Render scale: ${percentage}%`);
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(renderScaleSlider.elem);

        const upscaleButtons = new UI.RadioButtons('Upscaler', ['Bilinear', 'Sharp', 'Edge-adaptive']);
        upscaleButtons.setSelectedIndex(this.UPSCALE_MODE);
        upscaleButtons.onselectedchange = () => {
            this.UPSCALE_MODE = upscaleButtons.selectedIndex as WowUpscaleMode;
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(upscaleButtons.elem);

        const viewDistanceSlider = new UI.Slider(`View distance: ${(this.mainView.cullingFarPlane / 1000).toFixed(1)} km`, this.mainView.cullingFarPlane, 1000, 20000);
        viewDistanceSlider.setRange(1000, 20000, 500);
        viewDistanceSlider.onvalue = (distance: number) => {
            this.mainView.cullingFarPlane = distance;
            viewDistanceSlider.setLabel(`View distance: ${(distance / 1000).toFixed(1)} km`);
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(viewDistanceSlider.elem);

        if (this.world instanceof LazyWorldData) {
            const lazyWorld = this.world;
            const radius = lazyWorld.adtRadius;
            const streamRadiusSlider = new UI.Slider(`Resident radius: ${radius} tiles`, radius, 2, 12);
            streamRadiusSlider.setRange(2, 12, 1);
            streamRadiusSlider.onvalue = (newRadius: number) => {
                lazyWorld.adtRadius = newRadius;
                this.savedResidentRadius = newRadius;
                streamRadiusSlider.setLabel(`Resident radius: ${newRadius} tiles (~${(newRadius * 0.533).toFixed(1)} km)`);
                this.updateCurrentAdt(true);
                this.saveSettings();
            };
            archaeologyPanel.contents.appendChild(streamRadiusSlider.elem);
        }

        const terrainDetailSlider = new UI.Slider(`Terrain detail radius: ${(this.TERRAIN_HIGH_DETAIL_DISTANCE / 1000).toFixed(1)} km`, this.TERRAIN_HIGH_DETAIL_DISTANCE, 0, 10000);
        terrainDetailSlider.setRange(0, 10000, 250);
        terrainDetailSlider.onvalue = (distance: number) => {
            this.TERRAIN_HIGH_DETAIL_DISTANCE = distance;
            terrainDetailSlider.setLabel(`Terrain detail radius: ${(distance / 1000).toFixed(1)} km`);
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(terrainDetailSlider.elem);

        const ultraTerrainCheckbox = new UI.Checkbox('Ultra terrain LOD (distant)', this.ULTRA_TERRAIN_LOD);
        ultraTerrainCheckbox.onchanged = () => {
            this.ULTRA_TERRAIN_LOD = ultraTerrainCheckbox.checked;
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(ultraTerrainCheckbox.elem);

        const extremeTerrainCheckbox = new UI.Checkbox('Extreme terrain LOD (overrides Ultra)', this.EXTREME_TERRAIN_LOD);
        extremeTerrainCheckbox.onchanged = () => {
            this.EXTREME_TERRAIN_LOD = extremeTerrainCheckbox.checked;
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(extremeTerrainCheckbox.elem);

        const continentalTerrainCheckbox = new UI.Checkbox('Continental terrain LOD (one draw per ADT)', this.CONTINENTAL_TERRAIN_LOD);
        continentalTerrainCheckbox.onchanged = () => {
            this.CONTINENTAL_TERRAIN_LOD = continentalTerrainCheckbox.checked;
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(continentalTerrainCheckbox.elem);

        const continentalDistanceSlider = new UI.Slider(`Continental radius: ${(this.CONTINENTAL_TERRAIN_DISTANCE / 1000).toFixed(1)} km`, this.CONTINENTAL_TERRAIN_DISTANCE, 0, 20000);
        continentalDistanceSlider.setRange(0, 20000, 250);
        continentalDistanceSlider.onvalue = (distance: number) => {
            this.CONTINENTAL_TERRAIN_DISTANCE = distance;
            continentalDistanceSlider.setLabel(`Continental radius: ${(distance / 1000).toFixed(1)} km`);
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(continentalDistanceSlider.elem);

        const reduceTexturesCheckbox = new UI.Checkbox('Reduce distant texture detail', this.REDUCE_DISTANT_TERRAIN_TEXTURES);
        reduceTexturesCheckbox.onchanged = () => {
            this.REDUCE_DISTANT_TERRAIN_TEXTURES = reduceTexturesCheckbox.checked;
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(reduceTexturesCheckbox.elem);

        const textureLodSlider = new UI.Slider(`Distant texture reduction: ${this.DISTANT_TERRAIN_TEXTURE_MIN_LOD} level${this.DISTANT_TERRAIN_TEXTURE_MIN_LOD === 1 ? '' : 's'}`, this.DISTANT_TERRAIN_TEXTURE_MIN_LOD, 1, 5);
        textureLodSlider.setRange(1, 5, 1);
        textureLodSlider.onvalue = (lod: number) => {
            this.DISTANT_TERRAIN_TEXTURE_MIN_LOD = lod;
            textureLodSlider.setLabel(`Distant texture reduction: ${lod} level${lod === 1 ? '' : 's'}`);
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(textureLodSlider.elem);

        const lodDistanceSlider = new UI.Slider(`Object detail radius: ${(this.ADT_LOD0_DISTANCE / 1000).toFixed(1)} km`, this.ADT_LOD0_DISTANCE, 0, 5000);
        lodDistanceSlider.setRange(0, 5000, 250);
        lodDistanceSlider.onvalue = (distance: number) => {
            this.ADT_LOD0_DISTANCE = distance;
            lodDistanceSlider.setLabel(`Object detail radius: ${(distance / 1000).toFixed(1)} km`);
            this.refreshAdtLodQueue(true);
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(lodDistanceSlider.elem);

        const objectDistanceSlider = new UI.Slider(`Object radius: ${(this.OBJECT_CULL_DISTANCE / 1000).toFixed(1)} km`, this.OBJECT_CULL_DISTANCE, 500, 10000);
        objectDistanceSlider.setRange(500, 10000, 250);
        objectDistanceSlider.onvalue = (distance: number) => {
            this.OBJECT_CULL_DISTANCE = distance;
            objectDistanceSlider.setLabel(`Object radius: ${(distance / 1000).toFixed(1)} km`);
            this.refreshAdtLodQueue(true);
            this.saveSettings();
        };
        archaeologyPanel.contents.appendChild(objectDistanceSlider.elem);

        this.diagnosticsElement = document.createElement('div');
        this.diagnosticsElement.style.color = '#9fd3ff';
        this.diagnosticsElement.style.fontSize = '12px';
        this.diagnosticsElement.style.lineHeight = '1.4';
        this.diagnosticsElement.style.paddingTop = '8px';
        archaeologyPanel.contents.appendChild(this.diagnosticsElement);
        this.updateDiagnostics();

        this.timeOfDayPanel = new UI.TimeOfDayPanel();
        this.timeOfDayPanel.setDynamicTime(!this.mainView.freezeTime);
        const panelTime = this.mainView.freezeTime || !Number.isFinite(this.mainView.time) ? this.mainView.frozenTime : this.mainView.time;
        this.timeOfDayPanel.setTime(panelTime / 2880);

        this.timeOfDayPanel.onvaluechange = (t: number, useDynamicTime: boolean) => {
            if (useDynamicTime) {
                this.mainView.freezeTime = false;
            } else {
                this.mainView.freezeTime = true;
                this.mainView.frozenTime = t * 2880;
            }
            this.saveSettings();
        };

        return [archaeologyPanel, this.timeOfDayPanel];
    }

    public destroy(device: GfxDevice): void {
        this.saveSettings();
        for (let renderer of this.terrainRenderers.values()) {
            renderer.destroy(device);
        }
        for (let renderer of this.modelRenderers.values()) {
            renderer.destroy(device);
        }
        for (let renderer of this.wmoRenderers.values()) {
            renderer.destroy(device);
        }
        for (let renderer of this.adtWaterRenderers.values()) {
            renderer.destroy(device);
        }
        for (let renderer of this.wmoWaterRenderers.values()) {
            renderer.destroy(device);
        }
        for (let renderer of this.skyboxModelRenderers.values()) {
            renderer.destroy(device);
        }
        for (let renderer of this.wmoSkyboxRenderers.values()) {
            renderer.destroy(device);
        }
        this.loadingAdtRenderer.destroy(device);
        this.skyboxRenderer.destroy(device);
        this.textureCache.destroy(device);
        this.renderHelper.destroy();
    }
}

class WdtSceneDesc implements Viewer.SceneDesc {
    public id: string;

    constructor(public name: string, public fileId: number, public lightdbMapId: number) {
        this.id = `${name}-${fileId}`;
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const dataFetcher = context.dataFetcher;
        const cache = await context.dataShare.ensureObject(
            `${vanillaSceneGroup.id}/WowCache`,
            async () => {
                const db = new Database();
                const cache = new WowCache(dataFetcher, db);
                await cache.load();
                return cache;
            },
        );
        const renderHelper = new GfxRenderHelper(device);
        rust.init_panic_hook();
        const wdt = new WorldData(this.fileId, cache, this.lightdbMapId);
        console.time("loading wdt");
        await wdt.load(cache);
        console.timeEnd("loading wdt");
        return new WdtScene(device, wdt, renderHelper, cache.db);
    }
}

class ContinentSceneDesc implements Viewer.SceneDesc {
    public id: string;

    constructor(public name: string, public fileId: number, public startX: number, public startY: number, public lightdbMapId: number) {
        this.id = `${name}-${fileId}`;
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const dataFetcher = context.dataFetcher;
        const cache = await context.dataShare.ensureObject(
            `${vanillaSceneGroup.id}/WowCache`,
            async () => {
                const db = new Database();
                const cache = new WowCache(dataFetcher, db);
                await cache.load();
                return cache;
            },
        );
        const renderHelper = new GfxRenderHelper(device);
        rust.init_panic_hook();
        const wdt = new LazyWorldData(this.fileId, [this.startX, this.startY], cache, this.lightdbMapId);
        console.time("loading wdt");
        await wdt.load();
        console.timeEnd("loading wdt");
        const scene = new WdtScene(device, wdt, renderHelper, cache.db);
        scene.enableProgressiveLoading = true;
        return scene;
    }
}

const vanillaSceneDescs = [
    "Eastern Kingdoms",
    new ContinentSceneDesc("Ironforge, Dun Morogh", 775971, 33, 40, 0),
    new ContinentSceneDesc("Stormwind, Elwynn Forest", 775971, 31, 48, 0),
    new ContinentSceneDesc("Undercity, Tirisfal Glades", 775971, 31, 28, 0),
    new ContinentSceneDesc("Lakeshire, Redridge Mountains", 775971, 36, 49, 0),
    new ContinentSceneDesc("Blackrock Mountain, Burning Steppes", 775971, 34, 45, 0),
    new ContinentSceneDesc("Booty Bay, Stranglethorn Vale", 775971, 31, 58, 0),
    new ContinentSceneDesc("Light's Hope Chapel, Eastern Plaguelands", 775971, 41, 27, 0),
    new ContinentSceneDesc("Aerie Peak, Hinterlands", 775971, 35, 31, 0),
    new ContinentSceneDesc("Tarren Mill, Hillsbrad Foothills", 775971, 33, 32, 0),
    new ContinentSceneDesc("Stonewrought Dam, Loch Modan", 775971, 38, 40, 0),
    new ContinentSceneDesc("Kargath, Badlands", 775971, 36, 44, 0),
    new ContinentSceneDesc("Thorium Point, Searing Gorge", 775971, 34, 44, 0),
    new ContinentSceneDesc("Stonard, Swamp of Sorrows", 775971, 38, 51, 0),
    new ContinentSceneDesc("Nethergarde Keep, Blasted Lands", 775971, 38, 52, 0),
    new ContinentSceneDesc("The Dark Portal, Blasted Lands", 775971, 38, 54, 0),
    new ContinentSceneDesc("Darkshire, Duskwood", 775971, 34, 51, 0),
    new ContinentSceneDesc("Grom'gol Base Camp, Stranglethorn Vale", 775971, 31, 55, 0),
    new ContinentSceneDesc("Gurubashi Arena, Stranglethorn Vale", 775971, 31, 56, 0),
    new ContinentSceneDesc("Sentinel Hill, Westfall", 775971, 30, 51, 0),
    new ContinentSceneDesc("Karazhan, Deadwind Pass", 775971, 35, 52, 0),
    new ContinentSceneDesc("Southshore, Hillsbrad Foothills", 775971, 33, 33, 0),

    "Kalimdor",
    new ContinentSceneDesc("Thunder Bluff, Mulgore", 782779, 31, 34, 1),
    new ContinentSceneDesc("Darnassus, Teldrassil", 782779, 27, 13, 1),
    new ContinentSceneDesc("GM Island", 782779, 1, 1, 1),
    new ContinentSceneDesc("Archimonde's Bones, Hyjal", 782779, 38, 22, 1),
    new ContinentSceneDesc("Everlook, Winterspring", 782779, 40, 19, 1),
    new ContinentSceneDesc("Auberdine, Darkshore", 782779, 31, 19, 1),
    new ContinentSceneDesc("Astranaar, Ashenvale", 782779, 32, 26, 1),
    new ContinentSceneDesc("Mor'shan Rampart, Barrens", 782779, 36, 29, 1),
    new ContinentSceneDesc("Splintertree Post, Ashenvale", 782779, 36, 27, 1),
    new ContinentSceneDesc("Bloodvenom Post, Felwood", 782779, 32, 22, 1),
    new ContinentSceneDesc("Talonbranch Glade, Felwood", 782779, 34, 24, 1),
    new ContinentSceneDesc("The Crossroads, Barrens", 782779, 36, 32, 1),
    new ContinentSceneDesc("Orgrimmar, Durotar", 782779, 40, 29, 1),
    new ContinentSceneDesc("Ratchet, Barrens", 782779, 39, 33, 1),
    new ContinentSceneDesc("Sun Rock Retreat, Stonetalon Mountains", 782779, 30, 30, 1),
    new ContinentSceneDesc("Nijel's Point, Desolace", 782779, 29, 31, 1),
    new ContinentSceneDesc("Shadowprey Village, Desolace", 782779, 25, 35, 1),
    new ContinentSceneDesc("Dire Maul Arena, Feralas", 782779, 29, 38, 1),
    new ContinentSceneDesc("Thalanaar, Feralas", 782779, 33, 40, 1),
    new ContinentSceneDesc("Camp Mojache, Feralas", 782779, 31, 40, 1),
    new ContinentSceneDesc("Feathermoon Stronghold, Feralas", 782779, 25, 40, 1),
    new ContinentSceneDesc("Cenarion Hold, Silithus", 782779, 30, 44, 1),
    new ContinentSceneDesc("Marshal's Refuge, Un'Goro Crater", 782779, 34, 43, 1),
    new ContinentSceneDesc("Gadgetzan, Tanaris", 782779, 39, 45, 1),
    new ContinentSceneDesc("Mirage Raceway, Thousand Needles", 782779, 39, 43, 1),
    new ContinentSceneDesc("Freewind Post, Thousand Needles", 782779, 35, 41, 1),
    new ContinentSceneDesc("Theramore Isle, Dustwallow Marsh", 782779, 40, 39, 1),
    new ContinentSceneDesc("Alcaz Island, Dustwallow Marsh", 782779, 41, 37, 1),

    "Instances",
    new WdtSceneDesc("Zul-Farak", 791169, 209),
    new WdtSceneDesc("Blackrock Depths", 780172, 230),
    new WdtSceneDesc("Scholomance", 790713, 289),
    new WdtSceneDesc("Deeprun Tram", 780788, 369),
    new WdtSceneDesc("Deadmines", 780605, 36),
    new WdtSceneDesc("Shadowfang Keep", 790796, 33),
    new WdtSceneDesc("Blackrock Spire", 780175, 229),
    new WdtSceneDesc("Stratholme", 791063, 329),
    new WdtSceneDesc("Mauradon", 788656, 349),
    new WdtSceneDesc("Wailing Caverns", 791429, 43),
    new WdtSceneDesc("Razorfen Kraul", 790640, 47),
    new WdtSceneDesc("Razorfen Downs", 790517, 129),
    new WdtSceneDesc("Blackfathom Deeps", 780169, 48),
    new WdtSceneDesc("Uldaman", 791372, 70),
    new WdtSceneDesc("Gnomeregon", 782773, 90),
    new WdtSceneDesc("Sunken Temple", 791166, 109),
    new WdtSceneDesc("Scarlet Monastery - Graveyard", 788662, 189),
    new WdtSceneDesc("Scarlet Monastery - Cathedral", 788662, 189),
    new WdtSceneDesc("Scarlet Monastery - Library", 788662, 189),
    new WdtSceneDesc("Scarlet Monastery - Armory", 788662, 189),
    new WdtSceneDesc("Ragefire Chasm", 789981, 389),
    new WdtSceneDesc("Dire Maul", 780814, 429),

    "Raids",
    new WdtSceneDesc("Onyxia's Lair", 789922, 249),
    new WdtSceneDesc("Molten Core", 788659, 409),
    new WdtSceneDesc("Blackwing Lair", 780178, 469),
    new WdtSceneDesc("Zul'gurub", 791432, 309),
    new WdtSceneDesc("Naxxramas", 827115, 533),
    new WdtSceneDesc("Ahn'Qiraj Temple", 775840, 531),
    new WdtSceneDesc("Ruins of Ahn'qiraj", 775637, 509),

    "PvP",
    new WdtSceneDesc("Alterac Valley", 790112, 30), // AKA pvpzone01
    new WdtSceneDesc("Warsong Gulch", 790291, 489), // AKA pvpzone03
    new WdtSceneDesc("Arathi Basin", 790377, 529), // AKA pvpzone04

    "Unreleased",
    new WdtSceneDesc('PvP Zone 02 ("Azshara Crater")', 861092, 0),
    new WdtSceneDesc("Dragon Isles, Developer Island", 857684, 0),
    new WdtSceneDesc("Swamp of Sorrows Prototype, Developer Island", 857684, 0),
    new WdtSceneDesc("Water test, Developer Island", 857684, 0),
    new WdtSceneDesc("Verdant Fields, Emerald Dream", 780817, 0),
    new WdtSceneDesc("Emerald Forest, Emerald Dream", 780817, 0),
    new WdtSceneDesc("Untextured canyon, Emerald Dream", 780817, 0),
    new WdtSceneDesc("Test 01", 2323096, 0),
    new WdtSceneDesc("Scott Test", 863335, 0),
    new WdtSceneDesc("Collin Test", 863984, 0),
    new WdtSceneDesc("Scarlet Monastery Prototype", 865519, 189),
];

const bcSceneDescs = [
    "Outland",
    new ContinentSceneDesc("The Dark Portal, Hellfire Peninsula", 828395, 29, 32, 530),
    new ContinentSceneDesc("Cenarion Refuge, Zangarmarsh", 828395, 21, 32, 530),
    new ContinentSceneDesc("Area 52, Netherstorm", 828395, 25, 26, 530),
    new ContinentSceneDesc("Telaar, Nagrand", 828395, 18, 36, 530),
    new ContinentSceneDesc("Black Temple, Shadowmoon Valley", 828395, 30, 38, 530),
    new ContinentSceneDesc("Shattrath, Terokkar Forest", 828395, 22, 35, 530),

    "Quel'thalas",
    new ContinentSceneDesc("Silvermoon City, Eversong Woods", 828395, 45, 14, 530),
    new ContinentSceneDesc("Tranquillien, Ghostlands", 828395, 44, 17, 530),
    new ContinentSceneDesc("Sunspire, Sunstrider Isle", 828395, 43, 12, 530),

    "Azuremist Isles",
    new ContinentSceneDesc("Exodar, Azuremist Isles", 828395, 54, 39, 530),
    new ContinentSceneDesc("Ammen Vale, Azuremist Isles", 828395, 58, 39, 530),
    new ContinentSceneDesc("Blood Watch, Azuremist Isles", 828395, 54, 35, 530),

    "Instances",
    new WdtSceneDesc("Hellfire Citadel: The Shattered Halls", 831277, 540),
    new WdtSceneDesc("Hellfire Citadel: The Blood Furnace", 830642, 542),
    new WdtSceneDesc("Hellfire Citadel: Ramparts", 832154, 543),
    new WdtSceneDesc("Coilfang: The Steamvault", 828422, 545),
    new WdtSceneDesc("Coilfang: The Underbog", 831262, 546),
    new WdtSceneDesc("Coilfang: The Slave Pens", 830731, 547),
    new WdtSceneDesc("Caverns of Time: The Escape from Durnholde", 833998, 560),
    new WdtSceneDesc("Tempest Keep: The Arcatraz", 832070, 552),
    new WdtSceneDesc("Tempest Keep: The Botanica", 833950, 553),
    new WdtSceneDesc("Tempest Keep: The Mechanar", 831974, 554),
    new WdtSceneDesc("Auchindoun: Shadow Labyrinth", 828331, 555),
    new WdtSceneDesc("Auchindoun: Sethekk Halls", 828811, 556),
    new WdtSceneDesc("Auchindoun: Mana-Tombs", 830899, 557),
    new WdtSceneDesc("Auchindoun: Auchenai Crypts", 830415, 558),
    new WdtSceneDesc("The Sunwell: Magister's Terrace", 834223, 585),

    "Raids",
    new WdtSceneDesc("Tempest Keep", 832484, 550),
    new WdtSceneDesc("Karazhan", 834192, 532),
    new WdtSceneDesc("Caverns of Time: Hyjal", 831824, 534),
    new WdtSceneDesc("Black Temple", 829630, 565),
    new WdtSceneDesc("Gruul's Lair", 833180, 565),
    new WdtSceneDesc("Zul'Aman", 815727, 568),
    new WdtSceneDesc("The Sunwell: Plateau", 832953, 580),
    new WdtSceneDesc("Magtheridon's Lair", 833183, 544),
    new WdtSceneDesc("Coilfang: Serpentshrine Cavern", 829900, 548),

    "PvP",
    new WdtSceneDesc("Eye of the Storm", 788893, 566),
    new WdtSceneDesc("Arena: Nagrand", 790469, 559),
    new WdtSceneDesc("Arena: Blade's Edge", 780261, 562),
];

const wotlkSceneDescs = [
    "Northrend",
    new ContinentSceneDesc("Icecrown Citadel, Icecrown", 822688, 27, 20, 571),
    new ContinentSceneDesc("Dalaran, Crystalsong Forest", 822688, 31, 21, 571),
    new ContinentSceneDesc("Grizzlemaw, Grizzly Hills", 822688, 39, 24, 571),
    new ContinentSceneDesc("Gundrak, Zul'Drak", 822688, 40, 19, 571),
    new ContinentSceneDesc("River's Heart, Sholazar Basin", 822688, 22, 21, 571),
    new ContinentSceneDesc("Terrace of the Makers, The Storm Peaks", 822688, 34, 17, 571),
    new ContinentSceneDesc("The Nexus, Coldarra", 822688, 19, 25, 571),
    new ContinentSceneDesc("Ulduar, The Storm Peaks", 822688, 33, 15, 571),
    new ContinentSceneDesc("Utgarde Keep, Howling Fjord", 822688, 41, 30, 571),
    new ContinentSceneDesc("Valiance Keep, Borean Tundra", 822688, 21, 27, 571),
    new ContinentSceneDesc("Warsong Hold, Borean Tundra", 822688, 20, 27, 571),
    new ContinentSceneDesc("Wintergrasp Fortress, Wintergrasp", 822688, 26, 22, 571),
    new ContinentSceneDesc("Wyrmrest Temple, Dragonblight", 822688, 31, 24, 571),

    "Instances",
    new WdtSceneDesc("Ebon Hold", 818210, 609),
    new WdtSceneDesc("Utgarde Keep", 825743, 574),
    new WdtSceneDesc("Utgarde Pinnacle", 827661, 575),
    new WdtSceneDesc("Drak'Theron Keep", 820968, 600),
    new WdtSceneDesc("Violet Hold", 818205, 608),
    new WdtSceneDesc("Gundrak", 818626, 604),
    new WdtSceneDesc("Ahn'kahet: The Old Kingdom", 818056, 619),
    new WdtSceneDesc("Azjol'Nerub", 818693, 601),
    new WdtSceneDesc("Halls of Stone", 824642, 599),
    new WdtSceneDesc("Halls of Lightning", 824768, 602),
    new WdtSceneDesc("The Oculus", 819814, 578),
    new WdtSceneDesc("The Nexus", 821331, 576),
    new WdtSceneDesc("The Culling of Stratholme", 826005, 0), // map is actually 595
    new WdtSceneDesc("Trial of the Champion", 817987, 650),
    new WdtSceneDesc("The Forge of Souls", 818965, 632),
    new WdtSceneDesc("Pit of Saron", 827056, 0), // map id is actually 658
    new WdtSceneDesc("Halls of Reflection", 818690, 668),

    "Raids",
    new WdtSceneDesc("Icecrown Citadel", 820428, 0), // map id is actually 631
    new WdtSceneDesc("Ulduar", 825015, 603),
    new WdtSceneDesc("The Obsidian Sanctum", 820448, 615),
    // new WdtSceneDesc("The Ruby Sanctum", 821024, 724),
    new WdtSceneDesc("Vault of Archavon", 826589, 624),
    new WdtSceneDesc("Trial of the Crusader", 818173, 649),
    new WdtSceneDesc("The Eye of Eternity", 822560, 616),

    "PvP",
    new WdtSceneDesc("Strand of the Ancients", 789579, 607),
    new WdtSceneDesc("Isle of Conquest", 821811, 0), // map id is actually 628
    new WdtSceneDesc("Arena: Dalaran Sewers", 780309, 617),
    new WdtSceneDesc("Arena: The Ring of Valor", 789925, 618),
];

export const vanillaSceneGroup: Viewer.SceneGroup = {
    id: "WorldOfWarcraft",
    name: "World of Warcraft",
    sceneDescs: vanillaSceneDescs,
    hidden: false,
};

export const bcSceneGroup: Viewer.SceneGroup = {
    id: "WorldOfWarcraftBC",
    name: "World of Warcraft: The Burning Crusade",
    sceneDescs: bcSceneDescs,
};

export const wotlkSceneGroup: Viewer.SceneGroup = {
    id: "WorldOfWarcraftWOTLK",
    name: "World of Warcraft: Wrath of the Lich King",
    sceneDescs: wotlkSceneDescs,
};
