// Type declarations for xcode module
declare module 'xcode' {
  interface XcodeProject {
    parse(callback: (error: Error | null) => void): void;
    parseSync(): void;
    writeSync(): string;
    allUuids(): string[];
    generateUuid(): string;
    addPluginFile(path: string, opt?: any): any;
    removePluginFile(path: string, opt?: any): any;
    addProductFile(targetPath: string, opt?: any): any;
    removeProductFile(path: string, opt?: any): any;
    addSourceFile(path: string, opt?: any, group?: string): any;
    removeSourceFile(path: string, opt?: any, group?: string): any;
    addHeaderFile(path: string, opt?: any, group?: string): any;
    removeHeaderFile(path: string, opt?: any, group?: string): any;
    addResourceFile(path: string, opt?: any, group?: string): any;
    removeResourceFile(path: string, opt?: any, group?: string): any;
    addFramework(fpath: string, opt?: any): any;
    removeFramework(fpath: string, opt?: any): any;
    addCopyfile(file: any, opt?: any): any;
    pbxCopyfilesBuildPhaseObj(target: string): any;
    addToPbxCopyfilesBuildPhase(file: any): void;
    removeCopyfile(file: any, opt?: any): any;
    removeFromPbxCopyfilesBuildPhase(file: any): any;
    addStaticLibrary(path: string, opt?: any): any;
    removeStaticLibrary(path: string, opt?: any): any;
    addPbxGroup(groupKeyList: string[], groupName: string, path?: string): any;
    removePbxGroup(groupName: string): any;
    addLocalizationVariantGroup(name: string): any;
    addKnownRegion(name: string): void;
    removeKnownRegion(name: string): void;
    addTarget(name: string, type?: string, subfolder?: string): any;
    removeTarget(name: string): any;
    addBuildPhase(
      filePathsArray: string[],
      buildPhaseType: string,
      comment?: string,
      target?: string,
      folderType?: string,
      subfolderPath?: string
    ): any;
    removeBuildPhase(buildPhaseName: string, target?: string): any;
    addBuildProperty(prop: string, value: string, build_name?: string): void;
    removeBuildProperty(prop: string, build_name?: string): void;
    updateBuildProperty(prop: string, value: string, build_name?: string): void;
    updateProductName(name: string): void;
    addCapability(targetName: string, capabilityName: string): void;
    removeCapability(targetName: string, capabilityName: string): void;
    addTargetDependency(target: string, dependencyTargets: string[]): any;
    removeTargetDependency(target: string, dependencyTargets: string[]): any;
    addToLibrarySearchPaths(path: string): void;
    removeFromLibrarySearchPaths(path: string): void;
    addToFrameworkSearchPaths(path: string): void;
    removeFromFrameworkSearchPaths(path: string): void;
    addToHeaderSearchPaths(path: string): void;
    removeFromHeaderSearchPaths(path: string): void;
    addToOtherLinkerFlags(flag: string): void;
    removeFromOtherLinkerFlags(flag: string): void;
    addToBuildSettings(buildSetting: string, value: string): void;
    removeFromBuildSettings(buildSetting: string): void;
    // Common properties
    hash: any;
    filepath: string;
  }

  interface ProjectOptions {
    [key: string]: any;
  }

  function project(pbxprojPath: string): XcodeProject;

  export = {
    project,
  };
}
