export type {
    KeymaTargetConfig,
    KeymaUserConfig,
    ResolvedConfig,
    EmitFile,
    EmitResult,
    KeymaFrontend,
    KeymaBackend,
    DriveResult,
} from "./types.js";

export { loadConfig, resolveConfig } from "./config.js";
export { drive } from "./driver.js";
export { BackendRegistry } from "./backend-registry.js";
export { scanIntrinsicCompatibility } from "./intrinsic-scan.js";
export {
    RuntimeSymbolRegistry,
    defaultRuntimeSymbols,
    RecordLayoutRegistry,
    defaultRecordLayouts,
    recordLayout,
} from "./runtime-symbols.js";
export type { RuntimeSymbols, RuntimeSymbolLang, RecordLayout, RecordFieldCtor } from "./runtime-symbols.js";
export type {
    MetadataFieldIndex,
    MetadataIndex,
    MetadataFieldDescriptor,
    MetadataClassDescriptor,
    ClassMetadataOptions,
    MetadataRef,
    ClassDataOptions,
    BuildClassData,
} from "./class-metadata.js";
export type { KeymaDomain } from "./domain.js";
export type { IntrinsicDef } from "@keyma/core/ir";
